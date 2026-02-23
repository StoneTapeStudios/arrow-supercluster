# arrow-cluster-layer — Implementation Phases

## Phase 1: Monorepo Scaffold & Engine Package (arrow-supercluster) ✅ COMPLETE

**Goal**: A working, tested `ArrowClusterEngine` that produces identical clustering results to Supercluster, published as `arrow-supercluster`.

### Phase 1a: Scaffold the Monorepo ✅

1. ✅ Initialize the monorepo root with pnpm workspaces
2. ✅ Create `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`
3. ✅ Scaffold `packages/arrow-supercluster` with TypeScript, tsdown, vitest
4. ✅ Scaffold `packages/arrow-cluster-layer` as an empty shell (implemented in Phase 2)
5. ✅ Verify `pnpm build` and `pnpm test` work across the workspace

### Phase 1b: Implement ArrowClusterEngine ✅

1. ✅ **Implement `arrow-cluster-engine.ts`** — full port with reusable output buffers + direct coordinate reads
2. ✅ **Implement `arrow-helpers.ts`** — `getCoordBuffer()` with single-chunk access
3. ✅ **Implement `mercator.ts`** — `lngX`, `latY`, `xLng`, `yLat`, `fround`
4. ✅ **Implement `types.ts`** — `ClusterOutput`, `ArrowClusterEngineOptions`
5. ✅ **Write correctness tests** — 17 tests passing (7 engine, 10 edge cases)
6. ⬜ **Publish `arrow-supercluster@0.1.0`** — not yet published to npm

---

## Phase 2: Layer Package (arrow-cluster-layer)

**Goal**: A working `ArrowClusterLayer` CompositeLayer that uses `arrow-supercluster` and produces the same visual output as the current `EventsClusterLayer`.

### Tasks

1. ✅ **Implement `types.ts`**
   - `ArrowClusterLayerProps` extending `CompositeLayerProps`
   - `ArrowClusterPickingInfo` with `isCluster`, `clusterId`, `pointCount`, `arrowIndices`, `rows`
   - `ClusterStyleOptions`, `ColorRGBA`
   - `ArrowClusterLayerState` (internal, with index signature for deck.gl compatibility)

2. ✅ **Implement `style-helpers.ts`**
   - `computeFillColors(output, primary, secondary, selected, focusedId, focusedChildren, selectedId)` → `Uint8Array`
   - `computeRadii(output, totalPoints)` → `Float32Array` (log-scaled, baseSize=4, scaleFactor=50)
   - `computeTextColors(fillColors, textOpacity)` → `Uint8Array` (sRGB-linearized luminance for contrast)
   - `computeTexts(output)` → `(string | null)[]`
   - ⬜ Unit tests (not yet written)

3. ✅ **Implement `picking.ts`**
   - `resolvePickingInfo()` — cluster pick → `engine.getLeaves()` → Arrow row indices + materialized rows
   - Point pick → single Arrow row index → `table.get(id)`
   - Returns `ArrowClusterPickingInfo`

4. ✅ **Implement `arrow-cluster-layer.ts`**
   - Extends `CompositeLayer` with deck.gl v9 `DefaultProps` (uses `"number"`, `"color"` type strings)
   - `initializeState` / `updateState`: creates `ArrowClusterEngine` on data/config change, queries clusters on viewport change
   - `renderLayers`: `ScatterplotLayer` (binary attributes via `data.attributes`) + `TextLayer` (accessor functions)
   - `getPickingInfo`: delegates to `resolvePickingInfo()`
   - Focused/selected cluster highlighting via descendant tracking (`_updateFocusedChildren`)
   - Globe view text angle flip (180° when globe && zoom ≤ 12)
   - `getClusterExpansionZoom(clusterId)` exposed as public method
   - `parameters.cullMode`: `"back"` for circles, `"front"` for text (WebGPU-style string constants per v9)

5. ✅ **Re-export engine types from `index.ts`**
   - Exports layer, types, style helpers, and re-exports `ArrowClusterEngine` + `ClusterOutput` + `ArrowClusterEngineOptions`

6. ✅ **Build verified** — both packages build cleanly (`pnpm -r build`), layer package ~10KB minified

7. ⬜ **Write unit tests** — `style-helpers.test.ts`, `picking.test.ts`

8. ⬜ **Write README with usage examples**

9. ⬜ **Publish `arrow-cluster-layer@0.1.0`**

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
