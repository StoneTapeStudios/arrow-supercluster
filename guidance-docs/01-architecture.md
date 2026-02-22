# arrow-cluster-layer — Architecture

## Design Principle: Stay in Arrow, Never Touch GeoJSON

Data enters as an Arrow Table and stays columnar through clustering. The engine reads coordinate buffers directly and outputs typed arrays that go straight to deck.gl's GPU pipeline. No intermediate JSON objects.

## How Supercluster Actually Works Internally

Looking at Supercluster's source (~400 lines at `https://unpkg.com/browse/supercluster@8.0.1/index.js`), here's what it does:

1. **`load(points)`**: Iterates GeoJSON features, extracts `lng/lat`, converts to Mercator `x/y` via `lngX()`/`latY()`, and packs them into a **plain JS `Array`** (not a typed array): `[x, y, zoom, id, parent, numPoints, ...]` with a stride of 6 (or 7 with `reduce`). Then builds a KDBush index on that flat array.

2. **`_cluster(tree, zoom)`**: For each zoom level (top-down from maxZoom to minZoom), does radius queries on the KDBush index to find neighbors, merges them into clusters with weighted centroids, and produces a new flat array for the next zoom level.

3. **`getClusters(bbox, zoom)`**: Range query on the KDBush tree at the given zoom, builds and returns GeoJSON Feature objects.

4. **`getChildren/getLeaves/getClusterExpansionZoom`**: Navigate the hierarchy using parent IDs stored in the flat arrays.

The key insight: **Supercluster's internal representation is already flat numeric arrays.** GeoJSON is only the input/output format. The actual clustering algorithm works on `[x, y, zoom, id, parent, numPoints]` tuples.

Important detail: Supercluster uses a **plain JS `Array`** internally (via `data.push()`), not a `Float64Array` or other typed array. This is because the array is built incrementally and its final size isn't known upfront. Our engine will do the same — the internal data arrays are plain JS arrays. Only the **output** of `getClusters()` is packed into typed arrays.

## Two-Package Architecture

The system is split into two packages with a clean boundary:

```text
Arrow Table (from GeoParquet)
        │
        ▼
┌─────────────────────────────────────────────┐
│  arrow-supercluster (engine package)         │
│                                              │
│  ArrowClusterEngine                          │
│                                              │
│  1. Read Float64Array directly from Arrow     │
│     geometry column's underlying buffer      │
│                                              │
│  2. Convert lng/lat → Mercator x/y           │
│     Pack into flat JS array (same as         │
│     Supercluster's internal format)          │
│                                              │
│  3. Build KDBush index per zoom level        │
│     (same algorithm as Supercluster)         │
│                                              │
│  4. Output: ClusterOutput (typed arrays)     │
│     - positions: Float64Array                │
│     - pointCounts: Uint32Array               │
│     - ids: Float64Array                      │
│     - isCluster: Uint8Array                  │
│                                              │
│  No deck.gl. No rendering. No DOM.           │
└──────────────┬──────────────────────────────┘
               │ ClusterOutput
               ▼
┌─────────────────────────────────────────────┐
│  arrow-cluster-layer (layer package)         │
│                                              │
│  ArrowClusterLayer (CompositeLayer)          │
│                                              │
│  Computes style arrays from ClusterOutput:   │
│  - fillColors: Uint8Array (RGBA per cluster) │
│  - radii: Float32Array                       │
│  - textColors: Uint8Array                    │
│  - texts: (string | null)[]                  │
│                                              │
│  ScatterplotLayer ← binary attribute buffers │
│  TextLayer ← positions + text strings        │
│                                              │
│  Picking → resolves to Arrow row indices     │
└─────────────────────────────────────────────┘
```

The boundary between the packages is the `ClusterOutput` interface. The engine knows nothing about rendering. The layer knows nothing about KDBush or clustering internals.

## Package 1: arrow-supercluster — The Clustering Engine

A reimplementation of Supercluster's algorithm that accepts Arrow coordinate buffers instead of GeoJSON. ~400 lines of well-understood code (Supercluster is MIT licensed). This package has no deck.gl dependency and can be used with any rendering library.

**Input**: Arrow `Table` with a geometry column (GeoArrow Point encoding = `FixedSizeList[2]` of Float64)

**Internal state** (same as Supercluster):

- `trees: KDBush[]` — one KDBush index per zoom level
- Flat data arrays: `[x, y, zoom, id, parent, numPoints]` per point/cluster (plain JS `Array`, stride of 6)
- `numPoints: number` — total input points (needed for cluster ID encoding)

**Public API**:

