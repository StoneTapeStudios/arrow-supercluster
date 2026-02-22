import { describe, it, expect } from "vitest";
import {
  makeVector,
  tableFromArrays,
  Int32,
  Field,
  Schema,
} from "apache-arrow";
import { ArrowClusterEngine } from "../src/index";
import { buildArrowTable } from "./test-utils";

describe("Edge Cases", () => {
  it("should handle empty data", () => {
    const engine = new ArrowClusterEngine();
    const table = buildArrowTable([]);
    engine.load(table);

    const result = engine.getClusters([-180, -85, 180, 85], 0);
    expect(result.length).toBe(0);
  });

  it("should handle a single point", () => {
    const engine = new ArrowClusterEngine();
    const table = buildArrowTable([[0, 0]]);
    engine.load(table);

    const result = engine.getClusters([-180, -85, 180, 85], 0);
    expect(result.length).toBe(1);
    expect(result.isCluster[0]).toBe(0);
    expect(result.pointCounts[0]).toBe(1);
  });

  it("should handle two points far apart (no clustering)", () => {
    const engine = new ArrowClusterEngine();
    const table = buildArrowTable([
      [-120, 40],
      [120, -40],
    ]);
    engine.load(table);

    const result = engine.getClusters([-180, -85, 180, 85], 16);
    expect(result.length).toBe(2);
    expect(result.isCluster[0]).toBe(0);
    expect(result.isCluster[1]).toBe(0);
  });

  it("should cluster two points at the same location", () => {
    const engine = new ArrowClusterEngine();
    const table = buildArrowTable([
      [10, 20],
      [10, 20],
    ]);
    engine.load(table);

    const result = engine.getClusters([-180, -85, 180, 85], 0);
    expect(result.length).toBe(1);
    expect(result.isCluster[0]).toBe(1);
    expect(result.pointCounts[0]).toBe(2);
  });

  it("should handle points near the antimeridian", () => {
    const engine = new ArrowClusterEngine();
    const table = buildArrowTable([
      [179.9, 0],
      [-179.9, 0],
    ]);
    engine.load(table);

    const result = engine.getClusters([-180, -85, 180, 85], 0);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle points near the poles", () => {
    const engine = new ArrowClusterEngine();
    const table = buildArrowTable([
      [0, 85],
      [0, -85],
      [0, 84.9],
    ]);
    engine.load(table);

    const result = engine.getClusters([-180, -85, 180, 85], 0);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle bbox query that covers partial world", () => {
    const engine = new ArrowClusterEngine();
    const table = buildArrowTable([
      [-100, 40],
      [100, 40],
      [0, 0],
    ]);
    engine.load(table);

    const result = engine.getClusters([-180, -85, 0, 85], 10);
    for (let i = 0; i < result.length; i++) {
      expect(result.positions[i * 2]).toBeLessThanOrEqual(0);
    }
  });

  it("should return correct output types", () => {
    const engine = new ArrowClusterEngine();
    const table = buildArrowTable([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    engine.load(table);

    const result = engine.getClusters([-180, -85, 180, 85], 0);
    expect(result.positions).toBeInstanceOf(Float64Array);
    expect(result.pointCounts).toBeInstanceOf(Uint32Array);
    expect(result.ids).toBeInstanceOf(Float64Array);
    expect(result.isCluster).toBeInstanceOf(Uint8Array);
    expect(typeof result.length).toBe("number");
  });

  it("should throw when geometry column is missing", () => {
    const engine = new ArrowClusterEngine();
    const table = tableFromArrays({ id: new Int32Array([1, 2, 3]) });

    expect(() => engine.load(table)).toThrow(
      'Geometry column "geometry" not found',
    );
  });

  it("getOriginZoom and getOriginId should round-trip correctly", () => {
    const engine = new ArrowClusterEngine();
    const table = buildArrowTable([
      [0, 0],
      [0.001, 0.001],
      [0.002, 0.002],
    ]);
    engine.load(table);

    const result = engine.getClusters([-180, -85, 180, 85], 0);
    for (let i = 0; i < result.length; i++) {
      if (result.isCluster[i]) {
        const clusterId = result.ids[i];
        const zoom = engine.getOriginZoom(clusterId);
        const originId = engine.getOriginId(clusterId);

        expect(zoom).toBeGreaterThanOrEqual(0);
        expect(zoom).toBeLessThanOrEqual(16);
        expect(originId).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
