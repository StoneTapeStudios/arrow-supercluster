#!/usr/bin/env npx tsx
/**
 * arrow-supercluster vs supercluster — Benchmark Suite
 *
 * Compares performance and memory across multiple dataset sizes and operations.
 * Run: pnpm bench (from packages/arrow-supercluster)
 */

import Supercluster from "supercluster";
import { ArrowClusterEngine } from "../src/index";
import {
  buildArrowTable,
  buildGeoJSON,
  generateTestPoints,
} from "../tests/test-utils";
import {
  fmt,
  fmtBytes,
  fmtDelta,
  fmtMs,
  header,
  divider,
  row,
  sectionTitle,
  sparkBar,
  colorize,
  Colors,
  tableHeader,
  tableRow,
  tableDivider,
} from "./format";

// ─── Configuration ──────────────────────────────────────────────────────────

const BASE_SIZES = [1_000, 10_000, 50_000, 100_000, 200_000];
const INCLUDE_1M = process.argv.includes("--1m");
const DATASET_SIZES = INCLUDE_1M ? [...BASE_SIZES, 1_000_000] : BASE_SIZES;
const WARMUP_RUNS = 3;
const BENCH_RUNS = 10;
const ZOOM_LEVELS = [0, 2, 4, 6, 8, 10, 12, 14, 16];
const BBOX: [number, number, number, number] = [-180, -85, 180, 85];
const ENGINE_OPTIONS = { radius: 75, minZoom: 0, maxZoom: 16, minPoints: 2 };

// ─── Types ──────────────────────────────────────────────────────────────────

interface TimingResult {
  median: number;
  mean: number;
  min: number;
  max: number;
  p95: number;
  samples: number[];
}

interface MemorySnapshot {
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

// ─── Timing Utilities ───────────────────────────────────────────────────────

function measure(fn: () => void, runs: number, warmup: number): TimingResult {
  // Warmup
  for (let i = 0; i < warmup; i++) fn();

  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }

  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p95 = samples[Math.floor(samples.length * 0.95)];

  return {
    median,
    mean,
    min: samples[0],
    max: samples[samples.length - 1],
    p95,
    samples,
  };
}

function snapshotMemory(): MemorySnapshot {
  global.gc?.();
  const mem = process.memoryUsage();
  return {
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
  };
}

// ─── Benchmark Runners ──────────────────────────────────────────────────────