- `load(table, geometryColumn, idColumn)` — index the Arrow Table
- `getClusters(bbox, zoom)` → `ClusterOutput` (typed arrays)
- `getChildren(clusterId)` → `ClusterOutput`
- `getLeaves(clusterId, limit?, offset?)` → `number[]` (Arrow row indices)
- `getClusterExpansionZoom(clusterId)` → `number`
- `getOriginZoom(clusterId)` → `number` (decode zoom from cluster ID)
- `getOriginId(clusterId)` → `number` (decode origin index from cluster ID)

**Differences from Supercluster**:

- `load()` reads from Arrow geometry column's `Float64Array` buffer instead of iterating GeoJSON features
- `getClusters()` returns `ClusterOutput` (typed arrays) instead of GeoJSON Feature[]
- `getLeaves()` returns indices into the original Arrow Table instead of GeoJSON features
- No `this.points` array of GeoJSON objects — individual point data is accessed from the Arrow Table by index
- No `map`/`reduce` support (not needed for our use case; can be added later)

**Cluster ID encoding** (same as Supercluster):
`clusterId = ((originIndex << 5) + (zoom + 1) + numOriginalPoints)`

For 200k points, max cluster ID ≈ ~6.5M, which fits in a standard JS number. We use `Float64Array` for IDs (not `Int32Array`) to avoid overflow risk with larger datasets.

## Package 2: arrow-cluster-layer — The deck.gl CompositeLayer

This package depends on `arrow-supercluster` and bridges its output to deck.gl's rendering pipeline.

Responsibilities:

