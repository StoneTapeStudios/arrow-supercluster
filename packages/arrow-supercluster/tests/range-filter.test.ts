import { describe, it, expect } from "vitest";
import {
  makeVector,
  vectorFromArray,
  Table,
  Float64,
  Int32,
  Field,
  FixedSizeList,
} from "apache-arrow";
import { ArrowClusterEngine } from "../src/index";
import { buildArrowTable, generateTestPoints } from "./test-utils";

/**
 * Build an Arrow Table with geometry + a numeric "value" column.
 */
function buildTableWithRange(
  coords: [number, number][],
  values: number[],
): Table {
  const numRows = coords.length;

  const childField = new Field("xy", new Float64());
  const listType = new FixedSizeList(2, childField);
  const geomVector = vectorFromArray(
    coords.map(([lng, lat]) => [lng, lat]),
    listType,
  );

  const ids = new Int32Array(numRows);
  for (let i = 0; i < numRows; i++) ids[i] = i;
  const idVector = makeVector(ids);

  const valueVector = makeVector(new Float64Array(values));

  return new Table({ geometry: geomVector, id: idVector, value: valueVector });
}

/**
 * Brute-force count of points in a range by walking all leaves.
 */
function bruteForceFilteredCount(
  engine: ArrowClusterEngine,
  clusterOutput: ReturnType<ArrowClusterEngine["getClusters"]>,
  idx: number,
  values: number[],
  filterRange: [number, number],
): number {
  if (clusterOutput.isCluster[idx] === 0) {
    const v = values[clusterOutput.ids[idx]];
    return v >= filterRange[0] && v <= filterRange[1] ? 1 : 0;
  }
  const leaves = engine.getLeaves(clusterOutput.ids[idx]);
  let count = 0;
  for (const leafIdx of leaves) {
    const v = values[leafIdx];
    if (v >= filterRange[0] && v <= filterRange[1]) count++;
  }
  return count;
}

