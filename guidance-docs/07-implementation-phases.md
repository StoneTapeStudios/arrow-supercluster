# arrow-cluster-layer — Implementation Phases

## Phase 1: Monorepo Scaffold & Engine Package (arrow-supercluster)

**Goal**: A working, tested `ArrowClusterEngine` that produces identical clustering results to Supercluster, published as `arrow-supercluster`.

### Phase 1a: Scaffold the Monorepo

1. Initialize the monorepo root with pnpm workspaces
2. Create `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`
3. Scaffold `packages/arrow-supercluster` with TypeScript, tsdown, vitest
4. Scaffold `packages/arrow-cluster-layer` as an empty shell (implemented in Phase 2)
5. Verify `pnpm build` and `pnpm test` work across the workspace

### Phase 1b: Implement ArrowClusterEngine

1. **Implement `arrow-cluster-engine.ts`**
   - Port Supercluster's ~400 lines to work with Arrow typed arrays
   - `load(table, geometryColumn, idColumn)` — reads Arrow Float64Array directly, skips null geometries
   - `getClusters(bbox, zoom)` — returns `ClusterOutput` (typed arrays), clamps bbox to Mercator limits
   - `getChildren(clusterId)` — hierarchy navigation
   - `getLeaves(clusterId, limit?, offset?)` — returns Arrow row indices
   - `getClusterExpansionZoom(clusterId)` — same algorithm as Supercluster
   - `getOriginZoom(clusterId)` / `getOriginId(clusterId)` — ID decoding utilities

2. **Implement `arrow-helpers.ts`**
   - `getCoordBuffer(geomCol)` — abstracts the `data[0].children[0].values` access pattern
   - Fallback to `geomCol.get(i)` if internal layout changes
   - Single-chunk only in Phase 1

3. **Implement `mercator.ts`**
   - `lngX(lng)`, `latY(lat)`, `xLng(x)`, `yLat(y)` — same as Supercluster
   - `fround()` wrapper for `Math.fround`

4. **Implement `types.ts`**
   - `ClusterOutput` interface
   - `ArrowClusterEngineOptions` (radius, minZoom, maxZoom, minPoints)

5. **Write correctness tests**
   - Load the same point set into both Supercluster and ArrowClusterEngine
   - Compare cluster counts, positions, and hierarchy at every zoom level
   - Use Supercluster's own test data as fixtures
   - Test edge cases: antimeridian wrapping, poles, single-point clusters, empty data, max zoom, null geometries

6. **Publish `arrow-supercluster@0.1.0`**

---

## Phase 2: Layer Package (arrow-cluster-layer)

**Goal**: A working `ArrowClusterLayer` CompositeLayer that uses `arrow-supercluster` and produces the same visual output as the current `EventsClusterLayer`.

### Tasks

1. **Implement `style-helpers.ts`**
   - `computeFillColors(clusterOutput, styleOptions)` → `Uint8Array`
   - `computeRadii(clusterOutput, totalPoints)` → `Float32Array`
   - `computeTextColors(fillColors, textOpacity)` → `Uint8Array`
   - `computeTexts(clusterOutput)` → `(string | null)[]`
   - Unit test all functions

2. **Implement `arrow-cluster-layer.ts`**
   - Extend `CompositeLayer`
   - `updateState`: create `ArrowClusterEngine` when data changes, query clusters on zoom change
   - `renderLayers`: ScatterplotLayer (binary attributes) + TextLayer
   - `getPickingInfo`: resolve picked index → cluster/point data
   - Focused/selected cluster highlighting via descendant tracking
   - Globe view text angle flip
   - Expose `getClusterExpansionZoom(clusterId)` as public method (delegates to engine)

3. **Implement `picking.ts`**
   - Cluster pick → `engine.getLeaves()` → Arrow row indices
   - Point pick → single Arrow row index
   - Return `ArrowClusterPickingInfo` with indices and optional row materialization

4. **Implement `types.ts`**
   - `ArrowClusterLayerProps`
   - `ArrowClusterPickingInfo`
   - `ClusterStyleOptions`, `ColorRGBA`

5. **Re-export engine types from index.ts**
   - So consumers only need `arrow-cluster-layer` as a dependency

6. **Write README with usage examples**

7. **Publish `arrow-cluster-layer@0.1.0`**

### Correctness Validation

The layer should produce the same visual output as the current `EventsClusterLayer`. Validate by:

- Loading the same dataset in both layers side by side
- Comparing cluster counts and positions at each zoom level
- Verifying picking returns the correct data
- Checking focus/selection highlighting behavior

---

## Phase 3: scu-atlas Integration

**Goal**: Replace the GeoJSON pipeline in scu-atlas with GeoParquet + the new packages.

### Tasks

1. **Create `generate-static-parquet.ts`** — build script to produce `all-events.parquet`
2. **Set up parquet-wasm in Next.js** — WASM init, webpack config
3. **Create `use-arrow-events-data.ts`** — fetch + parse GeoParquet hook
4. **Update `create-cluster-layer.ts`** — swap to `ArrowClusterLayer`
5. **Update picking handlers** — adapt to `ArrowClusterPickingInfo`
6. **Performance benchmarking** — compare load time, memory, FPS vs current

---

## Phase 4: Optimizations

### Web Worker Pipeline

- Move GeoParquet loading + `engine.load()` to a Web Worker
- KDBush stores its index as a single `ArrayBuffer` — transferable between threads
- Use `@geoarrow/geoarrow-js` worker utilities for Arrow Table transfer
- Unblocks main thread during initial load (~200ms for 200k points)

### GeoArrowScatterplotLayer at High Zoom

- At zoom levels where no clustering occurs (all individual points), bypass the engine entirely
- Render the full Arrow Table through `GeoArrowScatterplotLayer`
- Zero-copy Arrow buffers → GPU, maximum performance

### DataFilterExtension

- GPU-based filtering by date range, source, event type
- Pre-compute filter columns as Arrow vectors
- Filter without rebuilding the spatial index

### Viewport-Based Loading

- Use `ParquetFile.fromUrl()` for HTTP range requests
- Only load row groups that intersect the current viewport
- Requires spatial partitioning of the Parquet file (Hilbert curve ordering)

### Multi-Chunk Table Support (arrow-supercluster)

- Extend `arrow-helpers.ts` to iterate `geomCol.data` chunks with index offsets
- Enables streaming/chunked loading of very large datasets
