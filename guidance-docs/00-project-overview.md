# arrow-cluster-layer — Project Overview

## What This Is

A monorepo containing two npm packages that together replace the current `EventsClusterLayer` in scu-atlas:

1. **`arrow-supercluster`** — A framework-agnostic spatial clustering engine that reimplements Supercluster's algorithm to work directly with Apache Arrow typed array buffers. No GeoJSON, no rendering opinion. Think "supercluster but for Arrow."

2. **`arrow-cluster-layer`** — A deck.gl `CompositeLayer` that consumes `arrow-supercluster`'s output and renders clustered points using `ScatterplotLayer` + `TextLayer` with deck.gl's binary data interface.

The split exists because these serve different audiences. Someone using Mapbox GL or Leaflet might want the engine without deck.gl. Someone already on deck.gl might want the layer but swap in a different clustering strategy. A monorepo keeps them in sync while allowing independent versioning and publishing.

## What Each Package Does

### arrow-supercluster

- Accepts an Arrow `Table` with a GeoArrow Point geometry column
- Reads the underlying `Float64Array` coordinate buffer directly — zero copy from Arrow memory
- Runs the same KDBush-based clustering algorithm as Supercluster (~400 lines)
- Outputs `ClusterOutput` — typed arrays (`Float64Array`, `Uint32Array`, `Uint8Array`) ready for any rendering pipeline
- Exposes hierarchy navigation: `getChildren`, `getLeaves`, `getClusterExpansionZoom`
- Has zero rendering dependencies — no deck.gl, no DOM, no WebGL

### arrow-cluster-layer

- Accepts an Arrow `Table` as its `data` prop (same table passed to the engine)
- Creates and manages an `ArrowClusterEngine` instance internally
- Computes style arrays (colors, radii, text) from `ClusterOutput` + style props
- Renders via `ScatterplotLayer` (binary attributes) + `TextLayer`
- Handles picking by resolving indices back to Arrow Table rows
- Exposes `getClusterExpansionZoom(clusterId)` as a public method

## Why

- **Memory**: The current pipeline fetches a ~50MB+ GeoJSON file, parses it into JS objects (~200MB in memory), then Supercluster re-indexes everything. Arrow columnar format avoids JS object overhead entirely. Expected ~10x memory reduction.
- **Transfer**: GeoParquet with Zstd compression is typically 3-10x smaller than equivalent GeoJSON on the wire.
- **GPU path**: Cluster output goes to deck.gl's ScatterplotLayer as pre-computed typed arrays (binary data interface) — no accessor function overhead, no intermediate objects.
- **No serialization tax**: Supercluster requires GeoJSON in and produces GeoJSON out. By reimplementing its ~400-line algorithm to read Arrow coordinate buffers directly and output typed arrays, we eliminate all JSON serialization/deserialization.
- **Decoupling**: Two standalone packages let other projects reuse the clustering engine or the layer independently without pulling in scu-atlas app code.

## Repo Name

`arrow-cluster-layer` (the monorepo). Contains:

- `packages/arrow-supercluster` → published as `arrow-supercluster`
- `packages/arrow-cluster-layer` → published as `arrow-cluster-layer`

## Package Dependencies

### arrow-supercluster

| Package               | Relationship      | Role                                                                  |
| --------------------- | ----------------- | --------------------------------------------------------------------- |
| `kdbush` (^4)         | direct dependency | Fast static 2D spatial index — the core data structure for clustering |
| `apache-arrow` (>=14) | peer dependency   | Arrow JS — Table, Vector types for input                              |
| `supercluster` (^8)   | dev dependency    | Reference implementation for correctness testing only                 |

### arrow-cluster-layer

| Package                | Relationship      | Role                                                  |
| ---------------------- | ----------------- | ----------------------------------------------------- |
| `arrow-supercluster`   | direct dependency | The clustering engine                                 |
| `@deck.gl/core` (^9)   | peer dependency   | CompositeLayer base class                             |
| `@deck.gl/layers` (^9) | peer dependency   | ScatterplotLayer, TextLayer sublayers                 |
| `apache-arrow` (>=14)  | peer dependency   | Arrow JS — Table, Vector types for picking/row access |

Note: `parquet-wasm`, `@geoarrow/geoparquet-wasm`, `@geoarrow/deck.gl-layers`, and `@geoarrow/geoarrow-js` are NOT dependencies of either package. Data loading (GeoParquet → Arrow Table) is the consumer's responsibility. Those libraries are used in scu-atlas, not in these packages.

## Relationship to scu-atlas

scu-atlas will:

1. Add `arrow-cluster-layer` as a dependency (which brings in `arrow-supercluster` transitively)
2. Add `parquet-wasm` as a dependency (for loading GeoParquet files in the browser)
3. Replace `EventsClusterLayer` import with `ArrowClusterLayer` from `arrow-cluster-layer`
4. Replace the GeoJSON fetch (`use-events-data.ts`) with a GeoParquet fetch + Arrow Table construction
5. Adapt `create-cluster-layer.ts` to pass an Arrow Table instead of `EventsFeatureCollection`
6. Update picking handlers to work with Arrow row indices instead of `Event[]`

Both packages are intentionally generic — they know nothing about "events", "dossiers", or "sources". They cluster Arrow point data.

## Why a Monorepo (Not Two Separate Repos)

- The engine API is still settling — atomic PRs that touch both packages when the interface changes
- Shared dev tooling: TypeScript config, vitest, CI pipeline, linting
- One `pnpm install`, one CI run
- Independent npm packages with their own versioning despite living together
- Avoids the version coordination headaches of separate repos during early development

Once the API stabilizes, splitting into separate repos is straightforward if desired.

## Reference Material

The clustering algorithm is a reimplementation of [mapbox/supercluster](https://github.com/mapbox/supercluster) (MIT license). The full source is ~400 lines in `index.js`. The algorithm is documented in this [Mapbox blog post](https://blog.mapbox.com/clustering-millions-of-points-on-a-map-with-supercluster-272046ec5c97).

The Supercluster source should be read before implementing the engine. It lives at:
`https://unpkg.com/browse/supercluster@8.0.1/index.js`

Key libraries to understand:

- [KDBush](https://github.com/mourner/kdbush) — the spatial index Supercluster is built on
- [deck.gl binary data interface](https://deck.gl/docs/developer-guide/performance#supply-attributes-directly) — how we pass typed arrays directly to layers
- [@geoarrow/deck.gl-layers](https://geoarrow.org/deck.gl-layers/) — reference for how Arrow data can be rendered in deck.gl (we don't depend on this, but it informed the architecture)