describe("Range Filtering", () => {
  it("filterRange == null returns identical results to no-range engine", () => {
    const coords = generateTestPoints(300);
    const values = coords.map((_, i) => i * 10); // 0, 10, 20, ...
    const table = buildTableWithRange(coords, values);

    const engineWithRange = new ArrowClusterEngine({
      radius: 75,
      maxZoom: 16,
      minZoom: 0,
      minPoints: 2,
    });
    engineWithRange.load(table, "geometry", "id", null, "value");

    const engineWithout = new ArrowClusterEngine({
      radius: 75,
      maxZoom: 16,
      minZoom: 0,
      minPoints: 2,
    });
    engineWithout.load(table, "geometry", "id", null, null);

    const bbox: [number, number, number, number] = [-180, -85, 180, 85];
    for (let z = 0; z <= 16; z++) {
      const withRange = engineWithRange.getClusters(bbox, z, null);
      const without = engineWithout.getClusters(bbox, z);
      expect(withRange.length).toBe(without.length);

      // filteredPointCounts === pointCounts when no range
      for (let i = 0; i < withRange.length; i++) {
        expect(withRange.filteredPointCounts[i]).toBe(withRange.pointCounts[i]);
      }
    }
  });

  it("fully-in range returns rangedCount (all non-sentinel points)", () => {
    const coords = generateTestPoints(200);
    const values = coords.map((_, i) => i + 1); // 1..200
    const table = buildTableWithRange(coords, values);

    const engine = new ArrowClusterEngine({
      radius: 75,
      maxZoom: 16,
      minZoom: 0,
      minPoints: 2,
    });
    engine.load(table, "geometry", "id", null, "value");

    const bbox: [number, number, number, number] = [-180, -85, 180, 85];
    // Range that includes all values
    const output = engine.getClusters(bbox, 0, [0, 300]);

    // Every cluster should have filteredPointCounts === pointCounts
    for (let i = 0; i < output.length; i++) {
      expect(output.filteredPointCounts[i]).toBe(output.pointCounts[i]);
    }
  });

  it("fully-out range hides all clusters", () => {
    const coords = generateTestPoints(200);
    const values = coords.map((_, i) => i + 100); // 100..299
    const table = buildTableWithRange(coords, values);

    const engine = new ArrowClusterEngine({
      radius: 75,
      maxZoom: 16,
      minZoom: 0,
      minPoints: 2,
    });
    engine.load(table, "geometry", "id", null, "value");

    const bbox: [number, number, number, number] = [-180, -85, 180, 85];
    // Range that excludes all values
    const output = engine.getClusters(bbox, 0, [0, 50]);
    expect(output.length).toBe(0);
  });

  it("partial range returns correct filtered counts matching brute force", () => {
    const coords = generateTestPoints(500);
    const values = coords.map((_, i) => i); // 0..499
    const table = buildTableWithRange(coords, values);

    // Disable histograms so we get exact leaf-walk counts for this test
    const engine = new ArrowClusterEngine({
      radius: 75,
      maxZoom: 16,
      minZoom: 0,
      minPoints: 2,
      histogramBins: 0, // exact mode — no histograms
    });
    engine.load(table, "geometry", "id", null, "value");

    const bbox: [number, number, number, number] = [-180, -85, 180, 85];
    const filterRange: [number, number] = [100, 300];

    // Get unfiltered output for brute-force comparison
    const filtered = engine.getClusters(bbox, 2, filterRange);

    // Every node in filtered output should have filteredCount > 0
    for (let i = 0; i < filtered.length; i++) {
      expect(filtered.filteredPointCounts[i]).toBeGreaterThan(0);
    }

    // Verify filtered counts match brute-force exactly (no histograms → leaf-walk)
    for (let i = 0; i < filtered.length; i++) {
      const bf = bruteForceFilteredCount(
        engine,
        filtered,
        i,
        values,
        filterRange,
      );
      expect(filtered.filteredPointCounts[i]).toBe(bf);
    }
  });

  it("sentinel rows (excluded value) are never counted", () => {
    const SENTINEL = 999999;
    const coords = generateTestPoints(100);
    // Half the points get the sentinel value
    const values = coords.map((_, i) => (i % 2 === 0 ? i : SENTINEL));
    const table = buildTableWithRange(coords, values);

    const engine = new ArrowClusterEngine({
      radius: 75,
      maxZoom: 16,
      minZoom: 0,
      minPoints: 2,
      excludedValue: SENTINEL,
    });
    engine.load(table, "geometry", "id", null, "value");

    const bbox: [number, number, number, number] = [-180, -85, 180, 85];
    // Range covering all real values
    const output = engine.getClusters(bbox, 0, [0, 100]);

    // Total filtered count should be ~50 (only even indices)
    let totalFiltered = 0;
    for (let i = 0; i < output.length; i++) {
      totalFiltered += output.filteredPointCounts[i];
    }
    expect(totalFiltered).toBe(50);
  });

  it("individual points at max zoom are filtered correctly", () => {
    const coords: [number, number][] = [
      [-120, 40],
      [120, -40],
      [0, 0],
    ];
    const values = [10, 20, 30];
    const table = buildTableWithRange(coords, values);

    const engine = new ArrowClusterEngine({
      radius: 75,
      maxZoom: 16,
      minZoom: 0,
      minPoints: 2,
    });
    engine.load(table, "geometry", "id", null, "value");

    // At high zoom, all points are individual
    const output = engine.getClusters([-180, -85, 180, 85], 17, [15, 25]);
    // Only the point with value 20 should be visible
    expect(output.length).toBe(1);
    expect(output.filteredPointCounts[0]).toBe(1);
    expect(output.ids[0]).toBe(1); // index of value 20
  });

  it("getLeaves with filterRange returns only in-range leaves", () => {
    const coords = generateTestPoints(200);
    const values = coords.map((_, i) => i); // 0..199
    const table = buildTableWithRange(coords, values);

    const engine = new ArrowClusterEngine({
      radius: 75,
      maxZoom: 16,
      minZoom: 0,
      minPoints: 2,
    });
    engine.load(table, "geometry", "id", null, "value");

    const clusters = engine.getClusters([-180, -85, 180, 85], 2, null);

    for (let i = 0; i < clusters.length; i++) {
      if (clusters.isCluster[i] === 1) {
        const allLeaves = engine.getLeaves(clusters.ids[i]);
        const filteredLeaves = engine.getLeaves(
          clusters.ids[i],
          Infinity,
          0,
          [50, 150],
        );

        // All filtered leaves should have values in range
        for (const idx of filteredLeaves) {
          expect(values[idx]).toBeGreaterThanOrEqual(50);
          expect(values[idx]).toBeLessThanOrEqual(150);
        }

        // Filtered should be a subset of all
        expect(filteredLeaves.length).toBeLessThanOrEqual(allLeaves.length);
        break;
      }
    }
  });

  it("histogram path agrees with leaf-walk for large clusters", () => {
    // Use enough points to create clusters above the histogram threshold (256)
    const coords = generateTestPoints(2000);
    const values = coords.map((_, i) => i * 0.5); // 0, 0.5, 1, ...
    const table = buildTableWithRange(coords, values);

    const engine = new ArrowClusterEngine({
      radius: 150, // large radius to create big clusters
      maxZoom: 16,
      minZoom: 0,
      minPoints: 2,
      histogramBins: 64,
      histogramThreshold: 50, // low threshold to ensure histograms are built
    });
    engine.load(table, "geometry", "id", null, "value");

    const bbox: [number, number, number, number] = [-180, -85, 180, 85];
    const filterRange: [number, number] = [200, 600];

    const filtered = engine.getClusters(bbox, 0, filterRange);

    // Verify each cluster's filtered count matches brute-force
    for (let i = 0; i < filtered.length; i++) {
      const bf = bruteForceFilteredCount(
        engine,
        filtered,
        i,
        values,
        filterRange,
      );

      // Histogram counts may differ at boundary bins, but only within bin tolerance.
      // For interior ranges the count should be exact or very close.
      // With 64 bins over domain [0, 999.5], binWidth ≈ 15.6.
      // Boundary error is bounded by the population of the two edge bins.
      // For our uniform distribution: ~31 points per bin → max error ~31 per edge.
      const tolerance = Math.ceil(2000 / 64) + 1; // generous tolerance per boundary bin
      expect(filtered.filteredPointCounts[i]).toBeGreaterThanOrEqual(
        bf - tolerance,
      );
      expect(filtered.filteredPointCounts[i]).toBeLessThanOrEqual(
        bf + tolerance,
      );
    }
  });

  it("histogram vs no-histogram engines agree on fully-in/fully-out", () => {
    const coords = generateTestPoints(500);
    const values = coords.map((_, i) => i);
    const table = buildTableWithRange(coords, values);

    const withHist = new ArrowClusterEngine({
      radius: 100,
      maxZoom: 16,
      minZoom: 0,
      minPoints: 2,
      histogramBins: 128,
      histogramThreshold: 10,
    });
    withHist.load(table, "geometry", "id", null, "value");

    const noHist = new ArrowClusterEngine({
      radius: 100,
      maxZoom: 16,
      minZoom: 0,
      minPoints: 2,
      histogramBins: 0, // disable histograms
    });
    noHist.load(table, "geometry", "id", null, "value");

    const bbox: [number, number, number, number] = [-180, -85, 180, 85];

    // Fully-in range: both should return same counts
    const fullIn1 = withHist.getClusters(bbox, 2, [0, 600]);
    const fullIn2 = noHist.getClusters(bbox, 2, [0, 600]);
    expect(fullIn1.length).toBe(fullIn2.length);
    for (let i = 0; i < fullIn1.length; i++) {
      expect(fullIn1.filteredPointCounts[i]).toBe(
        fullIn2.filteredPointCounts[i],
      );
    }

    // Fully-out range: both should return empty
    const fullOut1 = withHist.getClusters(bbox, 2, [600, 700]);
    const fullOut2 = noHist.getClusters(bbox, 2, [600, 700]);
    expect(fullOut1.length).toBe(0);
    expect(fullOut2.length).toBe(0);
  });

  it("missing range column throws", () => {
    const table = buildArrowTable([[0, 0]]);
    const engine = new ArrowClusterEngine();
    expect(() => engine.load(table, "geometry", "id", null, "missing")).toThrow(
      'Range column "missing" not found',
    );
  });
});
