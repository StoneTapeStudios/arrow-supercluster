import { describe, it, expect } from "vitest";
import { ArrowClusterEngine } from "../src/index";
import { getCoordBuffer } from "../src/arrow-helpers";
import {
  buildArrowTable,
  buildMultiChunkArrowTable,
  generateTestPoints,
} from "./test-utils";

describe("Multi-Chunk getCoordBuffer", () => {
  it("single-chunk returns a zero-copy view (not a full copy)", () => {
    const table = buildArrowTable([
      [10, 20],
      [30, 40],
    ]);
    const geomCol = table.getChild("geometry")!;
    const buf = getCoordBuffer({ geomCol });

    // Should contain the correct values
    expect(buf[0]).toBe(10);
    expect(buf[1]).toBe(20);
    expect(buf[2]).toBe(30);
    expect(buf[3]).toBe(40);
    expect(buf.length).toBe(4);

    // Should share the same underlying ArrayBuffer as the Arrow internals
    // (subarray, not a copy)
    const internalValues = geomCol.data[0].children[0].values;
    expect(buf.buffer).toBe(internalValues.buffer);
  });

  it("multi-chunk table produces same coord values as single-chunk", () => {
    const coords = generateTestPoints(1000);
    const singleChunk = buildArrowTable(coords);
    const multiChunk = buildMultiChunkArrowTable(coords, 3);

    // Verify we actually have multiple chunks
    expect(multiChunk.getChild("geometry")!.data.length).toBe(3);
    expect(multiChunk.numRows).toBe(coords.length);

    const singleBuf = getCoordBuffer({
      geomCol: singleChunk.getChild("geometry")!,
    });
    const multiBuf = getCoordBuffer({
      geomCol: multiChunk.getChild("geometry")!,
    });

    expect(multiBuf.length).toBe(singleBuf.length);
    for (let i = 0; i < singleBuf.length; i++) {
      expect(multiBuf[i]).toBe(singleBuf[i]);
    }
  });

  it("empty table returns empty Float64Array", () => {
    const table = buildArrowTable([]);
    const geomCol = table.getChild("geometry")!;
    const buf = getCoordBuffer({ geomCol });
    expect(buf).toBeInstanceOf(Float64Array);
    expect(buf.length).toBe(0);
  });
});

describe("Multi-Chunk Engine Integration", () => {
  const coords = generateTestPoints(500);
  const options = { radius: 75, minZoom: 0, maxZoom: 16, minPoints: 2 };

  it("multi-chunk table produces identical clusters as single-chunk", () => {
    const singleEngine = new ArrowClusterEngine(options);
    singleEngine.load(buildArrowTable(coords));

    const multiEngine = new ArrowClusterEngine(options);
    multiEngine.load(buildMultiChunkArrowTable(coords, 5));

    const bbox: [number, number, number, number] = [-180, -85, 180, 85];

    for (let z = 0; z <= 16; z++) {
      const singleOut = singleEngine.getClusters(bbox, z);
      const multiOut = multiEngine.getClusters(bbox, z);

      expect(multiOut.length).toBe(singleOut.length);

      // Compare sorted point counts
      const singleCounts = Array.from(singleOut.pointCounts).sort(
        (a, b) => a - b,
      );
      const multiCounts = Array.from(multiOut.pointCounts).sort(
        (a, b) => a - b,
      );
      expect(multiCounts).toEqual(singleCounts);
    }
  });

  it("multi-chunk getLeaves returns valid Arrow row indices", () => {
    const engine = new ArrowClusterEngine(options);
    engine.load(buildMultiChunkArrowTable(coords, 4));

    const clusters = engine.getClusters([-180, -85, 180, 85], 2);

    for (let i = 0; i < clusters.length; i++) {
      if (clusters.isCluster[i] === 1) {
        const leaves = engine.getLeaves(clusters.ids[i]);
        for (const idx of leaves) {
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(idx).toBeLessThan(coords.length);
        }
        expect(leaves.length).toBe(clusters.pointCounts[i]);
        break;
      }
    }
  });

  it("multi-chunk positions match single-chunk positions", () => {
    const singleEngine = new ArrowClusterEngine(options);
    singleEngine.load(buildArrowTable(coords));

    const multiEngine = new ArrowClusterEngine(options);
    multiEngine.load(buildMultiChunkArrowTable(coords, 3));

    const bbox: [number, number, number, number] = [-180, -85, 180, 85];

    for (let z = 0; z <= 16; z++) {
      const singleOut = singleEngine.getClusters(bbox, z);
      const multiOut = multiEngine.getClusters(bbox, z);

      const singlePos = [];
      for (let i = 0; i < singleOut.length; i++) {
        singlePos.push({
          lng: singleOut.positions[i * 2],
          lat: singleOut.positions[i * 2 + 1],
        });
      }
      singlePos.sort((a, b) => a.lng - b.lng || a.lat - b.lat);

      const multiPos = [];
      for (let i = 0; i < multiOut.length; i++) {
        multiPos.push({
          lng: multiOut.positions[i * 2],
          lat: multiOut.positions[i * 2 + 1],
        });
      }
      multiPos.sort((a, b) => a.lng - b.lng || a.lat - b.lat);

      for (let i = 0; i < singlePos.length; i++) {
        expect(multiPos[i].lng).toBeCloseTo(singlePos[i].lng, 10);
        expect(multiPos[i].lat).toBeCloseTo(singlePos[i].lat, 10);
      }
    }
  });
});
