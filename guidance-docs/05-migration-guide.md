# arrow-cluster-layer — Migration Guide (scu-atlas)

## Overview of Changes in scu-atlas

This document describes what changes in the scu-atlas app when adopting the `arrow-cluster-layer` monorepo packages. scu-atlas only needs to depend on `arrow-cluster-layer` (the layer package) — `arrow-supercluster` (the engine) comes in as a transitive dependency and its types are re-exported from the layer package for convenience.

## Files to Modify

### 1. `src/hooks/use-events-data.ts` → `src/hooks/use-arrow-events-data.ts`

Replace GeoJSON fetch with GeoParquet fetch + Arrow Table construction.

**Before:**

```ts
const fetchEvents = async (url: string): Promise<EventsFeatureCollection> => {
  const response = await fetch(url);
  return response.json();
};
```

**After:**

```ts
import { tableFromIPC } from "apache-arrow";
import type { Table } from "apache-arrow";

const fetchEventsArrow = async (url: string): Promise<Table> => {
  const { readParquet } = await import("parquet-wasm");
  const response = await fetch(url);
  const buffer = new Uint8Array(await response.arrayBuffer());
  const wasmTable = readParquet(buffer);
  return tableFromIPC(wasmTable.intoIPCStream());
};
```

### 2. `src/lib/map/layers/create-cluster-layer.ts`

Replace `EventsClusterLayer` with `ArrowClusterLayer`.

**Before:**

```ts
import { EventsClusterLayer } from "@/components/layers/cluster-layer";
return new EventsClusterLayer({
  data: featureCollection, // EventsFeatureCollection
  // ...
});
```

**After:**

```ts
import { ArrowClusterLayer } from "arrow-cluster-layer";
return new ArrowClusterLayer({
  data: arrowTable, // arrow.Table
  geometryColumn: "geometry",
  idColumn: "id",
  // ...
});
```

### 3. `src/lib/map/layers/create-visualization-layer.ts`

Update to pass Arrow Table instead of EventsFeatureCollection. The function signature changes from `data: EventsFeatureCollection` to `data: arrow.Table`.

### 4. `src/lib/map/create-layer-from-layer-control.ts`

Same change — update the data type flowing through the layer creation pipeline.

### 5. Picking Info Handling — Multiple Files

The picking info shape changes. Current code uses `ExtendedPickingInfo` with `events?: Event[]`. New code uses `ArrowClusterPickingInfo` with `arrowIndices?: number[]` and `rows?: arrow.StructRowProxy[]`.

**Files that consume `ExtendedPickingInfo`:**

- `src/hooks/use-map-interaction-state.ts` — `handleClusterClick`, `handleBackgroundClick`
- `src/hooks/use-map-view-management.ts` — `setSelectedCluster`
- `src/components/map.tsx` — passes `selectedCluster.events` to a popup component
- `src/lib/map/layers/create-cluster-layer.ts` — `handleClusterClick` callback type
- `src/lib/map/layers/create-visualization-layer.ts` — same
- `src/lib/map/create-layer-from-layer-control.ts` — same

**Before (map.tsx):**

```ts
events={selectedCluster.events}  // Event[]
```

**After (map.tsx):**

```ts
// Option A: Map Arrow rows to Event-like objects
const events = selectedCluster.rows?.map((row) => ({
  id: row.id,
  event_date: row.event_date,
  location: { x: row.geometry[0], y: row.geometry[1] },
  city: row.city,
  state: row.state,
  country: row.country,
  description: row.description,
  source: { name: row.source_name, url: row.source_base_url },
  source_url: row.source_url,
  // ... etc
}));

// Option B: Create a shared mapping utility
import { arrowRowToEvent } from "@/lib/utils/arrow-row-to-event";
const events = selectedCluster.rows?.map(arrowRowToEvent);
```

### 6. `src/components/map.tsx` — `getClusterExpansionZoom`

The current code casts the layer and calls `getClusterExpansionZoom` directly:

```ts
(defaultVizLayer as EventsClusterLayer).getClusterExpansionZoom(clusterId);
```

The new layer exposes the same method:

```ts
(defaultVizLayer as ArrowClusterLayer).getClusterExpansionZoom(clusterId);
```

No logic change needed, just the type cast.

### 7. `src/db/scripts/generate-static-geojson.ts` → add `generate-static-parquet.ts`

New script that generates `public/data/all-events.parquet`. See `02-data-pipeline.md` for schema details.

### 8. `src/lib/utils/events-to-feature-collection.ts`

This utility becomes unnecessary for the cluster layer path. Keep it if other parts of the app still need GeoJSON, otherwise deprecate.

## Files to Remove (Eventually)

- `src/components/layers/cluster-layer.tsx` — replaced by the package
- `src/components/layers/cluster-layer.helpers.ts` — logic moved to package's style helpers

## Types to Replace

| Current Type              | Location                                | Replacement                            |
| ------------------------- | --------------------------------------- | -------------------------------------- |
| `ExtendedPickingInfo`     | `src/lib/types/layers/visualization.ts` | `ArrowClusterPickingInfo` from package |
| `EventsClusterLayerState` | `src/lib/types/layers/visualization.ts` | Internal to package (not exported)     |
| `ClusterFeature`          | `src/lib/types/layers/visualization.ts` | Not needed — engine uses typed arrays  |

Note: `VisualizationType`, `VisualizationData`, `LayerDatabases`, `LayerDossiers`, and `PointProperties` in `visualization.ts` are used by other parts of the app and should NOT be removed.

## New Dependencies

Add to scu-atlas `package.json`:

```json
{
  "dependencies": {
    "arrow-cluster-layer": "^0.1.0",
    "parquet-wasm": "^0.6.0"
  }
}
```

`apache-arrow` (^20.0.0) is already in the project. `arrow-supercluster` comes in transitively via `arrow-cluster-layer` — no need to add it separately. If scu-atlas needs to use the engine directly (e.g., for advanced use cases), it can import from `arrow-cluster-layer` which re-exports the engine types.

Remove (once migration is complete):

- `supercluster` from dependencies — no longer used anywhere
- `@types/supercluster` from devDependencies — no longer needed

## WASM Setup for Next.js

`parquet-wasm` requires WASM initialization. In Next.js:

1. Copy the WASM binary to `public/` or use a CDN
2. Initialize once, lazily:

```ts
// src/lib/wasm/init-parquet.ts
let initialized = false;

export async function ensureParquetWasm() {
  if (initialized) return;
  const wasmInit = (await import("parquet-wasm")).default;
  await wasmInit();
  initialized = true;
}
```

3. Call `ensureParquetWasm()` before any parquet operations

Next.js webpack config may need `asyncWebAssembly` experiment enabled. The `parquet-wasm/bundler` entry point is designed for webpack-based bundlers.

## Incremental Migration Path

1. **Phase A**: Create the monorepo, implement `arrow-supercluster` engine, validate correctness against Supercluster
2. **Phase B**: Implement `arrow-cluster-layer` deck.gl layer on top of the engine, get it working standalone with test data
3. **Phase C**: Add `generate-static-parquet.ts` to scu-atlas, generate the parquet file
4. **Phase D**: Add `use-arrow-events-data.ts` hook, wire up WASM initialization
5. **Phase E**: Swap `create-cluster-layer.ts` to use `ArrowClusterLayer`
6. **Phase F**: Update picking handlers throughout the app (all files listed above)
7. **Phase G**: Remove old GeoJSON pipeline code
8. **Phase H**: Performance testing and optimization

Each phase can be merged independently. The old and new pipelines can coexist during migration.
