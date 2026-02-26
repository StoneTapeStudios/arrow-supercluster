import { describe, it, expect } from "vitest";
import { ArrowClusterEngine } from "../src/index";
import { buildArrowTable, generateTestPoints } from "./test-utils";

describe("filterMask on engine.load()", () => {
  const coords = generateTestPoints(200);
  const options = { radius: 75, minZoom: 0, maxZoom: 16, minPoints: 2 };

  it("no mask = all points indexed (backward compat)", () => {
    const engine = new ArrowClusterEngine(options);
    engine.load(buildArrowTable(coords));
    expect(engine.indexedPointCount).toBe(200);
  });

  it("null mask = all points indexed", () => {
    const engine = new ArrowClusterEngine(options);
    engine.load(buildArrowTable(coords), "geometry", "id", null);
    expect(engine.indexedPointCount).toBe(200);
  });

  it("mask excludes points from index", () => {
    const mask = new Uint8Array(200);
    // Include only the last 150 points
    for (let i = 50; i < 200; i++) mask[i] = 1;

    const engine = new ArrowClusterEngine(options);
    engine.load(buildArrowTable(coords), "geometry", "id", mask);
    expect(engine.indexedPointCount).toBe(150);
  });

  it("all-zero mask = empty index", () => {
    const mask = new Uint8Array(200); // all zeros

    const engine = new ArrowClusterEngine(options);
    engine.load(buildArrowTable(coords), "geometry", "id", mask);
    expect(engine.indexedPointCount).toBe(0);

    const result = engine.getClusters([-180, -85, 180, 85], 0);
    expect(result.length).toBe(0);
  });

  it("masked points excluded from getClusters at max zoom", () => {
    const mask = new Uint8Array(100);
    // Include only points 50-99
    for (let i = 50; i < 100; i++) mask[i] = 1;

    const smallCoords = coords.slice(0, 100);
    const engine = new ArrowClusterEngine(options);
    engine.load(buildArrowTable(smallCoords), "geometry", "id", mask);

    // At maxZoom+1, every indexed point is individual (no clustering)
    const result = engine.getClusters([-180, -85, 180, 85], 17);
    expect(result.length).toBe(50);

    // All returned IDs should be original Arrow row indices >= 50
    for (let i = 0; i < result.length; i++) {
      if (result.isCluster[i] === 0) {
        expect(result.ids[i]).toBeGreaterThanOrEqual(50);
        expect(result.ids[i]).toBeLessThan(100);
      }
    }
  });

  it("getLeaves returns only unmasked point indices", () => {
    const mask = new Uint8Array(200);
    for (let i = 0; i < 200; i++) mask[i] = 1;
    // Mask out the first 100
    for (let i = 0; i < 100; i++) mask[i] = 0;

    const engine = new ArrowClusterEngine(options);
    engine.load(buildArrowTable(coords), "geometry", "id", mask);

    const clusters = engine.getClusters([-180, -85, 180, 85], 2);
    for (let i = 0; i < clusters.length; i++) {
      if (clusters.isCluster[i] === 1) {
        const leaves = engine.getLeaves(clusters.ids[i]);
        for (const idx of leaves) {
          expect(idx).toBeGreaterThanOrEqual(100);
          expect(idx).toBeLessThan(200);
        }
        break;
      }
    }
  });

  it("filtered engine matches a manually filtered table", () => {
    // Build mask that includes only even-indexed points
    const mask = new Uint8Array(200);
    for (let i = 0; i < 200; i++) mask[i] = i % 2 === 0 ? 1 : 0;

    const maskedEngine = new ArrowClusterEngine(options);
    maskedEngine.load(buildArrowTable(coords), "geometry", "id", mask);

    // Build a table with only even-indexed points
    const evenCoords = coords.filter((_, i) => i % 2 === 0);
    const manualEngine = new ArrowClusterEngine(options);
    manualEngine.load(buildArrowTable(evenCoords));

    expect(maskedEngine.indexedPointCount).toBe(manualEngine.indexedPointCount);

    // Cluster counts should match at each zoom
    const bbox: [number, number, number, number] = [-180, -85, 180, 85];
    for (let z = 0; z <= 16; z++) {
      const maskedOut = maskedEngine.getClusters(bbox, z);
      const manualOut = manualEngine.getClusters(bbox, z);
      expect(maskedOut.length).toBe(manualOut.length);
    }
  });

  it("getClusterExpansionZoom works with mask", () => {
    const mask = new Uint8Array(200);
    for (let i = 100; i < 200; i++) mask[i] = 1;

    const engine = new ArrowClusterEngine(options);
    engine.load(buildArrowTable(coords), "geometry", "id", mask);

    const clusters = engine.getClusters([-180, -85, 180, 85], 0);
    for (let i = 0; i < clusters.length; i++) {
      if (clusters.isCluster[i] === 1) {
        const expZoom = engine.getClusterExpansionZoom(clusters.ids[i]);
        expect(expZoom).toBeGreaterThanOrEqual(0);
        expect(expZoom).toBeLessThanOrEqual(17);
        break;
      }
    }
  });
});
