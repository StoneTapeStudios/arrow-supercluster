# arrow-supercluster

[![npm version](https://img.shields.io/npm/v/arrow-supercluster)](https://www.npmjs.com/package/arrow-supercluster)
[![npm downloads](https://img.shields.io/npm/dm/arrow-supercluster)](https://www.npmjs.com/package/arrow-supercluster)
[![bundle size](https://img.shields.io/bundlephobia/minzip/arrow-supercluster)](https://bundlephobia.com/package/arrow-supercluster)
[![license](https://img.shields.io/npm/l/arrow-supercluster)](https://github.com/StoneTapeStudios/arrow-supercluster/blob/main/LICENSE)

A spatial clustering engine for Apache Arrow tables. Reimplements the [Supercluster](https://github.com/mapbox/supercluster) algorithm to work directly with Arrow columnar memory — no GeoJSON serialization, no intermediate JS objects.

## Why

Supercluster expects GeoJSON in and produces GeoJSON out. If your data is already in Arrow format (e.g. loaded from GeoParquet), that means:

1. Iterating the Arrow table to build GeoJSON features
2. Supercluster internally converts those back to flat arrays
3. `getClusters()` builds new GeoJSON Feature objects on every call

This library skips all of that. It reads coordinate buffers directly from the Arrow geometry column and outputs typed arrays (`Float64Array`, `Uint32Array`, `Uint8Array`) ready for any rendering pipeline.

## Install

```bash
# pnpm
pnpm add arrow-supercluster apache-arrow

# npm
npm install arrow-supercluster apache-arrow

# yarn
yarn add arrow-supercluster apache-arrow
```

`apache-arrow` is a peer dependency — you control the version (>=14 supported).

## Usage

```ts
import { ArrowClusterEngine } from "arrow-supercluster";
import type { Table } from "apache-arrow";

// `table` is an Arrow Table with a GeoArrow Point geometry column
// (FixedSizeList[2] of Float64 — the standard encoding for point data)
const engine = new ArrowClusterEngine({
  radius: 75, // cluster radius in pixels (default: 40)
  maxZoom: 16, // max zoom level to cluster (default: 16)
  minZoom: 0, // min zoom level to cluster (default: 0)
  minPoints: 2, // minimum points to form a cluster (default: 2)
});

engine.load(table, "geometry");

// Query clusters for a bounding box and zoom level
const output = engine.getClusters([-180, -85, 180, 85], 4);

// output.positions   — Float64Array [lng0, lat0, lng1, lat1, ...]
// output.pointCounts — Uint32Array  [count0, count1, ...]
// output.ids         — Float64Array [id0, id1, ...]
// output.isCluster   — Uint8Array   [1, 0, 1, ...] (1 = cluster, 0 = point)
// output.length      — number
```

## API

### `new ArrowClusterEngine(options?)`

| Option      | Type     | Default | Description                              |
| ----------- | -------- | ------- | ---------------------------------------- |
| `radius`    | `number` | `40`    | Cluster radius in pixels                 |
| `extent`    | `number` | `512`   | Tile extent (radius is relative to this) |
| `minZoom`   | `number` | `0`     | Minimum zoom level for clustering        |
| `maxZoom`   | `number` | `16`    | Maximum zoom level for clustering        |
| `minPoints` | `number` | `2`     | Minimum points to form a cluster         |

### `engine.load(table, geometryColumn?, idColumn?, filterMask?)`

Index an Arrow `Table`. The geometry column must be GeoArrow Point encoding (`FixedSizeList[2]` of `Float64`). Single-chunk tables use a zero-copy fast path.

- `geometryColumn` — name of the geometry column (default: `"geometry"`)
- `idColumn` — reserved for future use. Currently ignored; point IDs are always Arrow row indices. (default: `"id"`)
- `filterMask` — optional `Uint8Array` of length `table.numRows`. When provided, only rows where `filterMask[i]` is non-zero are indexed. Rows with `0` are excluded from clustering entirely. Pass `null` or omit to include all rows.

### `engine.getClusters(bbox, zoom) → ClusterOutput`

Query clusters within a bounding box `[minLng, minLat, maxLng, maxLat]` at the given zoom level. Returns typed arrays — no object allocation per result.

The returned arrays are views into reusable internal buffers. They're valid until the next `getClusters()` call. Copy them if you need to retain the data.

### `engine.getChildren(clusterId) → ClusterOutput`

Get the immediate children of a cluster.

### `engine.getLeaves(clusterId, limit?, offset?) → number[]`

Get all leaf point indices for a cluster. Returns indices into the original Arrow table — use `table.get(index)` to materialize rows.

### `engine.getClusterExpansionZoom(clusterId) → number`

Get the zoom level at which a cluster expands into its children.

### `engine.getOriginZoom(clusterId) → number`

Decode the zoom level from an encoded cluster ID.

### `engine.getOriginId(clusterId) → number`

Decode the origin index from an encoded cluster ID.

## ClusterOutput

```ts
interface ClusterOutput {
  positions: Float64Array; // interleaved [lng, lat, lng, lat, ...]
  pointCounts: Uint32Array; // points per cluster (1 for individual points)
  ids: Float64Array; // cluster ID or Arrow row index
  isCluster: Uint8Array; // 1 = cluster, 0 = individual point
  length: number; // total items
}
```

## Performance

Benchmarked against Supercluster with the same datasets:

| Metric                        | 200k points  | 1M points    |
| ----------------------------- | ------------ | ------------ |
| Load time                     | ~1× (parity) | ~1× (parity) |
| Query time (avg)              | ~7.5× faster | ~8× faster   |
| Query time (mid-zoom peak)    | ~20× faster  | ~27× faster  |
| Wire size (Arrow IPC vs JSON) | 84% smaller  | 84% smaller  |

Query speedups come from returning pre-allocated typed arrays instead of GeoJSON Feature objects. The more clustering happening (low/mid zoom), the bigger the win.

## How It Works

Same algorithm as Supercluster (~400 lines), different I/O:

1. Reads `Float64Array` coordinate buffer directly from the Arrow geometry column
2. Converts lng/lat → Mercator, packs into flat arrays
3. Builds a KDBush spatial index per zoom level (top-down clustering)
4. `getClusters()` does a range query and writes results into reusable typed array buffers

For individual points at high zoom, coordinates are read directly from the original Arrow buffer — no inverse Mercator transform needed.

## License

ISC (same as [Supercluster](https://github.com/mapbox/supercluster))
