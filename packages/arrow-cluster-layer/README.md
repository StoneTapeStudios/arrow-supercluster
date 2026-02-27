# arrow-cluster-layer

[![npm version](https://img.shields.io/npm/v/arrow-cluster-layer)](https://www.npmjs.com/package/arrow-cluster-layer)
[![npm downloads](https://img.shields.io/npm/dm/arrow-cluster-layer)](https://www.npmjs.com/package/arrow-cluster-layer)
[![bundle size](https://img.shields.io/bundlephobia/minzip/arrow-cluster-layer)](https://bundlephobia.com/package/arrow-cluster-layer)
[![license](https://img.shields.io/npm/l/arrow-cluster-layer)](https://github.com/StoneTapeStudios/arrow-supercluster/blob/main/LICENSE)

A [deck.gl](https://deck.gl) `CompositeLayer` for rendering clustered point data from Apache Arrow tables. Built on top of [arrow-supercluster](https://www.npmjs.com/package/arrow-supercluster).

**[Live Demo](https://arrow-cluster-layer-demo.jonathanstombaugh.workers.dev)** — cluster 200K / 1M / 2M points from GeoParquet in the browser.

## Why

Replaces the typical GeoJSON → Supercluster → GeoJsonLayer pipeline with Arrow Table → ArrowClusterEngine → binary ScatterplotLayer. No intermediate JS objects, no GeoJSON serialization. Typed arrays go straight to the GPU.

## Install

```bash
# pnpm
pnpm add arrow-cluster-layer @deck.gl/core @deck.gl/layers apache-arrow

# npm
npm install arrow-cluster-layer @deck.gl/core @deck.gl/layers apache-arrow

# yarn
yarn add arrow-cluster-layer @deck.gl/core @deck.gl/layers apache-arrow
```

`@deck.gl/core`, `@deck.gl/layers`, and `apache-arrow` are peer dependencies.

`arrow-supercluster` is included as a direct dependency — you don't need to install it separately. Its types are re-exported for convenience.

## Usage

```ts
import { ArrowClusterLayer } from "arrow-cluster-layer";
import type { Table } from "apache-arrow";

// Load your Arrow Table however you like (GeoParquet, IPC, etc.)
const table: Table = /* ... */;

const layer = new ArrowClusterLayer({
  id: "clusters",
  data: table,
  geometryColumn: "geometry",
  idColumn: "id",

  // Clustering
  clusterRadius: 75,
  clusterMaxZoom: 16,
  clusterMinZoom: 0,
  clusterMinPoints: 2,

  // Styling
  primaryColor: [26, 26, 64, 200],
  secondaryColor: [100, 100, 200, 200],
  selectedColor: [255, 140, 0, 230],
  textOpacity: 255,
  pointRadiusMinPixels: 10,
  pointRadiusMaxPixels: 100,

  // Interaction state
  selectedClusterId: null,
  focusedClusterId: null,

  // View
  viewType: "map", // or "globe"

  pickable: true,
});
```

## Props

### Data

| Prop             | Type          | Default      | Description                                                             |
| ---------------- | ------------- | ------------ | ----------------------------------------------------------------------- |
| `data`           | `arrow.Table` | required     | Arrow Table with a GeoArrow Point geometry column                       |
| `geometryColumn` | `string`      | `"geometry"` | Name of the geometry column                                             |
| `idColumn`       | `string`      | `"id"`       | Reserved for future use (currently ignored — IDs are Arrow row indices) |

### Clustering

| Prop               | Type     | Default | Description                   |
| ------------------ | -------- | ------- | ----------------------------- |
| `clusterRadius`    | `number` | `75`    | Cluster radius in pixels      |
| `clusterMaxZoom`   | `number` | `20`    | Max zoom level for clustering |
| `clusterMinZoom`   | `number` | `2`     | Min zoom level for clustering |
| `clusterMinPoints` | `number` | `2`     | Min points to form a cluster  |

### Styling

| Prop                   | Type        | Default                | Description                         |
| ---------------------- | ----------- | ---------------------- | ----------------------------------- |
| `primaryColor`         | `ColorRGBA` | `[26, 26, 64, 200]`    | Default fill color                  |
| `secondaryColor`       | `ColorRGBA` | `[100, 100, 200, 200]` | Focused cluster + descendants color |
| `selectedColor`        | `ColorRGBA` | `[255, 140, 0, 230]`   | Selected cluster color              |
| `textOpacity`          | `number`    | `255`                  | Cluster label text opacity (0-255)  |
| `pointRadiusMinPixels` | `number`    | `10`                   | Minimum circle radius in pixels     |
| `pointRadiusMaxPixels` | `number`    | `100`                  | Maximum circle radius in pixels     |

### Interaction

| Prop                | Type               | Default | Description                                 |
| ------------------- | ------------------ | ------- | ------------------------------------------- |
| `selectedClusterId` | `number \| null`   | `null`  | Currently selected cluster ID               |
| `focusedClusterId`  | `number \| null`   | `null`  | Currently focused (hovered) cluster ID      |
| `viewType`          | `"map" \| "globe"` | `"map"` | Flips text labels on globe view at low zoom |

### Filtering

| Prop         | Type                 | Default | Description                                                                                                                                                                    |
| ------------ | -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filterMask` | `Uint8Array \| null` | `null`  | Boolean mask for filtering which points enter the cluster index. Length must equal `table.numRows`. `0` = excluded, non-zero = included. When `null`, all points are included. |

## Picking

The layer returns `ArrowClusterPickingInfo` from `onHover` and `onClick`:

```ts
interface ArrowClusterPickingInfo extends PickingInfo {
  isCluster: boolean; // cluster or individual point?
  clusterId: number; // encoded cluster ID or Arrow row index
  pointCount: number; // points in cluster (1 for individual)
  arrowIndices: number[]; // Arrow row indices of all leaf points
  rows: StructRowProxy[]; // materialized Arrow rows
}
```

Example:

```ts
onClick: (info) => {
  const pick = info as ArrowClusterPickingInfo;
  if (pick.isCluster) {
    // Zoom into the cluster
    const zoom = layer.getClusterExpansionZoom(pick.clusterId);
    // ... fly to pick.coordinate at zoom
  } else {
    // Individual point — access the Arrow row
    const row = pick.rows[0];
    console.log(row.id, row.city, row.description);
  }
};
```

## Public Methods

### `layer.getClusterExpansionZoom(clusterId) → number`

Returns the zoom level at which a cluster splits into its children. Useful for zoom-on-click behavior.

## Rendering

The layer renders two sublayers:

- `ScatterplotLayer` — circles with binary attribute buffers (positions, radii, colors as typed arrays)
- `TextLayer` — cluster count labels with SDF fonts

Radius scales logarithmically with point count: `baseSize + (log(count+1) / log(total+1)) * scaleFactor`.

Text color is automatically chosen for contrast (black or white) based on the fill color's relative luminance.

## Style Helpers

The style computation functions are exported if you need to customize or extend them:

```ts
import {
  computeFillColors,
  computeRadii,
  computeTextColors,
  computeTexts,
} from "arrow-cluster-layer";
```

## Re-exports

The engine and its types are re-exported for convenience:

```ts
import {
  ArrowClusterEngine,
  type ClusterOutput,
  type ArrowClusterEngineOptions,
} from "arrow-cluster-layer";
```

## License

ISC
