import KDBush from "kdbush";
import type { Table } from "apache-arrow";
import { getCoordBuffer, getScalarNumberBuffer } from "./arrow-helpers";
import { lngX, latY, xLng, yLat, fround } from "./mercator";
import type { ClusterOutput, ArrowClusterEngineOptions } from "./types";

// Offsets into the flat data array (stride = 6)
const OFFSET_ZOOM = 2;
const OFFSET_ID = 3;
const OFFSET_PARENT = 4;
const OFFSET_NUM = 5;
const STRIDE = 6;

/**
 * Arrow-native spatial clustering engine.
 *
 * Reimplements Supercluster's algorithm to work directly with Apache Arrow
 * typed array buffers. No GeoJSON, no rendering opinion.
 */
export class ArrowClusterEngine {
  private trees: KDBush[] = [];
  private treeData: number[][] = [];
  private numPoints = 0;

  // Original lng/lat coordinates from Arrow, used for zero-cost lookups
  // of individual (unclustered) points at query time.
  private coordValues: Float64Array | null = null;

  // --- Range filtering fields ---
  // Per Arrow row — the range column's numeric value. Excluded rows carry the sentinel.
  private rangeValues: Float64Array | null = null;
  private excludedSentinel = Number.POSITIVE_INFINITY;

  // Global domain over non-sentinel values (used by histogram binning in Step 2)
  private rangeMin = 0;
  private rangeMax = 0;

  // Per level z, indexed by node position (i / STRIDE):
  private nodeMinVal: Float64Array[] = [];
  private nodeMaxVal: Float64Array[] = [];
  private nodeRangedCount: Uint32Array[] = [];

  // Reusable output buffers — allocated once during load(), reused per query
  private _bufPositions: Float64Array = new Float64Array(0);
  private _bufPointCounts: Uint32Array = new Uint32Array(0);
  private _bufFilteredPointCounts: Uint32Array = new Uint32Array(0);
  private _bufIds: Float64Array = new Float64Array(0);
  private _bufIsCluster: Uint8Array = new Uint8Array(0);

  readonly radius: number;
  readonly extent: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly minPoints: number;
  readonly histogramBins: number;
  readonly histogramThreshold: number;
  readonly excludedValue: number | undefined;

  constructor(options: ArrowClusterEngineOptions = {}) {
    this.radius = options.radius ?? 40;
    this.extent = options.extent ?? 512;
    this.minZoom = options.minZoom ?? 0;
    this.maxZoom = options.maxZoom ?? 16;
    this.minPoints = options.minPoints ?? 2;
    this.histogramBins = options.histogramBins ?? 256;
    this.histogramThreshold = options.histogramThreshold ?? 256;
    this.excludedValue = options.excludedValue;
  }

  /** Number of points actually indexed (after filterMask + null-geometry exclusion). */
  get indexedPointCount(): number {
    const topData = this.treeData[this.maxZoom + 1];
    return topData ? (topData.length / STRIDE) | 0 : 0;
  }

