#!/usr/bin/env npx tsx
/**
 * Generate GeoParquet files with synthetic points at multiple sizes.
 *
 * Produces valid GeoParquet v1.1.0 files using native GeoArrow point encoding
 * (FixedSizeList[2] of Float64). This is the exact format that ArrowClusterEngine
 * expects — when read back via parquet-wasm + tableFromIPC, the geometry column
 * is directly consumable with zero conversion.
 *
 * Usage:
 *   pnpm --filter arrow-cluster-layer-example generate-data
 *
 * Output:
 *   examples/basic/public/data/points-200k.parquet
 *   examples/basic/public/data/points-1m.parquet
 *   examples/basic/public/data/points-2m.parquet
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

const DATASETS: { name: string; count: number }[] = [
  { name: "points-200k", count: 200_000 },
  { name: "points-1m", count: 1_000_000 },
  { name: "points-2m", count: 2_000_000 },
];

const OUTPUT_DIR = resolve(import.meta.dirname ?? ".", "../public/data");

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

// ─── Generate and write a single dataset ────────────────────────────────────

function generateDataset(numPoints: number, name: string) {
  const outputPath = resolve(OUTPUT_DIR, `${name}.parquet`);

  console.log(`\nGenerating ${name} (${numPoints.toLocaleString()} points)...`);
  const t0 = performance.now();

  const rand = seededRandom(42);
  const coords: [number, number][] = new Array(numPoints);
  const cityNames: string[] = new Array(numPoints);

  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;

  for (let i = 0; i < numPoints; i++) {
    const cityIdx = Math.floor(rand() * CITY_CENTERS.length);
    const [cLng, cLat, cityName] = CITY_CENTERS[cityIdx];

    const [dx, dy] = gaussianPair(rand);
    const spread = 1.5;
    const lng = cLng + dx * spread;
    const lat = Math.max(-85, Math.min(85, cLat + dy * spread));

    coords[i] = [lng, lat];
    cityNames[i] = cityName;

    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  console.log(`  Points generated in ${(performance.now() - t0).toFixed(0)}ms`);

  // Build Arrow Table
  const t1 = performance.now();

  const childField = new Field("xy", new Float64());
  const listType = new FixedSizeList(2, childField);
  const geomVector = vectorFromArray(coords, listType);

  const ids = new Int32Array(numPoints);
  for (let i = 0; i < numPoints; i++) ids[i] = i;
  const idVector = makeVector(ids);

  const cityVector = vectorFromArray(cityNames, new Utf8());

  const table = new Table({
    geometry: geomVector,
    id: idVector,
    city: cityVector,
  });

  console.log(
    `  Arrow Table built in ${(performance.now() - t1).toFixed(0)}ms` +
      ` (${table.numRows.toLocaleString()} rows)`,
  );

  // Write GeoParquet
  const t2 = performance.now();

  const ipcBuffer = tableToIPC(table, "stream");
  const wasmTable = WasmTable.fromIPCStream(ipcBuffer);

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

  const writerProps = new WriterPropertiesBuilder()
    .setCompression(Compression.ZSTD)
    .setMaxRowGroupSize(numPoints)
    .setKeyValueMetadata(new Map([["geo", geoMetadata]]))
    .build();

  const parquetBytes = writeParquet(wasmTable, writerProps);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, parquetBytes);

  const sizeMB = (parquetBytes.byteLength / (1024 * 1024)).toFixed(2);
  console.log(
    `  Written in ${(performance.now() - t2).toFixed(0)}ms → ${outputPath}`,
  );
  console.log(`  File size: ${sizeMB} MB`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

const totalStart = performance.now();

for (const { name, count } of DATASETS) {
  generateDataset(count, name);
}

console.log(
  `\nAll datasets generated in ${(performance.now() - totalStart).toFixed(0)}ms`,
);
