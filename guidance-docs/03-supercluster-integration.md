# arrow-supercluster — Arrow-Native Clustering Engine

> This document describes the `arrow-supercluster` package — the framework-agnostic clustering engine. It has no deck.gl dependency. For the deck.gl layer that consumes this engine, see `01-architecture.md` (Package 2).

## Why Not Wrap Supercluster?

Supercluster's public API is GeoJSON in, GeoJSON out. Wrapping it would mean:

1. Iterating the Arrow Table to build GeoJSON Feature[] (~40MB of JS objects for 200k points)
2. Supercluster internally converts those back to flat arrays
3. `getClusters()` builds new GeoJSON Feature[] on every zoom change
4. GeoJsonLayer parses those into ScatterplotLayer attributes

That's three unnecessary serialization/deserialization steps. The whole point of Arrow is to avoid this.

## What Supercluster Actually Does (The Algorithm)

Supercluster is ~400 lines. Here's the algorithm, stripped of GeoJSON I/O:

### 1. Load Phase

```
For each point:
  Convert lng/lat → Mercator x/y (via lngX, latY)
  Pack into flat array: [x, y, Infinity, pointIndex, -1, 1]
                         ↑  ↑  ↑zoom     ↑id       ↑parent ↑count

Build KDBush index on the x/y values
```

### 2. Cluster Phase (per zoom level, top-down from maxZoom to minZoom)

```
For each point/cluster at zoom+1:
  If already assigned to a cluster at this zoom, skip
  Mark as processed at this zoom
  Find all neighbors within radius r (KDBush.within)
  Count total points in neighborhood

  If total >= minPoints:
    Create cluster:
      Position = weighted centroid of all neighbors
      ID = encoded from (index << 5) + (zoom + 1) + numOriginalPoints
      Mark all neighbors as children of this cluster
    Push cluster to next level's data array

  Else:
    Push point/cluster unchanged to next level

Build new KDBush index for this zoom level
```

### 3. Query Phase

```
getClusters(bbox, zoom):
  Convert bbox lng/lat → Mercator x/y
  Range query on KDBush tree at this zoom
  For each result:
    If count > 1: it's a cluster → return cluster data
    If count == 1: it's an individual point → return point data
```

### 4. Hierarchy Navigation

```
getChildren(clusterId):
  Decode zoom level and origin index from clusterId
  Radius query at that zoom level
  Filter results where parent == clusterId

getLeaves(clusterId):
  Recursively walk children until reaching individual points

getClusterExpansionZoom(clusterId):
  Walk down zoom levels until cluster splits into multiple children
```

## Our Implementation: ArrowClusterEngine

Same algorithm, different I/O. Instead of GeoJSON features, we work with typed arrays throughout.

### Load

```ts
class ArrowClusterEngine {
  private trees: KDBush[];
  private data: Float64Array[]; // flat arrays per zoom level
  private stride = 6;
  private numPoints: number;
  private table: arrow.Table; // reference to source data

  load(table: arrow.Table, geometryColumn: string, idColumn: string) {
    this.table = table;
    this.numPoints = table.numRows;

    const geomCol = table.getChild(geometryColumn)!;
    const idCol = table.getChild(idColumn)!;

    // GeoArrow Point = FixedSizeList[2] of Float64
    // The underlying values buffer is already a Float64Array: [lng0, lat0, lng1, lat1, ...]
    // We can access it directly — zero copy from Arrow memory
    const coordValues = geomCol.data[0].children[0].values as Float64Array;

    const data: number[] = [];
    for (let i = 0; i < this.numPoints; i++) {
      const lng = coordValues[i * 2];
      const lat = coordValues[i * 2 + 1];

      // Skip rows with null/NaN geometry — don't corrupt the KDBush index
      if (
        lng === null ||
        lat === null ||
        Number.isNaN(lng) ||
        Number.isNaN(lat)
      ) {
        continue;
      }

      data.push(
        fround(lngX(lng)), // x (Mercator)
        fround(latY(lat)), // y (Mercator)
        Infinity, // zoom (unprocessed)
        i, // index into Arrow Table
        -1, // parent cluster ID
        1, // point count
      );
    }

    // Build KDBush index for maxZoom+1 (leaf level)
    let tree = this._createTree(data);
    this.trees[this.maxZoom + 1] = tree;

    // Cluster bottom-up
    for (let z = this.maxZoom; z >= this.minZoom; z--) {
      tree = this._createTree(this._cluster(tree, z));
      this.trees[z] = tree;
    }
  }
}
```