  /**
   * Load an Arrow Table and build the spatial index.
   */
  load(
    table: Table,
    geometryColumn = "geometry",
    _idColumn = "id",
    filterMask?: Uint8Array | null,
    rangeColumn?: string | null,
  ): void {
    this.numPoints = table.numRows;

    const geomCol = table.getChild(geometryColumn);
    if (!geomCol) {
      throw new Error(
        `Geometry column "${geometryColumn}" not found in Arrow Table`,
      );
    }

    const coordValues = getCoordBuffer({ geomCol });
    this.coordValues = coordValues;

    // --- Range column extraction ---
    this.rangeValues = null;
    this.rangeMin = 0;
    this.rangeMax = 0;
    this.nodeMinVal = [];
    this.nodeMaxVal = [];
    this.nodeRangedCount = [];

    if (rangeColumn) {
      const rangeCol = table.getChild(rangeColumn);
      if (!rangeCol) {
        throw new Error(
          `Range column "${rangeColumn}" not found in Arrow Table`,
        );
      }
      this.rangeValues = getScalarNumberBuffer(
        rangeCol,
        table.numRows,
        this.excludedSentinel,
        this.excludedValue,
      );

      // Compute global domain over non-sentinel values
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < this.rangeValues.length; i++) {
        const v = this.rangeValues[i];
        if (v !== this.excludedSentinel) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      this.rangeMin = min === Number.POSITIVE_INFINITY ? 0 : min;
      this.rangeMax = max === Number.NEGATIVE_INFINITY ? 0 : max;
    }

    // Build the initial flat data array from Arrow coordinates
    const data: number[] = [];
    for (let i = 0; i < this.numPoints; i++) {
      if (filterMask && !filterMask[i]) continue;

      const lng = coordValues[i * 2];
      const lat = coordValues[i * 2 + 1];

      if (
        lng === null ||
        lat === null ||
        Number.isNaN(lng) ||
        Number.isNaN(lat)
      ) {
        continue;
      }

      data.push(
        fround(lngX(lng)),
        fround(latY(lat)),
        Infinity, // last zoom processed at
        i, // source feature index (Arrow row index)
        -1, // parent cluster id
        1, // point count
      );
    }

    let tree = this._createTree(data);
    this.trees[this.maxZoom + 1] = tree;
    this.treeData[this.maxZoom + 1] = data;

    // Build range aggregates for the leaf level (maxZoom+1) if range column present
    if (this.rangeValues) {
      const numNodes = (data.length / STRIDE) | 0;
      const minArr = new Float64Array(numNodes).fill(Number.POSITIVE_INFINITY);
      const maxArr = new Float64Array(numNodes).fill(Number.NEGATIVE_INFINITY);
      const countArr = new Uint32Array(numNodes);

      for (let pos = 0; pos < numNodes; pos++) {
        const srcIdx = data[pos * STRIDE + OFFSET_ID];
        const v = this.rangeValues[srcIdx];
        if (v !== this.excludedSentinel) {
          minArr[pos] = v;
          maxArr[pos] = v;
          countArr[pos] = 1;
        }
      }

      this.nodeMinVal[this.maxZoom + 1] = minArr;
      this.nodeMaxVal[this.maxZoom + 1] = maxArr;
      this.nodeRangedCount[this.maxZoom + 1] = countArr;
    }

    for (let z = this.maxZoom; z >= this.minZoom; z--) {
      const nextData = this._cluster(tree, this.treeData[z + 1], z);
      tree = this._createTree(nextData);
      this.trees[z] = tree;
      this.treeData[z] = nextData;

      // Build range aggregates for this level
      if (this.rangeValues) {
        this._buildRangeAggregates(z, nextData);
      }
    }

    // Pre-allocate reusable output buffers sized to the max possible result count.
    // The highest zoom level (maxZoom+1) has the most items — one per input point.
    const maxItems = (this.treeData[this.maxZoom + 1].length / STRIDE) | 0;
    this._bufPositions = new Float64Array(maxItems * 2);
    this._bufPointCounts = new Uint32Array(maxItems);
    this._bufFilteredPointCounts = new Uint32Array(maxItems);
    this._bufIds = new Float64Array(maxItems);
    this._bufIsCluster = new Uint8Array(maxItems);
  }

