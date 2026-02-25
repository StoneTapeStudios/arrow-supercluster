# Loading GeoParquet into ArrowClusterLayer

## The single-chunk requirement

`ArrowClusterEngine` reads the geometry column's underlying `Float64Array` buffer directly via `getCoordBuffer()`. The fast zero-copy path only reads `geomCol.data[0]` — the first chunk.

`parquet-wasm`'s `readParquet()` defaults to a `batchSize` of 1024 rows, which splits a 1M-row file into ~977 chunks. Only the first 1024 points would be indexed.

**Always pass a `batchSize` large enough to cover the entire file:**

```ts
import initWasm, { readParquet } from "parquet-wasm";
import { tableFromIPC } from "apache-arrow";

await initWasm();

const resp = await fetch("/data/points-1m.parquet");
const buf = new Uint8Array(await resp.arrayBuffer());

// batchSize must be >= total row count to get a single-chunk table
const wasmTable = readParquet(buf, { batchSize: 1_100_000 });
const table = tableFromIPC(wasmTable.intoIPCStream());
```

If `batchSize` is too small, `getCoordBuffer()` falls back to row-by-row extraction via `geomCol.get(i)` — it still works, but is significantly slower for large datasets.

## What the generated file contains

| Column     | Arrow Type                  | Description               |
| ---------- | --------------------------- | ------------------------- |
| `geometry` | `FixedSizeList[2]<Float64>` | GeoArrow Point (lng, lat) |
| `id`       | `Int32`                     | Sequential 0..999,999     |
| `city`     | `Utf8`                      | Nearest city name         |

- GeoParquet v1.1.0 metadata with `encoding: "point"` (native GeoArrow, not WKB)
- Zstd compression, single row group
- No WKB decode step needed — the geometry column is directly consumable