Note: `coordValues` is the raw `Float64Array` backing the Arrow geometry column. For a single-chunk table, this is a direct reference — no copy. For multi-chunk tables, we'd iterate chunks.

### getClusters — Returns Typed Arrays

Instead of building GeoJSON Feature objects, we return structured typed arrays:

```ts
interface ClusterOutput {
  /** Cluster/point positions in lng/lat. Float64Array of [lng0, lat0, lng1, lat1, ...] */
  positions: Float64Array;
  /** Point count per cluster (1 for individual points) */
  pointCounts: Uint32Array;
  /** Cluster IDs (or Arrow row index for individual points) */
  ids: Float64Array;
  /** Whether each entry is a cluster (true) or individual point (false) */
  isCluster: Uint8Array;
  /** Total number of clusters/points */
  length: number;
}

getClusters(bbox: [number, number, number, number], zoom: number): ClusterOutput {
  // Clamp bbox to Mercator limits — at low zoom, viewport can span the whole world
  const minLng = Math.max(bbox[0], -180);
  const minLat = Math.max(bbox[1], -85.051129);
  const maxLng = Math.min(bbox[2], 180);
  const maxLat = Math.min(bbox[3], 85.051129);

  const tree = this.trees[this._limitZoom(zoom)];
  const indices = tree.range(lngX(minLng), latY(maxLat), lngX(maxLng), latY(minLat));

  const length = indices.length;
  const positions = new Float64Array(length * 2);
  const pointCounts = new Uint32Array(length);
  const ids = new Float64Array(length);
  const isCluster = new Uint8Array(length);

  for (let i = 0; i < length; i++) {
    const k = indices[i] * this.stride;
    const data = tree.data;

    // Convert Mercator back to lng/lat
    positions[i * 2] = xLng(data[k]);
    positions[i * 2 + 1] = yLat(data[k + 1]);
    pointCounts[i] = data[k + OFFSET_NUM];
    ids[i] = data[k + OFFSET_ID];
    isCluster[i] = data[k + OFFSET_NUM] > 1 ? 1 : 0;
  }

  return { positions, pointCounts, ids, isCluster, length };
}
```

### getLeaves — Returns Arrow Row Indices

```ts
getLeaves(clusterId: number, limit = Infinity): number[] {
  // Same recursive algorithm as Supercluster._appendLeaves
  // But instead of returning GeoJSON features, returns Arrow Table row indices
  // (the original `id` stored in the flat array IS the Arrow row index)
  const indices: number[] = [];
  this._appendLeafIndices(indices, clusterId, limit, 0, 0);
  return indices;
}
```

The consumer (`arrow-cluster-layer`'s picking resolver, or scu-atlas directly) can then do `table.get(index)` to get full row data when needed (e.g., on click for a detail panel).

## Coordinate Access Patterns

### Single-Chunk Arrow Table (Common Case)

When the Arrow Table has a single chunk (typical for a file loaded all at once), the geometry column's coordinate values are a single contiguous `Float64Array`:

```ts
const coordBuffer = geomCol.data[0].children[0].values; // Float64Array
// coordBuffer[i*2] = longitude of point i
// coordBuffer[i*2+1] = latitude of point i
```

This is essentially zero-copy access to the Arrow memory.

### Multi-Chunk Arrow Table

For streaming/chunked loading, we'd need to handle multiple chunks:

```ts
for (const chunk of geomCol.data) {
  const coords = chunk.children[0].values as Float64Array;
  // process this chunk's coordinates
}
```

Phase 1 will assume single-chunk. Multi-chunk support is a straightforward extension.

## Complexity Analysis

Same as Supercluster (because it IS the same algorithm):

- `load()`: O(n log n) — dominated by KDBush construction
- `getClusters()`: O(k + √n) where k = number of visible clusters — KDBush range query is O(√n + k), not O(k) alone, because the tree traversal itself costs O(√n) even if k is small
- `getChildren()`: O(√n) — KDBush radius query
- `getLeaves()`: O(m) where m = number of leaves

For 200k points: `load()` takes ~100-200ms, `getClusters()` takes <10ms per zoom change.
