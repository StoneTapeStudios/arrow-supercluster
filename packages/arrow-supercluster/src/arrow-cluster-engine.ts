import KDBush from "kdbush";
import type { Table } from "apache-arrow";
import { getCoordBuffer } from "./arrow-helpers";
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

  // Reusable output buffers — allocated once during load(), reused per query
  private _bufPositions: Float64Array = new Float64Array(0);
  private _bufPointCounts: Uint32Array = new Uint32Array(0);
  private _bufIds: Float64Array = new Float64Array(0);
  private _bufIsCluster: Uint8Array = new Uint8Array(0);

  readonly radius: number;
  readonly extent: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly minPoints: number;

  constructor(options: ArrowClusterEngineOptions = {}) {
    this.radius = options.radius ?? 40;
    this.extent = options.extent ?? 512;
    this.minZoom = options.minZoom ?? 0;
    this.maxZoom = options.maxZoom ?? 16;
    this.minPoints = options.minPoints ?? 2;
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

    for (let z = this.maxZoom; z >= this.minZoom; z--) {
      const nextData = this._cluster(tree, this.treeData[z + 1], z);
      tree = this._createTree(nextData);
      this.trees[z] = tree;
      this.treeData[z] = nextData;
    }

    // Pre-allocate reusable output buffers sized to the max possible result count.
    // The highest zoom level (maxZoom+1) has the most items — one per input point.
    const maxItems = (this.treeData[this.maxZoom + 1].length / STRIDE) | 0;
    this._bufPositions = new Float64Array(maxItems * 2);
    this._bufPointCounts = new Uint32Array(maxItems);
    this._bufIds = new Float64Array(maxItems);
    this._bufIsCluster = new Uint8Array(maxItems);
  }

  /**
   * Get clusters and individual points for a bounding box at a given zoom level.
   */
  getClusters(
    bbox: [number, number, number, number],
    zoom: number,
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
      const eastern = this.getClusters([minLng, minLat, 180, maxLat], zoom);
      const western = this.getClusters([-180, minLat, maxLng, maxLat], zoom);
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

    const length = resultIds.length;

    // Write into pre-allocated buffers and return zero-copy subarray views.
    // Data is valid until the next getClusters() call.
    const positions = this._bufPositions;
    const pointCounts = this._bufPointCounts;
    const ids = this._bufIds;
    const isCluster = this._bufIsCluster;

    for (let i = 0; i < length; i++) {
      const k = resultIds[i] * STRIDE;
      const numPts = data[k + OFFSET_NUM];
      if (numPts > 1) {
        // Cluster: inverse-project mercator → lng/lat
        positions[i * 2] = xLng(data[k]);
        positions[i * 2 + 1] = yLat(data[k + 1]);
        isCluster[i] = 1;
      } else {
        // Individual point: read original lng/lat directly (no trig)
        const srcIdx = data[k + OFFSET_ID];
        positions[i * 2] = coords[srcIdx * 2];
        positions[i * 2 + 1] = coords[srcIdx * 2 + 1];
        isCluster[i] = 0;
      }
      pointCounts[i] = numPts;
      ids[i] = data[k + OFFSET_ID];
    }

    return {
      positions: positions.subarray(0, length * 2),
      pointCounts: pointCounts.subarray(0, length),
      ids: ids.subarray(0, length),
      isCluster: isCluster.subarray(0, length),
      length,
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
      ids[i] = data[k + OFFSET_ID];
    }

    return { positions, pointCounts, ids, isCluster, length };
  }

  /**
   * Get the Arrow row indices of all leaf points in a cluster.
   */
  getLeaves(clusterId: number, limit = Infinity, offset = 0): number[] {
    const indices: number[] = [];
    this._appendLeafIndices(indices, clusterId, limit, offset, 0);
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
          );
          if (result.length >= limit) return skipped;
        }
      } else {
        if (skipped < offset) {
          skipped++;
        } else {
          result.push(data[k + OFFSET_ID]);
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
      ids: new Float64Array(0),
      isCluster: new Uint8Array(0),
      length: 0,
    };
  }

  private _mergeOutputs(a: ClusterOutput, b: ClusterOutput): ClusterOutput {
    const length = a.length + b.length;
    const positions = new Float64Array(length * 2);
    const pointCounts = new Uint32Array(length);
    const ids = new Float64Array(length);
    const isCluster = new Uint8Array(length);

    positions.set(a.positions);
    positions.set(b.positions, a.length * 2);
    pointCounts.set(a.pointCounts);
    pointCounts.set(b.pointCounts, a.length);
    ids.set(a.ids);
    ids.set(b.ids, a.length);
    isCluster.set(a.isCluster);
    isCluster.set(b.isCluster, a.length);

    return { positions, pointCounts, ids, isCluster, length };
  }
}