  /**
   * Get clusters and individual points for a bounding box at a given zoom level.
   *
   * @param filterRange Optional inclusive [min, max] range filter. When provided,
   *   nodes whose filtered count is 0 are omitted from the output.
   */
  getClusters(
    bbox: [number, number, number, number],
    zoom: number,
    filterRange?: [number, number] | null,
  ): ClusterOutput {
    let minLng = ((((bbox[0] + 180) % 360) + 360) % 360) - 180;
    const minLat = Math.max(-90, Math.min(90, bbox[1]));
    let maxLng =
      bbox[2] === 180 ? 180 : ((((bbox[2] + 180) % 360) + 360) % 360) - 180;
    const maxLat = Math.max(-90, Math.min(90, bbox[3]));

    if (bbox[2] - bbox[0] >= 360) {
      minLng = -180;
      maxLng = 180;
    } else if (minLng > maxLng) {
      const eastern = this.getClusters(
        [minLng, minLat, 180, maxLat],
        zoom,
        filterRange,
      );
      const western = this.getClusters(
        [-180, minLat, maxLng, maxLat],
        zoom,
        filterRange,
      );
      return this._mergeOutputs(eastern, western);
    }

    const z = this._limitZoom(zoom);
    const tree = this.trees[z];
    const data = this.treeData[z];
    if (!tree || !data) return this._emptyOutput();
    const coords = this.coordValues!;

    const resultIds = tree.range(
      lngX(minLng),
      latY(maxLat),
      lngX(maxLng),
      latY(minLat),
    );

    // Write into pre-allocated buffers and return zero-copy subarray views.
    // Data is valid until the next getClusters() call.
    const positions = this._bufPositions;
    const pointCounts = this._bufPointCounts;
    const filteredPointCounts = this._bufFilteredPointCounts;
    const ids = this._bufIds;
    const isCluster = this._bufIsCluster;

    const hasRange = filterRange != null && this.rangeValues != null;

    let out = 0; // write cursor (may skip nodes when filtering)

    for (let i = 0; i < resultIds.length; i++) {
      const nodePos = resultIds[i];
      const k = nodePos * STRIDE;
      const numPts = data[k + OFFSET_NUM];

      let filteredCount: number;

      if (hasRange) {
        filteredCount = this._getFilteredCount(z, nodePos, data, filterRange!);
        if (filteredCount === 0) continue; // omit fully-outside nodes
      } else {
        filteredCount = numPts;
      }

      if (numPts > 1) {
        // Cluster: inverse-project mercator → lng/lat
        positions[out * 2] = xLng(data[k]);
        positions[out * 2 + 1] = yLat(data[k + 1]);
        isCluster[out] = 1;
      } else {
        // Individual point: read original lng/lat directly (no trig)
        const srcIdx = data[k + OFFSET_ID];
        positions[out * 2] = coords[srcIdx * 2];
        positions[out * 2 + 1] = coords[srcIdx * 2 + 1];
        isCluster[out] = 0;
      }
      pointCounts[out] = numPts;
      filteredPointCounts[out] = filteredCount;
      ids[out] = data[k + OFFSET_ID];
      out++;
    }

    return {
      positions: positions.subarray(0, out * 2),
      pointCounts: pointCounts.subarray(0, out),
      filteredPointCounts: filteredPointCounts.subarray(0, out),
      ids: ids.subarray(0, out),
      isCluster: isCluster.subarray(0, out),
      length: out,
    };
  }

  /**
   * Get the immediate children of a cluster.
   */
  getChildren(clusterId: number): ClusterOutput {
    const { indices, data } = this._getChildIndices(clusterId);
    const length = indices.length;
    if (length === 0) return this._emptyOutput();

    const positions = new Float64Array(length * 2);
    const pointCounts = new Uint32Array(length);
    const filteredPointCounts = new Uint32Array(length);
    const ids = new Float64Array(length);
    const isCluster = new Uint8Array(length);

    for (let i = 0; i < length; i++) {
      const k = indices[i] * STRIDE;
      const numPts = data[k + OFFSET_NUM];
      if (numPts > 1) {
        positions[i * 2] = xLng(data[k]);
        positions[i * 2 + 1] = yLat(data[k + 1]);
        isCluster[i] = 1;
      } else {
        const srcIdx = data[k + OFFSET_ID];
        positions[i * 2] = this.coordValues![srcIdx * 2];
        positions[i * 2 + 1] = this.coordValues![srcIdx * 2 + 1];
        isCluster[i] = 0;
      }
      pointCounts[i] = numPts;
      filteredPointCounts[i] = numPts; // no range applied in getChildren
      ids[i] = data[k + OFFSET_ID];
    }

    return {
      positions,
      pointCounts,
      filteredPointCounts,
      ids,
      isCluster,
      length,
    };
  }

  /**
   * Get the Arrow row indices of all leaf points in a cluster.
   *
   * @param filterRange Optional inclusive [min, max] range filter. When provided,
   *   only leaves whose range value falls within the range are returned.
   */
  getLeaves(
    clusterId: number,
    limit = Infinity,
    offset = 0,
    filterRange?: [number, number] | null,
  ): number[] {
    const indices: number[] = [];
    this._appendLeafIndices(indices, clusterId, limit, offset, 0, filterRange);
    return indices;
  }

  /**
   * Get the zoom level at which a cluster expands into its children.
   */
  getClusterExpansionZoom(clusterId: number): number {
    let expansionZoom = this._getOriginZoom(clusterId) - 1;

    while (expansionZoom <= this.maxZoom) {
      const { indices, data } = this._getChildIndices(clusterId);
      expansionZoom++;
      if (indices.length !== 1) break;
      const k = indices[0] * STRIDE;
      if (data[k + OFFSET_NUM] > 1) {
        clusterId = data[k + OFFSET_ID];
      } else {
        break;
      }
    }

    return expansionZoom;
  }

