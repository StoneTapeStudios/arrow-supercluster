#!/usr/bin/env npx tsx
/**
 * Full Pipeline Benchmark — End-to-End Comparison
 *
 * Measures the REAL cost: serialize → transfer (wire size) → deserialize → load → query
 *
 * GeoJSON pipeline:  coords → JSON.stringify → (wire) → JSON.parse → Supercluster.load → query
 * Arrow pipeline:    coords → Arrow IPC serialize → (wire) → IPC deserialize → Engine.load → query
 *
 * Run: pnpm bench:pipeline (from packages/arrow-supercluster)
 */

import Supercluster from "supercluster";
import { tableToIPC, tableFromIPC } from "apache-arrow";
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
const QUERY_ZOOM = 6; // Mid-zoom where heavy clustering occurs — the interesting case
const BBOX: [number, number, number, number] = [-180, -85, 180, 85];
const ENGINE_OPTIONS = { radius: 75, minZoom: 0, maxZoom: 16, minPoints: 2 };

// ─── Types ──────────────────────────────────────────────────────────────────

interface TimingResult {
  median: number;
  mean: number;
  min: number;
  max: number;
  samples: number[];
}

// ─── Timing Utilities ───────────────────────────────────────────────────────

function measure(fn: () => void, runs: number, warmup: number): TimingResult {
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

  return {
    median,
    mean,
    min: samples[0],
    max: samples[samples.length - 1],
    samples,
  };
}

// ─── Pipeline Steps ─────────────────────────────────────────────────────────

/**
 * Serialize: coords → wire format bytes
 */