- Accept `data: arrow.Table` as prop
- On data change: extract geometry column, call `engine.load()`
- On zoom change: call `engine.getClusters([-180, -85, 180, 85], zoom)` (full world bbox, same as current layer)
- Compute style arrays (colors, radii) from `ClusterOutput` + style props
- Pass typed arrays to ScatterplotLayer via deck.gl's binary data interface
- Render TextLayer for cluster count labels
- Handle picking by resolving indices back to Arrow Table rows
- Expose `getClusterExpansionZoom(clusterId)` as a public method (consumed by scu-atlas's map.tsx)
- Track focused cluster descendants for highlighting (same algorithm as current layer)

### Style Computation (in the layer package, not the engine)

Same visual logic as current `cluster-layer.helpers.ts`, but operating on typed arrays:

- `computeFillColors(clusterOutput, focusedClusterId, focusChildrenIds, selectedClusterId, primaryColor, secondaryColor, selectedColor)` → `Uint8Array` (RGBA \* length)
- `computeRadii(clusterOutput, totalPoints)` → `Float32Array`
- `computeTextColors(fillColors, textOpacity)` → `Uint8Array` (RGBA \* length)
- `computeTexts(clusterOutput)` → `(string | null)[]`

The radius formula is preserved from the current implementation:

```ts
const radius =
  baseSize +
  (Math.log(pointCount + 1) / Math.log(totalPoints + 1)) * scaleFactor;
// baseSize = 4, scaleFactor = 50
```

The text color uses relative luminance (same as current `getHighContrastTextColor`):

```ts
const luminance = 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
// (with sRGB linearization)
const textColor =
  luminance > 0.5 ? [0, 0, 0, opacity] : [255, 255, 255, opacity];
```

### Picking Resolver

When a user clicks/hovers:

1. deck.gl gives us the picked index into the typed arrays
2. We look up `ids[index]` and `isCluster[index]` from the `ClusterOutput` stored in layer state
3. For clusters: call `engine.getLeaves(clusterId)` → get Arrow row indices → materialize rows via `table.get(i)`
4. For individual points: `ids[index]` IS the Arrow row index → materialize via `table.get(ids[index])`

## Rendering: Binary Data Interface

deck.gl supports supplying pre-computed typed arrays directly to layers, bypassing accessor functions. This is documented in the [deck.gl performance guide](https://deck.gl/docs/developer-guide/performance#supply-attributes-directly).

Important: **binary attributes only work with primitive layers** (ScatterplotLayer, TextLayer), not composite layers like GeoJsonLayer. This is another reason we use ScatterplotLayer directly.

```ts
new ScatterplotLayer({
  data: {
    length: clusterCount,
    attributes: {
      getPosition: { value: positions, size: 2 }, // Float64Array
      getRadius: { value: radii, size: 1 }, // Float32Array
      getFillColor: { value: fillColors, size: 4 }, // Uint8Array
    },
  },
  stroked: true,
  lineWidthMinPixels: 1,
  getLineColor: [0, 0, 0, 255], // constant, not per-object
  radiusUnits: "pixels",
  radiusMinPixels: 10,
  radiusMaxPixels: 100,
});
```

For TextLayer, `getText` must be a function or string accessor — no binary shortcut for text content. But positions and colors can be binary:

```ts
new TextLayer({
  data: clusterTexts, // (string | null)[] — only clusters have text
  getPosition: (_, { index }) => [
    positions[index * 2],
    positions[index * 2 + 1],
  ],
  getText: (d) => d,
  getColor: (_, { index }) => [
    textColors[index * 4],
    textColors[index * 4 + 1],
    textColors[index * 4 + 2],
    textColors[index * 4 + 3],
  ],
  getSize: 18,
  // ...
});
```

Note: The TextLayer approach above uses accessor functions rather than binary attributes because TextLayer needs string data. This is a minor cost — there are typically <1000 visible clusters at any zoom level.

## Memory Flow Comparison

### Current (GeoJSON)

```text
50MB GeoJSON on wire
  → ~200MB parsed JS objects (FeatureCollection with full Event properties)
  → Supercluster copies coords into flat arrays (~10MB internal state)
  → getClusters() builds new GeoJSON Feature[] per zoom change
  → GeoJsonLayer → ScatterplotLayer attribute generation
Total: ~250MB+ peak memory
```

### New (Arrow)

```text
~10MB GeoParquet on wire (Zstd compressed)
  → ~20MB Arrow Table in memory (columnar, no JS object overhead)
  → ArrowClusterEngine reads Float64Array directly from Arrow buffer
  → Engine internal state: ~10MB (flat arrays + KDBush indices)
  → getClusters() produces typed arrays (~100KB for visible clusters)
  → ScatterplotLayer uses typed arrays directly
Total: ~35MB peak memory
```

## Layer Props Interface

```ts
interface ArrowClusterLayerProps extends CompositeLayerProps {
  // Data
  data: arrow.Table;
  geometryColumn?: string; // default: "geometry"
  idColumn?: string; // default: "id"

  // Clustering (passed through to ArrowClusterEngine)
  clusterRadius?: number; // default: 75 (pixels)
  clusterMaxZoom?: number; // default: 20
  clusterMinZoom?: number; // default: 2
  clusterMinPoints?: number; // default: 2

  // Styling
  primaryColor?: [number, number, number, number]; // default: [26, 26, 64, 200]
  secondaryColor?: [number, number, number, number];
  selectedColor?: [number, number, number, number];
  textOpacity?: number; // default: 255
  pointRadiusMinPixels?: number; // default: 10
  pointRadiusMaxPixels?: number; // default: 100

  // Interaction state
  selectedClusterId?: number;
  focusedClusterId?: number;

  // View
  viewType?: "map" | "globe"; // affects text angle (flipped on globe at low zoom)
}
```

Props NOT included (consumer's responsibility):

- `databaseEnabled`, `filterIds`, `filteredFeatures` — filtering should happen before passing the Arrow Table to the layer, or via deck.gl's DataFilterExtension
- `onHover` — use deck.gl's standard `onHover` prop inherited from CompositeLayerProps
- `onClick` — same, inherited from CompositeLayerProps

## Public Methods on the Layer

```ts
class ArrowClusterLayer {
  /** Get the zoom level at which a cluster expands into multiple children.
   *  Called by scu-atlas map.tsx when clicking a cluster to zoom in.
   *  Delegates to the internal ArrowClusterEngine instance. */
  getClusterExpansionZoom(clusterId: number): number;
}
```

## Feature Parity with Current EventsClusterLayer

| Feature                                            | Current | New | Notes                                                         |
| -------------------------------------------------- | ------- | --- | ------------------------------------------------------------- |
| Cluster circles with variable radius               | ✅      | ✅  | Same log-scaled formula (baseSize=4, scaleFactor=50)          |
| Cluster count labels                               | ✅      | ✅  | TextLayer with SDF fonts, billboard=false                     |
| Focus highlighting (cluster + descendants)         | ✅      | ✅  | Same recursive descendant traversal                           |
| Selection highlighting                             | ✅      | ✅  | Same color logic (selected → selectedColor)                   |
| High-contrast text color                           | ✅      | ✅  | Same luminance-based black/white calculation                  |
| Click → get leaf data                              | ✅      | ✅  | Returns Arrow row indices (consumer materializes)             |
| Cluster expansion zoom                             | ✅      | ✅  | Same algorithm, exposed as public method                      |
| Globe view text flip                               | ✅      | ✅  | textAngle = 180 when globe && zoom <= 12                      |
| Picking info with event data                       | ✅      | ✅  | `ArrowClusterPickingInfo` with `arrowIndices` and `rows`      |
| Full world bbox query                              | ✅      | ✅  | `getClusters([-180, -85, 180, 85], z)` — not viewport-clipped |
| `getSubLayerProps` for sublayer inheritance        | ✅      | ✅  | Preserves opacity, visibility, etc. from parent               |
| `cullMode: "back"` for circles, `"front"` for text | ✅      | ✅  | Same WebGL parameters                                         |