  /** Decode the zoom level from a cluster ID. */
  getOriginZoom(clusterId: number): number {
    return this._getOriginZoom(clusterId);
  }

  /** Decode the origin index from a cluster ID. */
  getOriginId(clusterId: number): number {
    return this._getOriginId(clusterId);
  }

  // --- Private methods ---

  /**
   * Get the filtered count for a node at level z, given a filterRange.
   * Uses the tiered approach: direct check for singletons, min/max fast paths
   * for clusters, and leaf-walk for partial overlap.
   */
  private _getFilteredCount(
    z: number,
    nodePos: number,
    data: number[],
    filterRange: [number, number],
  ): number {
    const k = nodePos * STRIDE;
    const numPts = data[k + OFFSET_NUM];

    if (numPts === 1) {
      // Individual point — direct value check
      const srcIdx = data[k + OFFSET_ID];
      const v = this.rangeValues![srcIdx];
      if (v === this.excludedSentinel) return 0;
      return v >= filterRange[0] && v <= filterRange[1] ? 1 : 0;
    }

    // Cluster — check min/max bounds
    const minVal = this.nodeMinVal[z]?.[nodePos];
    const maxVal = this.nodeMaxVal[z]?.[nodePos];
    const rangedCount = this.nodeRangedCount[z]?.[nodePos];

    // If no ranged values in this cluster, it's fully excluded
    if (rangedCount === 0 || rangedCount === undefined) return 0;

    // Fully outside
    if (maxVal < filterRange[0] || minVal > filterRange[1]) return 0;

    // Fully inside
    if (filterRange[0] <= minVal && maxVal <= filterRange[1]) {
      return rangedCount;
    }

    // Partial overlap — leaf-walk to count
    return this._countLeavesInRange(data[k + OFFSET_ID], filterRange);
  }

