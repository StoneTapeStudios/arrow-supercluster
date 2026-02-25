#!/usr/bin/env npx tsx
/**
 * Generate a GeoParquet file with 1 million synthetic points.
 *
 * Produces a valid GeoParquet v1.1.0 file using native GeoArrow point encoding
 * (FixedSizeList[2] of Float64). This is the exact format that ArrowClusterEngine
 * expects — when read back via parquet-wasm + tableFromIPC, the geometry column
 * is directly consumable with zero conversion.
 *
 * Usage:
 *   pnpm --filter arrow-cluster-layer-example generate-data
 *
 * Output:
 *   examples/basic/public/data/points-1m.parquet
 *
 * Dependencies (devDependencies of the example):
 *   - apache-arrow (already present)
 *   - parquet-wasm  (added for this script)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  makeVector,
  vectorFromArray,
  tableToIPC,
  Table,
  Float64,
  Int32,
  Utf8,
  Field,
  FixedSizeList,
} from "apache-arrow";

// parquet-wasm Node entry point (CJS, auto-initializes WASM)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const parquetWasm = require("parquet-wasm/node");
const {
  writeParquet,
  WriterPropertiesBuilder,
  Compression,
  Table: WasmTable,
} = parquetWasm;

// ─── Configuration ──────────────────────────────────────────────────────────

const NUM_POINTS = 2_000_000;
const OUTPUT_PATH = resolve(
  import.meta.dirname ?? ".",
  "../public/data/points-2m.parquet",
);

// City centers with realistic clustering — points are gaussian-distributed
// around each center so the clustering algorithm has interesting work to do.
const CITY_CENTERS: [lng: number, lat: number, name: string][] = [
  [-122.42, 37.78, "San Francisco"],
  [-73.97, 40.76, "New York"],
  [-0.12, 51.51, "London"],
  [2.35, 48.86, "Paris"],
  [139.69, 35.69, "Tokyo"],
  [151.21, -33.87, "Sydney"],
  [-43.17, -22.91, "Rio de Janeiro"],
  [28.98, 41.01, "Istanbul"],
  [77.21, 28.61, "New Delhi"],
  [37.62, 55.75, "Moscow"],
  [-118.24, 34.05, "Los Angeles"],
  [13.41, 52.52, "Berlin"],
  [100.5, 13.76, "Bangkok"],
  [-46.63, -23.55, "São Paulo"],
  [31.24, 30.04, "Cairo"],
  [-87.63, 41.88, "Chicago"],
  [126.98, 37.57, "Seoul"],
  [116.4, 39.9, "Beijing"],
  [-3.7, 40.42, "Madrid"],
  [18.07, 59.33, "Stockholm"],
];

// ─── Deterministic PRNG ─────────────────────────────────────────────────────

function seededRandom(seed: number) {
  return () => {
    seed = (seed * 16807 + 0) % 2147483647;
    return seed / 2147483647;
  };
}

// Box-Muller transform for gaussian distribution around city centers
function gaussianPair(rand: () => number): [number, number] {
  let u1: number, u2: number;
  do {
    u1 = rand();
  } while (u1 === 0);
  u2 = rand();
  const mag = Math.sqrt(-2.0 * Math.log(u1));
  return [
    mag * Math.cos(2.0 * Math.PI * u2),
    mag * Math.sin(2.0 * Math.PI * u2),
  ];
}

// ─── Generate Points ────────────────────────────────────────────────────────

console.log(`Generating ${(NUM_POINTS / 1e6).toFixed(0)}M synthetic points...`);
const t0 = performance.now();

const rand = seededRandom(42);
const coords: [number, number][] = new Array(NUM_POINTS);
const cityNames: string[] = new Array(NUM_POINTS);

// Bounding box tracking for GeoParquet metadata
let minLng = Infinity,
  minLat = Infinity,
  maxLng = -Infinity,
  maxLat = -Infinity;

for (let i = 0; i < NUM_POINTS; i++) {
  const cityIdx = Math.floor(rand() * CITY_CENTERS.length);
  const [cLng, cLat, name] = CITY_CENTERS[cityIdx];

  // Gaussian spread: ~68% within 1.5°, ~95% within 3°
  const [dx, dy] = gaussianPair(rand);
  const spread = 1.5;
  const lng = cLng + dx * spread;
  const lat = Math.max(-85, Math.min(85, cLat + dy * spread));

  coords[i] = [lng, lat];
  cityNames[i] = name;

  if (lng < minLng) minLng = lng;
  if (lng > maxLng) maxLng = lng;
  if (lat < minLat) minLat = lat;
  if (lat > maxLat) maxLat = lat;
}

console.log(`  Points generated in ${(performance.now() - t0).toFixed(0)}ms`);

// ─── Build Arrow Table ──────────────────────────────────────────────────────

console.log("Building Arrow Table...");
const t1 = performance.now();

// Geometry: FixedSizeList[2] of Float64 — GeoArrow Point encoding
const childField = new Field("xy", new Float64());
const listType = new FixedSizeList(2, childField);
const geomVector = vectorFromArray(coords, listType);

// ID: Int32 sequential
const ids = new Int32Array(NUM_POINTS);
for (let i = 0; i < NUM_POINTS; i++) ids[i] = i;
const idVector = makeVector(ids);

// City: Utf8
const cityVector = vectorFromArray(cityNames, new Utf8());

const table = new Table({
  geometry: geomVector,
  id: idVector,
  city: cityVector,
});

console.log(
  `  Arrow Table built in ${(performance.now() - t1).toFixed(0)}ms` +
    ` (${table.numRows.toLocaleString()} rows, ${table.numCols} columns)`,
);

// ─── Write GeoParquet ───────────────────────────────────────────────────────

console.log("Writing GeoParquet...");
const t2 = performance.now();

// Serialize Arrow Table → IPC stream → parquet-wasm Table
const ipcBuffer = tableToIPC(table, "stream");
const wasmTable = WasmTable.fromIPCStream(ipcBuffer);

// GeoParquet v1.1.0 file-level metadata
// Ref: https://geoparquet.org/releases/v1.1.0/
const geoMetadata = JSON.stringify({
  version: "1.1.0",
  primary_column: "geometry",
  columns: {
    geometry: {
      encoding: "point",
      geometry_types: ["Point"],
      bbox: [
        Math.floor(minLng * 1e6) / 1e6,
        Math.floor(minLat * 1e6) / 1e6,
        Math.ceil(maxLng * 1e6) / 1e6,
        Math.ceil(maxLat * 1e6) / 1e6,
      ],
    },
  },
});

// Writer properties: Zstd compression + GeoParquet metadata
// Single row group keeps all data contiguous for efficient Arrow loading.
// When reading, use { batchSize: NUM_POINTS } to get a single-chunk table
// so getCoordBuffer() can use the zero-copy fast path.
const writerProps = new WriterPropertiesBuilder()
  .setCompression(Compression.ZSTD)
  .setMaxRowGroupSize(NUM_POINTS)
  .setKeyValueMetadata(new Map([["geo", geoMetadata]]))
  .build();

const parquetBytes = writeParquet(wasmTable, writerProps);

// Ensure output directory exists and write
mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, parquetBytes);

const sizeMB = (parquetBytes.byteLength / (1024 * 1024)).toFixed(2);
console.log(
  `  GeoParquet written in ${(performance.now() - t2).toFixed(0)}ms` +
    ` → ${OUTPUT_PATH}`,
);
console.log(`  File size: ${sizeMB} MB`);
console.log(`  Total time: ${(performance.now() - t0).toFixed(0)}ms`);
