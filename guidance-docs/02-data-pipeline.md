# Data Pipeline & GeoParquet Generation

> This document describes the data pipeline in scu-atlas — how data flows from PostgreSQL to the browser. The `arrow-supercluster` and `arrow-cluster-layer` packages don't handle data loading; that's the consumer's responsibility. This doc is specific to scu-atlas's integration.

## Current Pipeline (GeoJSON)

```
PostgreSQL → getAllEventsAsFeatureCollection() → eventsToFeatureCollection()
    → GeoJSON FeatureCollection → write to public/data/all-events.geojson
    → browser fetches JSON → parse → Supercluster.load(features)
```

Problems:

- `all-events.geojson` is large (~50MB+ for 200k+ events), slow to parse
- Every property is duplicated as a JSON string (dates, descriptions, etc.)
- No compression on the wire beyond gzip/brotli transport encoding

## New Pipeline (GeoParquet)

### Step 1: Generate GeoParquet from PostgreSQL

Create a new script `generate-static-parquet.ts` (in scu-atlas, not in the arrow-cluster-layer monorepo) that:

1. Queries all events from the database (same query as `generate-static-geojson.ts`)
2. Builds an Arrow Table with typed columns:
   - `id`: Int32
   - `geometry`: FixedSizeList[2] of Float64 (GeoArrow Point encoding)
   - `event_date`: Utf8 (ISO date string)
   - `event_time`: Utf8 (nullable)
   - `city`: Utf8 (nullable)
   - `state`: Utf8 (nullable)
   - `country`: Utf8 (nullable)
   - `description`: Utf8 (nullable)
   - `shape`: Utf8 (nullable)
   - `duration`: Utf8 (nullable)
   - `source_name`: Utf8 — name of the data source (e.g., "NUFORC", "FAA")
   - `source_base_url`: Utf8 (nullable) — base URL of the data source website (from sources table)
   - `source_url`: Utf8 (nullable) — direct URL to the specific sighting report
   - `source_reference_id`: Utf8 (nullable)
   - `hynek_class`: Utf8 (nullable)
   - `vallee_class`: Utf8 (nullable)
   - `saunders_type`: Utf8 (nullable)
   - `saunders_main_type`: Int32 (nullable)
   - `sound`: Utf8 (nullable)
   - `date_precision`: Utf8 (nullable)
   - `event_types`: List of Utf8
3. Writes to `public/data/all-events.parquet` using `parquet-wasm` (Node entry point) with Zstd compression

**Expected size reduction**: GeoParquet with Zstd should be ~5-15MB for the same data that's 50MB+ as GeoJSON. That's a 3-10x reduction.

### Step 2: Browser Loading

In scu-atlas, replace `use-events-data.ts`:

```ts
// Before
const response = await fetch(eventsUrl);
const geojson: EventsFeatureCollection = await response.json();

// After
import initWasm, { readParquet } from "parquet-wasm";
import { tableFromIPC } from "apache-arrow";

await initWasm(); // one-time WASM init

const response = await fetch(parquetUrl);
const buffer = new Uint8Array(await response.arrayBuffer());
const wasmTable = readParquet(buffer);
const table = tableFromIPC(wasmTable.intoIPCStream());
```

### Alternative: @geoarrow/geoparquet-wasm

If the geometry column is stored as WKB (GeoParquet 1.0 standard), use:

```ts
import { readGeoParquet } from "@geoarrow/geoparquet-wasm";
const wasmTable = readGeoParquet(buffer);
const table = tableFromIPC(wasmTable.intoTable().intoIPCStream());
```

**Recommendation**: Use native GeoArrow encoding (`-lco GEOMETRY_ENCODING=GEOARROW` in GDAL, or construct the geometry column manually as FixedSizeList[2] of Float64) so we can use the simpler `parquet-wasm` path. The scu-atlas data is all Points, so the encoding is trivial.

### Step 3: Pass to ArrowClusterLayer

```ts
import { ArrowClusterLayer } from "arrow-cluster-layer";

const layer = new ArrowClusterLayer({
  id: "events-cluster",
  data: table,
  geometryColumn: "geometry",
  idColumn: "id",
  primaryColor: [26, 26, 64, 200],
  // ... other props
});
```

## GeoParquet Metadata

The generated Parquet file should include GeoParquet metadata so tools can recognize it:

```json
{
  "version": "1.1.0",
  "primary_column": "geometry",
  "columns": {
    "geometry": {
      "encoding": "geoarrow.point",
      "geometry_types": ["Point"],
      "crs": {
        "type": "GeographicCRS",
        "name": "WGS 84"
      },
      "bbox": [-180, -90, 180, 90]
    }
  }
}
```

## WASM Initialization Considerations

Both `parquet-wasm` and `@geoarrow/geoparquet-wasm` require WASM initialization before use. In a Next.js app:

- Use dynamic import to avoid SSR issues
- Initialize once at app startup or lazily on first data fetch
- The WASM binary (~1.2MB brotli-compressed for parquet-wasm with all codecs) needs to be served as a static asset or loaded from CDN
- Consider a minimal build of parquet-wasm with only Zstd support to reduce bundle size

## Offline / Static Generation

The `generate-static-parquet.ts` script runs at build time (or manually), same as the current `generate-geojson` script. Add a new npm script:

```json
"generate-parquet": "dotenv -e .env.local -- tsx src/db/scripts/generate-static-parquet.ts"
```