function benchSerialize(points: [number, number][]) {
  // GeoJSON: build features then JSON.stringify
  const geojsonTime = measure(
    () => {
      const features = buildGeoJSON(points);
      JSON.stringify({ type: "FeatureCollection", features });
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  // Arrow: build table then serialize to IPC stream
  const arrowTime = measure(
    () => {
      const table = buildArrowTable(points);
      tableToIPC(table, "stream");
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  return { geojsonTime, arrowTime };
}

/**
 * Wire size: serialized byte count
 */
function measureWireSize(points: [number, number][]) {
  const features = buildGeoJSON(points);
  const geojsonStr = JSON.stringify({ type: "FeatureCollection", features });
  const geojsonBytes = Buffer.byteLength(geojsonStr, "utf-8");

  const table = buildArrowTable(points);
  const ipcBuffer = tableToIPC(table, "stream");
  const arrowBytes = ipcBuffer.byteLength;

  return { geojsonBytes, arrowBytes };
}

/**
 * Deserialize: wire bytes → usable in-memory structure
 */
function benchDeserialize(points: [number, number][]) {
  // Pre-serialize both formats
  const features = buildGeoJSON(points);
  const geojsonStr = JSON.stringify({ type: "FeatureCollection", features });

  const table = buildArrowTable(points);
  const ipcBuffer = tableToIPC(table, "stream");

  // GeoJSON: JSON.parse → extract features array
  const geojsonTime = measure(
    () => {
      const parsed = JSON.parse(geojsonStr);
      void parsed.features;
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  // Arrow: IPC buffer → Table
  const arrowTime = measure(
    () => {
      tableFromIPC(ipcBuffer);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  return { geojsonTime, arrowTime };
}

/**
 * Full pipeline: serialize → deserialize → engine load → single query
 */
function benchFullPipeline(points: [number, number][]) {
  // ── GeoJSON pipeline ──
  // Pre-build the serialized form (simulating server-side)
  const features = buildGeoJSON(points);
  const geojsonStr = JSON.stringify({ type: "FeatureCollection", features });

  const geojsonTime = measure(
    () => {
      // 1. Deserialize
      const parsed = JSON.parse(geojsonStr);
      // 2. Load into Supercluster
      const sc = new Supercluster(ENGINE_OPTIONS);
      sc.load(parsed.features);
      // 3. Query
      sc.getClusters(BBOX, QUERY_ZOOM);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  // ── Arrow pipeline ──
  const table = buildArrowTable(points);
  const ipcBuffer = tableToIPC(table, "stream");

  const arrowTime = measure(
    () => {
      // 1. Deserialize
      const t = tableFromIPC(ipcBuffer);
      // 2. Load into ArrowClusterEngine
      const engine = new ArrowClusterEngine(ENGINE_OPTIONS);
      engine.load(t);
      // 3. Query
      engine.getClusters(BBOX, QUERY_ZOOM);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  return { geojsonTime, arrowTime };
}

/**
 * Breakdown: measure each pipeline stage independently for a given size
 */
function benchPipelineBreakdown(points: [number, number][]) {
  // Pre-build serialized forms
  const features = buildGeoJSON(points);
  const geojsonStr = JSON.stringify({ type: "FeatureCollection", features });
  const table = buildArrowTable(points);
  const ipcBuffer = tableToIPC(table, "stream");

  // Stage 1: Deserialize
  const scDeserialize = measure(
    () => {
      JSON.parse(geojsonStr);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );
  const arrowDeserialize = measure(
    () => {
      tableFromIPC(ipcBuffer);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  // Stage 2: Engine load (from already-deserialized data)
  const parsedFeatures = JSON.parse(geojsonStr).features;
  const arrowTable = tableFromIPC(ipcBuffer);

  const scLoad = measure(
    () => {
      const sc = new Supercluster(ENGINE_OPTIONS);
      sc.load(parsedFeatures);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );
  const arrowLoad = measure(
    () => {
      const engine = new ArrowClusterEngine(ENGINE_OPTIONS);
      engine.load(arrowTable);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  // Stage 3: Query (from already-loaded engines)
  const sc = new Supercluster(ENGINE_OPTIONS);
  sc.load(parsedFeatures);
  const engine = new ArrowClusterEngine(ENGINE_OPTIONS);
  engine.load(arrowTable);

  const scQuery = measure(
    () => {
      sc.getClusters(BBOX, QUERY_ZOOM);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );
  const arrowQuery = measure(
    () => {
      engine.getClusters(BBOX, QUERY_ZOOM);
    },
    BENCH_RUNS,
    WARMUP_RUNS,
  );

  return {
    deserialize: { sc: scDeserialize, arrow: arrowDeserialize },
    load: { sc: scLoad, arrow: arrowLoad },
    query: { sc: scQuery, arrow: arrowQuery },
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const hasGC = typeof global.gc === "function";

  console.log("");
  header("Full Pipeline Benchmark  —  End-to-End");
  console.log("");
  console.log(
    colorize(
      "  GeoJSON:  stringify → (wire) → JSON.parse → Supercluster.load → query",
      Colors.dim,
    ),
  );
  console.log(
    colorize(
      "  Arrow:    IPC serialize → (wire) → tableFromIPC → Engine.load → query",
      Colors.dim,
    ),
  );
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
    colorize(
      `  ├─ Query zoom:     z${QUERY_ZOOM} (mid-zoom, heavy clustering)`,
      Colors.dim,
    ),
  );
  console.log(
    colorize(`  ├─ Cluster radius: ${ENGINE_OPTIONS.radius}px`, Colors.dim),
  );
  console.log(
    colorize(`  └─ GC exposed:     ${hasGC ? "yes" : "no"}`, Colors.dim),
  );
  console.log("");

  // ── 1. Wire Size ────────────────────────────────────────────────────────

  sectionTitle("1", "Wire Size  (serialized bytes)");
  console.log("");
  tableHeader(["Points", "GeoJSON", "Arrow IPC", "Reduction", "", ""]);

  for (const size of DATASET_SIZES) {
    const points = generateTestPoints(size);
    const { geojsonBytes, arrowBytes } = measureWireSize(points);
    const reduction = ((1 - arrowBytes / geojsonBytes) * 100).toFixed(1);
    const barLen = Math.max(1, Math.round(Number(reduction) / 5));
    tableRow([
      fmt(size),
      fmtBytes(geojsonBytes),
      fmtBytes(arrowBytes),
      colorize(`${reduction}% smaller`, Colors.green),
      sparkBar(barLen, 20),
      "",
    ]);
  }
  tableDivider();
  console.log("");

  // ── 2. Serialization ───────────────────────────────────────────────────

  sectionTitle("2", "Serialization Time  (coords → wire bytes)");
  console.log("");
  tableHeader(["Points", "GeoJSON", "Arrow IPC", "Speedup", "", ""]);

  for (const size of DATASET_SIZES) {
    const points = generateTestPoints(size);
    const { geojsonTime, arrowTime } = benchSerialize(points);
    const speedup = geojsonTime.median / arrowTime.median;
    tableRow([
      fmt(size),
      fmtMs(geojsonTime.median),
      fmtMs(arrowTime.median),
      fmtDelta(speedup),
      "",
      "",
    ]);
  }
  tableDivider();
  console.log("");

  // ── 3. Deserialization ─────────────────────────────────────────────────

  sectionTitle("3", "Deserialization Time  (wire bytes → in-memory)");
  console.log("");
  tableHeader(["Points", "JSON.parse", "tableFromIPC", "Speedup", "", ""]);

  for (const size of DATASET_SIZES) {
    const points = generateTestPoints(size);
    const { geojsonTime, arrowTime } = benchDeserialize(points);
    const speedup = geojsonTime.median / arrowTime.median;
    tableRow([
      fmt(size),
      fmtMs(geojsonTime.median),
      fmtMs(arrowTime.median),
      fmtDelta(speedup),
      "",
      "",
    ]);
  }
  tableDivider();
  console.log("");

  // ── 4. Full Pipeline (end-to-end) ──────────────────────────────────────

  sectionTitle(
    "4",
    "Full Pipeline  (deserialize → load → query @ z" + QUERY_ZOOM + ")",
  );
  console.log("");
  tableHeader(["Points", "GeoJSON", "Arrow", "Speedup", "", ""]);

  const pipelineSpeedups: { size: number; speedup: number }[] = [];

  for (const size of DATASET_SIZES) {
    const points = generateTestPoints(size);
    const { geojsonTime, arrowTime } = benchFullPipeline(points);
    const speedup = geojsonTime.median / arrowTime.median;
    pipelineSpeedups.push({ size, speedup });
    tableRow([
      fmt(size),
      fmtMs(geojsonTime.median),
      fmtMs(arrowTime.median),
      fmtDelta(speedup),
      "",
      "",
    ]);
  }
  tableDivider();
  console.log("");

  // ── 5. Pipeline Breakdown (largest dataset) ────────────────────────────

  const breakdownSize = DATASET_SIZES[DATASET_SIZES.length - 1];
  sectionTitle("5", `Pipeline Breakdown  (${fmt(breakdownSize)} points)`);
  console.log("");
  console.log(colorize("  Where the time goes — stage by stage", Colors.dim));
  console.log("");
  tableHeader(["Stage", "Supercluster", "Arrow", "Speedup", "", ""]);

  const breakdownPoints = generateTestPoints(breakdownSize);
  const breakdown = benchPipelineBreakdown(breakdownPoints);

  // Deserialize
  const deserSpeedup =
    breakdown.deserialize.sc.median / breakdown.deserialize.arrow.median;
  tableRow([
    "Deserialize",
    fmtMs(breakdown.deserialize.sc.median),
    fmtMs(breakdown.deserialize.arrow.median),
    fmtDelta(deserSpeedup),
    "",
    "",
  ]);

  // Load
  const loadSpeedup = breakdown.load.sc.median / breakdown.load.arrow.median;
  tableRow([
    "Engine load",
    fmtMs(breakdown.load.sc.median),
    fmtMs(breakdown.load.arrow.median),
    fmtDelta(loadSpeedup),
    "",
    "",
  ]);

  // Query
  const querySpeedup = breakdown.query.sc.median / breakdown.query.arrow.median;
  tableRow([
    "Query (z" + QUERY_ZOOM + ")",
    fmtMs(breakdown.query.sc.median),
    fmtMs(breakdown.query.arrow.median),
    fmtDelta(querySpeedup),
    "",
    "",
  ]);

  // Total
  const scTotal =
    breakdown.deserialize.sc.median +
    breakdown.load.sc.median +
    breakdown.query.sc.median;
  const arrowTotal =
    breakdown.deserialize.arrow.median +
    breakdown.load.arrow.median +
    breakdown.query.arrow.median;
  const totalSpeedup = scTotal / arrowTotal;

  tableRow([
    colorize("Total", Colors.bold),
    colorize(fmtMs(scTotal), Colors.bold),
    colorize(fmtMs(arrowTotal), Colors.bold),
    fmtDelta(totalSpeedup),
    "",
    "",
  ]);
  tableDivider();
  console.log("");

  // ── 6. Percentage breakdown (stacked bar) ─────────────────────────────

  sectionTitle("6", `Time Distribution  (${fmt(breakdownSize)} points)`);
  console.log("");

  const scPcts = [
    {
      label: "Deserialize",
      pct: (breakdown.deserialize.sc.median / scTotal) * 100,
    },
    { label: "Engine load", pct: (breakdown.load.sc.median / scTotal) * 100 },
    { label: "Query", pct: (breakdown.query.sc.median / scTotal) * 100 },
  ];
  const arrowPcts = [
    {
      label: "Deserialize",
      pct: (breakdown.deserialize.arrow.median / arrowTotal) * 100,
    },
    {
      label: "Engine load",
      pct: (breakdown.load.arrow.median / arrowTotal) * 100,
    },
    { label: "Query", pct: (breakdown.query.arrow.median / arrowTotal) * 100 },
  ];

  const BAR_WIDTH = 40;

  console.log(colorize("  GeoJSON + Supercluster", Colors.dim));
  const scBar = scPcts.map((s) => {
    const w = Math.max(1, Math.round((s.pct / 100) * BAR_WIDTH));
    return { ...s, w };
  });
  console.log(
    "  " +
      colorize("█".repeat(scBar[0].w), Colors.yellow) +
      colorize("█".repeat(scBar[1].w), Colors.blue) +
      colorize("█".repeat(scBar[2].w), Colors.green) +
      "  " +
      fmtMs(scTotal),
  );
  console.log(
    colorize(
      `  ${scPcts.map((s) => `${s.label}: ${s.pct.toFixed(0)}%`).join("  ·  ")}`,
      Colors.dim,
    ),
  );
  console.log("");

  console.log(colorize("  Arrow + Engine", Colors.dim));
  const arrowBar = arrowPcts.map((s) => {
    const w = Math.max(1, Math.round((s.pct / 100) * BAR_WIDTH));
    return { ...s, w };
  });
  console.log(
    "  " +
      colorize("█".repeat(arrowBar[0].w), Colors.yellow) +
      colorize("█".repeat(arrowBar[1].w), Colors.blue) +
      colorize("█".repeat(arrowBar[2].w), Colors.green) +
      "  " +
      fmtMs(arrowTotal),
  );
  console.log(
    colorize(
      `  ${arrowPcts.map((s) => `${s.label}: ${s.pct.toFixed(0)}%`).join("  ·  ")}`,
      Colors.dim,
    ),
  );
  console.log("");

  console.log(
    colorize("  Legend: ", Colors.dim) +
      colorize("█ Deserialize", Colors.yellow) +
      "  " +
      colorize("█ Engine load", Colors.blue) +
      "  " +
      colorize("█ Query", Colors.green),
  );
  console.log("");

  // ── Summary ────────────────────────────────────────────────────────────

  divider();
  console.log("");
  console.log(colorize("  Summary", Colors.bold));
  console.log("");

  const summaryWire = measureWireSize(breakdownPoints);
  const wireReduction = (
    (1 - summaryWire.arrowBytes / summaryWire.geojsonBytes) *
    100
  ).toFixed(0);

  console.log(
    colorize(
      `  Full pipeline at ${fmt(breakdownSize)} points (deserialize → load → query @ z${QUERY_ZOOM}):`,
      Colors.dim,
    ),
  );
  console.log(
    `  ${colorize("●", Colors.green)} Wire size:       ${wireReduction}% smaller (${fmtBytes(summaryWire.geojsonBytes)} → ${fmtBytes(summaryWire.arrowBytes)})`,
  );
  console.log(
    `  ${colorize("●", Colors.green)} Deserialize:     ${fmtDelta(deserSpeedup)}`,
  );
  console.log(
    `  ${colorize("●", Colors.green)} Engine load:     ${fmtDelta(loadSpeedup)}`,
  );
  console.log(
    `  ${colorize("●", Colors.green)} Query (z${QUERY_ZOOM}):      ${fmtDelta(querySpeedup)}`,
  );
  console.log(
    `  ${colorize("●", Colors.green)} End-to-end:      ${fmtDelta(totalSpeedup)}`,
  );
  console.log("");
  divider();
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