  /**
   * Count leaves in a cluster that fall within the given range.
   * Recursive traversal reusing the _getChildIndices mechanism.
   */
  private _countLeavesInRange(
    clusterId: number,
    filterRange: [number, number],
  ): number {
    const { indices, data } = this._getChildIndices(clusterId);
    let count = 0;

    for (let i = 0; i < indices.length; i++) {
      const k = indices[i] * STRIDE;
      const numPts = data[k + OFFSET_NUM];

      if (numPts > 1) {
        // Sub-cluster — check if we can short-circuit with its aggregates
        const childClusterId = data[k + OFFSET_ID];
        const childZoom = this._getOriginZoom(childClusterId);
        const childPos = this._getOriginId(childClusterId);
        const childMin = this.nodeMinVal[childZoom]?.[childPos];
        const childMax = this.nodeMaxVal[childZoom]?.[childPos];
        const childRangedCount = this.nodeRangedCount[childZoom]?.[childPos];

        if (
          childRangedCount === 0 ||
          childRangedCount === undefined ||
          childMax < filterRange[0] ||
          childMin > filterRange[1]
        ) {
          // Fully outside — skip
          continue;
        }

        if (filterRange[0] <= childMin && childMax <= filterRange[1]) {
          // Fully inside
          count += childRangedCount;
        } else {
          // Partial — recurse
          count += this._countLeavesInRange(childClusterId, filterRange);
        }
      } else {
        // Leaf point
        const srcIdx = data[k + OFFSET_ID];
        const v = this.rangeValues![srcIdx];
        if (
          v !== this.excludedSentinel &&
          v >= filterRange[0] &&
          v <= filterRange[1]
        ) {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Build per-node range aggregates for a given level after clustering.
   * Each node gets min, max, and rangedCount based on its children's values.
   */
  private _buildRangeAggregates(z: number, levelData: number[]): void {
    const numNodes = (levelData.length / STRIDE) | 0;
    const minArr = new Float64Array(numNodes).fill(Number.POSITIVE_INFINITY);
    const maxArr = new Float64Array(numNodes).fill(Number.NEGATIVE_INFINITY);
    const countArr = new Uint32Array(numNodes);

    for (let pos = 0; pos < numNodes; pos++) {
      const k = pos * STRIDE;
      const numPts = levelData[k + OFFSET_NUM];

      if (numPts === 1) {
        // Individual point — look up value directly
        const srcIdx = levelData[k + OFFSET_ID];
        const v = this.rangeValues![srcIdx];
        if (v !== this.excludedSentinel) {
          minArr[pos] = v;
          maxArr[pos] = v;
          countArr[pos] = 1;
        }
      } else {
        // Cluster — we need to aggregate from children.
        // Use _getChildIndices to find children and fold their aggregates.
        const clusterId = levelData[k + OFFSET_ID];
        this._foldChildAggregates(clusterId, pos, minArr, maxArr, countArr);
      }
    }

    this.nodeMinVal[z] = minArr;
    this.nodeMaxVal[z] = maxArr;
    this.nodeRangedCount[z] = countArr;
  }

  /**
   * Fold child node aggregates into the parent cluster at `parentPos`.
   */
  private _foldChildAggregates(
    clusterId: number,
    parentPos: number,
    minArr: Float64Array,
    maxArr: Float64Array,
    countArr: Uint32Array,
  ): void {
    const originZoom = this._getOriginZoom(clusterId);
    const childLevelData = this.treeData[originZoom];
    const childTree = this.trees[originZoom];
    if (!childTree || !childLevelData) return;

    const originId = this._getOriginId(clusterId);
    if (originId * STRIDE >= childLevelData.length) return;

    const r = this.radius / (this.extent * Math.pow(2, originZoom - 1));
    const x = childLevelData[originId * STRIDE];
    const y = childLevelData[originId * STRIDE + 1];
    const neighborIds = childTree.within(x, y, r);

    const childMinArr = this.nodeMinVal[originZoom];
    const childMaxArr = this.nodeMaxVal[originZoom];
    const childCountArr = this.nodeRangedCount[originZoom];

    for (const nid of neighborIds) {
      const nk = nid * STRIDE;
      if (childLevelData[nk + OFFSET_PARENT] !== clusterId) continue;

      if (childMinArr && childMaxArr && childCountArr) {
        const cMin = childMinArr[nid];
        const cMax = childMaxArr[nid];
        const cCount = childCountArr[nid];

        if (cCount > 0) {
          if (cMin < minArr[parentPos]) minArr[parentPos] = cMin;
          if (cMax > maxArr[parentPos]) maxArr[parentPos] = cMax;
          countArr[parentPos] += cCount;
        }
      }
    }
  }

  /**
   * Internal: find the treeData indices of a cluster's children.
   * Returns raw indices into the data array — no typed array allocation.
   * Used by getChildren(), getClusterExpansionZoom(), and _appendLeafIndices().
   */
  private _getChildIndices(clusterId: number): {
    indices: number[];
    data: number[];
  } {
    const originId = this._getOriginId(clusterId);
    const originZoom = this._getOriginZoom(clusterId);
    const emptyResult = { indices: [], data: [] };

    const tree = this.trees[originZoom];
    const data = this.treeData[originZoom];
    if (!tree || !data) return emptyResult;
    if (originId * STRIDE >= data.length) return emptyResult;

    const r = this.radius / (this.extent * Math.pow(2, originZoom - 1));
    const x = data[originId * STRIDE];
    const y = data[originId * STRIDE + 1];
    const neighborIds = tree.within(x, y, r);

    const indices: number[] = [];
    for (const nid of neighborIds) {
      const k = nid * STRIDE;
      if (data[k + OFFSET_PARENT] === clusterId) {
        indices.push(nid);
      }
    }

    return { indices, data };
  }

  private _getOriginZoom(clusterId: number): number {
    return (clusterId - this.numPoints) % 32;
  }

  private _getOriginId(clusterId: number): number {
    return (clusterId - this.numPoints) >> 5;
  }

  private _appendLeafIndices(
    result: number[],
    clusterId: number,
    limit: number,
    offset: number,
    skipped: number,
    filterRange?: [number, number] | null,
  ): number {
    const { indices, data } = this._getChildIndices(clusterId);

    for (let i = 0; i < indices.length; i++) {
      const k = indices[i] * STRIDE;
      const numPts = data[k + OFFSET_NUM];
      if (numPts > 1) {
        if (skipped + numPts <= offset) {
          skipped += numPts;
        } else {
          skipped = this._appendLeafIndices(
            result,
            data[k + OFFSET_ID],
            limit,
            offset,
            skipped,
            filterRange,
          );
          if (result.length >= limit) return skipped;
        }
      } else {
        if (skipped < offset) {
          skipped++;
        } else {
          const srcIdx = data[k + OFFSET_ID];
          // Apply range filter if active
          if (filterRange && this.rangeValues) {
            const v = this.rangeValues[srcIdx];
            if (
              v === this.excludedSentinel ||
              v < filterRange[0] ||
              v > filterRange[1]
            ) {
              continue;
            }
          }
          result.push(srcIdx);
          if (result.length >= limit) return skipped;
        }
      }
    }

    return skipped;
  }

  /**
   * Cluster points at a given zoom level.
   * Matches Supercluster._cluster() exactly.
   */
  private _cluster(tree: KDBush, data: number[], zoom: number): number[] {
    const r = this.radius / (this.extent * Math.pow(2, zoom));
    const nextData: number[] = [];

    for (let i = 0; i < data.length; i += STRIDE) {
      if (data[i + OFFSET_ZOOM] <= zoom) continue;
      data[i + OFFSET_ZOOM] = zoom;

      const x = data[i];
      const y = data[i + 1];
      const neighborIds = tree.within(x, y, r);

      const numPointsOrigin = data[i + OFFSET_NUM];
      let numPoints = numPointsOrigin;

      for (const neighborId of neighborIds) {
        const k = neighborId * STRIDE;
        if (data[k + OFFSET_ZOOM] > zoom) numPoints += data[k + OFFSET_NUM];
      }

      if (numPoints > numPointsOrigin && numPoints >= this.minPoints) {
        let wx = x * numPointsOrigin;
        let wy = y * numPointsOrigin;

        const id = (((i / STRIDE) | 0) << 5) + (zoom + 1) + this.numPoints;

        for (const neighborId of neighborIds) {
          const k = neighborId * STRIDE;
          if (data[k + OFFSET_ZOOM] <= zoom) continue;
          data[k + OFFSET_ZOOM] = zoom;

          const numPoints2 = data[k + OFFSET_NUM];
          wx += data[k] * numPoints2;
          wy += data[k + 1] * numPoints2;

          data[k + OFFSET_PARENT] = id;
        }

        data[i + OFFSET_PARENT] = id;
        nextData.push(
          wx / numPoints,
          wy / numPoints,
          Infinity,
          id,
          -1,
          numPoints,
        );
      } else {
        for (let j = 0; j < STRIDE; j++) nextData.push(data[i + j]);

        if (numPoints > 1) {
          for (const neighborId of neighborIds) {
            const k = neighborId * STRIDE;
            if (data[k + OFFSET_ZOOM] <= zoom) continue;
            data[k + OFFSET_ZOOM] = zoom;
            for (let j = 0; j < STRIDE; j++) nextData.push(data[k + j]);
          }
        }
      }
    }

    return nextData;
  }

  private _createTree(data: number[]): KDBush {
    const numItems = (data.length / STRIDE) | 0;
    const tree = new KDBush(numItems, 64, Float32Array);
    for (let i = 0; i < data.length; i += STRIDE) {
      tree.add(data[i], data[i + 1]);
    }
    tree.finish();
    return tree;
  }

  private _limitZoom(zoom: number): number {
    return Math.max(
      this.minZoom,
      Math.min(Math.floor(+zoom), this.maxZoom + 1),
    );
  }

  private _emptyOutput(): ClusterOutput {
    return {
      positions: new Float64Array(0),
      pointCounts: new Uint32Array(0),
      filteredPointCounts: new Uint32Array(0),
      ids: new Float64Array(0),
      isCluster: new Uint8Array(0),
      length: 0,
    };
  }

  private _mergeOutputs(a: ClusterOutput, b: ClusterOutput): ClusterOutput {
    const length = a.length + b.length;
    const positions = new Float64Array(length * 2);
    const pointCounts = new Uint32Array(length);
    const filteredPointCounts = new Uint32Array(length);
    const ids = new Float64Array(length);
    const isCluster = new Uint8Array(length);

    positions.set(a.positions);
    positions.set(b.positions, a.length * 2);
    pointCounts.set(a.pointCounts);
    pointCounts.set(b.pointCounts, a.length);
    filteredPointCounts.set(a.filteredPointCounts);
    filteredPointCounts.set(b.filteredPointCounts, a.length);
    ids.set(a.ids);
    ids.set(b.ids, a.length);
    isCluster.set(a.isCluster);
    isCluster.set(b.isCluster, a.length);

    return {
      positions,
      pointCounts,
      filteredPointCounts,
      ids,
      isCluster,
      length,
    };
  }
}