function benchmarkDataPrep(points: [number, number][]) {
  const geojsonTime = measure(
    () => {
      buildGeoJSON(points);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );
  const arrowTime = measure(
    () => {
      buildArrowTable(points);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );
  return { geojsonTime, arrowTime };
}

function benchmarkLoad(points: [number, number][]) {
  const geojson = buildGeoJSON(points);
  const arrowTable = buildArrowTable(points);

  const scTime = measure(
    () => {
      const sc = new Supercluster(ENGINE_OPTIONS);
      sc.load(geojson);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  const engineTime = measure(
    () => {
      const engine = new ArrowClusterEngine(ENGINE_OPTIONS);
      engine.load(arrowTable);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  return { scTime, engineTime };
}

function benchmarkQuery(points: [number, number][]) {
  const geojson = buildGeoJSON(points);
  const arrowTable = buildArrowTable(points);

  const sc = new Supercluster(ENGINE_OPTIONS);
  sc.load(geojson);

  const engine = new ArrowClusterEngine(ENGINE_OPTIONS);
  engine.load(arrowTable);

  const results: {
    zoom: number;
    scTime: TimingResult;
    engineTime: TimingResult;
    clusterCount: number;
  }[] = [];

  for (const zoom of ZOOM_LEVELS) {
    const scTime = measure(
      () => {
        sc.getClusters(BBOX, zoom);
      },
      BENCH_RUNS,
      WARMUP_RUNS,
    );
    const engineTime = measure(
      () => {
        engine.getClusters(BBOX, zoom);
      },
      BENCH_RUNS,
      WARMUP_RUNS,
    );
    const output = engine.getClusters(BBOX, zoom);
    results.push({ zoom, scTime, engineTime, clusterCount: output.length });
  }

  return results;
}

function benchmarkMemory(points: [number, number][]) {
  // ── Measure GeoJSON input + Supercluster (full pipeline) ──
  global.gc?.();
  const scPipelineBefore = snapshotMemory();
  const geojson = buildGeoJSON(points);
  const sc = new Supercluster(ENGINE_OPTIONS);
  sc.load(geojson);
  void sc.getClusters(BBOX, 0);
  const scPipelineAfter = snapshotMemory();

  // Force references to stay alive until after measurement
  const _scRef = { sc, geojson };

  // ── Measure Arrow input + Engine (full pipeline) ──
  global.gc?.();
  const enginePipelineBefore = snapshotMemory();
  const arrowTable = buildArrowTable(points);
  const engine = new ArrowClusterEngine(ENGINE_OPTIONS);
  engine.load(arrowTable);
  void engine.getClusters(BBOX, 0);
  const enginePipelineAfter = snapshotMemory();

  const _engineRef = { engine, arrowTable };

  const scTotal =
    scPipelineAfter.heapUsed -
    scPipelineBefore.heapUsed +
    (scPipelineAfter.external - scPipelineBefore.external) +
    (scPipelineAfter.arrayBuffers - scPipelineBefore.arrayBuffers);

  const engineTotal =
    enginePipelineAfter.heapUsed -
    enginePipelineBefore.heapUsed +
    (enginePipelineAfter.external - enginePipelineBefore.external) +
    (enginePipelineAfter.arrayBuffers - enginePipelineBefore.arrayBuffers);

  // Keep refs alive past measurement
  void _scRef;
  void _engineRef;

  return { scTotal, engineTotal };
}

function benchmarkFilterMask(points: [number, number][]) {
  const arrowTable = buildArrowTable(points);
  const numPoints = points.length;

  // Measure mask build time (simulates iterating a string column)
  const maskBuildTime = measure(
    () => {
      const mask = new Uint8Array(numPoints);
      for (let i = 0; i < numPoints; i++) {
        mask[i] = i % 2 === 0 ? 1 : 0; // 50% filter
      }
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  // Measure load with no mask (baseline)
  const noMaskTime = measure(
    () => {
      const engine = new ArrowClusterEngine(ENGINE_OPTIONS);
      engine.load(arrowTable);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  // Measure load with 50% mask
  const mask50 = new Uint8Array(numPoints);
  for (let i = 0; i < numPoints; i++) mask50[i] = i % 2 === 0 ? 1 : 0;

  const mask50Time = measure(
    () => {
      const engine = new ArrowClusterEngine(ENGINE_OPTIONS);
      engine.load(arrowTable, "geometry", "id", mask50);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  // Measure load with 10% mask
  const mask10 = new Uint8Array(numPoints);
  for (let i = 0; i < numPoints; i++) mask10[i] = i % 10 === 0 ? 1 : 0;

  const mask10Time = measure(
    () => {
      const engine = new ArrowClusterEngine(ENGINE_OPTIONS);
      engine.load(arrowTable, "geometry", "id", mask10);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  // Verify indexedPointCount
  const engine50 = new ArrowClusterEngine(ENGINE_OPTIONS);
  engine50.load(arrowTable, "geometry", "id", mask50);

  const engine10 = new ArrowClusterEngine(ENGINE_OPTIONS);
  engine10.load(arrowTable, "geometry", "id", mask10);

  return {
    maskBuildTime,
    noMaskTime,
    mask50Time,
    mask10Time,
    indexed50: engine50.indexedPointCount,
    indexed10: engine10.indexedPointCount,
  };
}

function benchmarkDataSize(points: [number, number][]) {
  const geojson = buildGeoJSON(points);
  const arrowTable = buildArrowTable(points);

  const geojsonStr = JSON.stringify({
    type: "FeatureCollection",
    features: geojson,
  });
  const geojsonBytes = Buffer.byteLength(geojsonStr, "utf-8");

  // Estimate Arrow table size from coordinate buffer + overhead
  const coordBytes = points.length * 2 * 8; // Float64 × 2 coords
  const idBytes = points.length * 4; // Int32
  const arrowOverhead = 1024; // schema, metadata, etc.
  const arrowBytes = coordBytes + idBytes + arrowOverhead;

  return { geojsonBytes, arrowBytes };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const hasGC = typeof global.gc === "function";

  console.log("");
  header("arrow-supercluster  vs  supercluster");
  console.log("");
  console.log(colorize("  Benchmark Configuration", Colors.dim));
  console.log(
    colorize(
      `  ├─ Dataset sizes:  ${DATASET_SIZES.map(fmt).join(", ")} points`,
      Colors.dim,
    ),
  );
  console.log(
    colorize(
      `  ├─ Bench runs:     ${BENCH_RUNS} (${WARMUP_RUNS} warmup)`,
      Colors.dim,
    ),
  );
  console.log(
    colorize(`  ├─ Zoom levels:    ${ZOOM_LEVELS.join(", ")}`, Colors.dim),
  );
  console.log(
    colorize(`  ├─ Cluster radius: ${ENGINE_OPTIONS.radius}px`, Colors.dim),
  );
  console.log(
    colorize(
      `  └─ GC exposed:     ${hasGC ? "yes" : "no (run with --expose-gc for memory benchmarks)"}`,
      Colors.dim,
    ),
  );
  console.log("");

  if (!hasGC) {
    console.log(
      colorize(
        "  ⚠  Memory benchmarks will be approximate without --expose-gc",
        Colors.yellow,
      ),
    );
    console.log("");
  }

  // ── 1. Data Serialization Size ──────────────────────────────────────────

  sectionTitle("1", "Data Serialization Size");
  console.log("");
  tableHeader(["Points", "GeoJSON", "Arrow (est.)", "Reduction"]);

  for (const size of DATASET_SIZES) {
    const points = generateTestPoints(size);
    const { geojsonBytes, arrowBytes } = benchmarkDataSize(points);
    const reduction = ((1 - arrowBytes / geojsonBytes) * 100).toFixed(1);
    tableRow([
      fmt(size),
      fmtBytes(geojsonBytes),
      fmtBytes(arrowBytes),
      colorize(`${reduction}% smaller`, Colors.green),
    ]);
  }
  tableDivider();
  console.log("");

  // ── 2. Index Build (load) ───────────────────────────────────────────────

  sectionTitle("2", "Index Build Time  (load)");
  console.log("");
  tableHeader(["Points", "Supercluster", "Arrow Engine", "Speedup"]);

  for (const size of DATASET_SIZES) {
    const points = generateTestPoints(size);
    const { scTime, engineTime } = benchmarkLoad(points);
    const speedup = scTime.median / engineTime.median;
    tableRow([
      fmt(size),
      fmtMs(scTime.median),
      fmtMs(engineTime.median),
      fmtDelta(speedup),
    ]);
  }
  tableDivider();
  console.log("");

  // ── 3. Query Performance by Zoom ────────────────────────────────────────

  sectionTitle("3", "Query Performance by Zoom Level");

  for (const size of [
    10_000,
    100_000,
    200_000,
    ...(INCLUDE_1M ? [1_000_000] : []),
  ]) {
    if (!DATASET_SIZES.includes(size)) continue;
    console.log("");
    console.log(colorize(`  ${fmt(size)} points`, Colors.cyan));
    console.log("");
    tableHeader(["Zoom", "SC (ms)", "Arrow (ms)", "Speedup", "Clusters", ""]);

    const points = generateTestPoints(size);
    const queryResults = benchmarkQuery(points);

    // Normalize bars against the max speedup so the full arc is visible
    const speedups = queryResults.map(
      (r) => r.scTime.median / r.engineTime.median,
    );
    const maxSpeedup = Math.max(...speedups);

    for (let idx = 0; idx < queryResults.length; idx++) {
      const r = queryResults[idx];
      const speedup = speedups[idx];
      const barLen = Math.max(1, Math.round((speedup / maxSpeedup) * 20));
      tableRow([
        `z${String(r.zoom).padStart(2)}`,
        fmtMs(r.scTime.median),
        fmtMs(r.engineTime.median),
        fmtDelta(speedup),
        fmt(r.clusterCount),
        sparkBar(barLen, 20),
      ]);
    }
    tableDivider();
  }
  console.log("");

  // ── 4. Memory Usage ─────────────────────────────────────────────────────

  sectionTitle("4", "Memory Usage  (full pipeline: input data + index build)");
  console.log("");
  tableHeader(["Points", "GeoJSON + SC", "Arrow + Engine", "Reduction"]);

  for (const size of DATASET_SIZES) {
    const points = generateTestPoints(size);
    const mem = benchmarkMemory(points);
    const reduction =
      mem.scTotal > 0
        ? ((1 - mem.engineTotal / mem.scTotal) * 100).toFixed(1)
        : "N/A";
    tableRow([
      fmt(size),
      fmtBytes(Math.abs(mem.scTotal)),
      fmtBytes(Math.abs(mem.engineTotal)),
      typeof reduction === "string" && reduction !== "N/A"
        ? colorize(
            `${reduction}% less`,
            Number(reduction) > 0 ? Colors.green : Colors.red,
          )
        : colorize(String(reduction), Colors.dim),
    ]);
  }
  tableDivider();
  console.log("");

  // ── 5. Data Preparation ─────────────────────────────────────────────────

  sectionTitle("5", "Data Preparation Time  (build input from coords)");
  console.log("");
  tableHeader(["Points", "GeoJSON Build", "Arrow Build", "Speedup"]);

  for (const size of DATASET_SIZES) {
    const points = generateTestPoints(size);
    const { geojsonTime, arrowTime } = benchmarkDataPrep(points);
    const speedup = geojsonTime.median / arrowTime.median;
    tableRow([
      fmt(size),
      fmtMs(geojsonTime.median),
      fmtMs(arrowTime.median),
      fmtDelta(speedup),
    ]);
  }
  tableDivider();
  console.log("");

  // ── 6. filterMask Performance ─────────────────────────────────────────

  sectionTitle("6", "filterMask Performance  (load with filtered subsets)");
  console.log("");
  console.log(
    colorize(
      "  Compares engine.load() with no mask vs 50% and 10% masks.",
      Colors.dim,
    ),
  );
  console.log(
    colorize(
      "  KDBush build dominates — fewer points = faster load.",
      Colors.dim,
    ),
  );
  console.log("");
  tableHeader(["Points", "No Mask", "50% Mask", "10% Mask", "Mask Build"]);

  for (const size of DATASET_SIZES) {
    const points = generateTestPoints(size);
    const fm = benchmarkFilterMask(points);
    tableRow([
      fmt(size),
      fmtMs(fm.noMaskTime.median),
      fmtMs(fm.mask50Time.median),
      fmtMs(fm.mask10Time.median),
      fmtMs(fm.maskBuildTime.median),
    ]);
  }
  tableDivider();
  console.log("");

  // Verify indexed counts for the largest dataset
  {
    const largestSize = DATASET_SIZES[DATASET_SIZES.length - 1];
    const points = generateTestPoints(largestSize);
    const fm = benchmarkFilterMask(points);
    console.log(
      colorize(
        `  Indexed counts at ${fmt(largestSize)} points:  ` +
          `50% mask → ${fmt(fm.indexed50)},  ` +
          `10% mask → ${fmt(fm.indexed10)}`,
        Colors.dim,
      ),
    );
    console.log("");
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  divider();
  console.log("");
  console.log(colorize("  Summary", Colors.bold));
  console.log("");

  // Run a final 200k comparison for the summary
  const summarySize = DATASET_SIZES[DATASET_SIZES.length - 1];
  const summaryPoints = generateTestPoints(summarySize);
  const summaryLoad = benchmarkLoad(summaryPoints);
  const summaryMem = benchmarkMemory(summaryPoints);
  const summaryData = benchmarkDataSize(summaryPoints);
  const summaryQuery = benchmarkQuery(summaryPoints);

  const avgQuerySpeedup =
    summaryQuery.reduce(
      (acc, r) => acc + r.scTime.median / r.engineTime.median,
      0,
    ) / summaryQuery.length;
  const loadSpeedup = summaryLoad.scTime.median / summaryLoad.engineTime.median;
  const scMem = summaryMem.scTotal;
  const engineMem = summaryMem.engineTotal;
  const memReduction =
    scMem > 0 ? ((1 - engineMem / scMem) * 100).toFixed(0) : "?";
  const dataReduction = (
    (1 - summaryData.arrowBytes / summaryData.geojsonBytes) *
    100
  ).toFixed(0);

  console.log(colorize(`  At ${fmt(summarySize)} points:`, Colors.dim));
  console.log(
    `  ${colorize("●", Colors.green)} Load time:       ${fmtDelta(loadSpeedup)}`,
  );
  console.log(
    `  ${colorize("●", Colors.green)} Avg query time:  ${fmtDelta(avgQuerySpeedup)}`,
  );
  console.log(
    `  ${colorize("●", Colors.green)} Memory:          ${memReduction}% reduction`,
  );
  console.log(
    `  ${colorize("●", Colors.green)} Wire size:       ${dataReduction}% smaller (Arrow vs GeoJSON)`,
  );
  console.log("");
  divider();
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
