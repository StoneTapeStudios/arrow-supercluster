import { describe, it, expect } from "vitest";
import type { PickingInfo } from "@deck.gl/core";
import type { ClusterOutput } from "arrow-supercluster";
import { ArrowClusterEngine } from "arrow-supercluster";
import { resolvePickingInfo } from "../src/picking";
import { buildArrowTable } from "./test-utils";

/** Build a minimal PickingInfo stub. */
function makePickingInfo(index: number): PickingInfo {
  return { index } as PickingInfo;
}

/** Build a ClusterOutput with known data. */
function makeOutput(
  items: { id: number; pointCount: number; isCluster: boolean }[],
): ClusterOutput {
  const length = items.length;
  const positions = new Float64Array(length * 2);
  const pointCounts = new Uint32Array(length);
  const ids = new Float64Array(length);
  const isCluster = new Uint8Array(length);

  for (let i = 0; i < length; i++) {
    pointCounts[i] = items[i].pointCount;
    ids[i] = items[i].id;
    isCluster[i] = items[i].isCluster ? 1 : 0;
  }

  return { positions, pointCounts, ids, isCluster, length };
}

describe("resolvePickingInfo", () => {
  it("returns empty result when index is -1 (nothing picked)", () => {
    const info = makePickingInfo(-1);
    const output = makeOutput([{ id: 0, pointCount: 1, isCluster: false }]);

    const result = resolvePickingInfo(info, output, null, null);

    expect(result.isCluster).toBe(false);
    expect(result.clusterId).toBe(-1);
    expect(result.pointCount).toBe(0);
    expect(result.arrowIndices).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("returns empty result when clusterOutput is null", () => {
    const info = makePickingInfo(0);
    const result = resolvePickingInfo(info, null, null, null);

    expect(result.isCluster).toBe(false);
    expect(result.arrowIndices).toEqual([]);
  });

  it("resolves an individual point pick to a single Arrow row", () => {
    const coords: [number, number][] = [
      [-122.4, 37.8],
      [-73.9, 40.7],
      [2.3, 48.9],
    ];
    const table = buildArrowTable(coords);

    // Simulate output where index 1 is an individual point with Arrow row id=1
    const output = makeOutput([
      { id: 0, pointCount: 1, isCluster: false },
      { id: 1, pointCount: 1, isCluster: false },
      { id: 2, pointCount: 1, isCluster: false },
    ]);

    // Engine not needed for individual point picks, but we pass a real one
    const engine = new ArrowClusterEngine();
    engine.load(table);

    const info = makePickingInfo(1);
    const result = resolvePickingInfo(info, output, engine, table);

    expect(result.isCluster).toBe(false);
    expect(result.clusterId).toBe(1);
    expect(result.pointCount).toBe(1);
    expect(result.arrowIndices).toEqual([1]);
    expect(result.rows).toHaveLength(1);
    // Verify the materialized row has the right id
    expect(result.rows[0]?.id).toBe(1);
  });

  it("resolves a cluster pick to multiple Arrow rows via getLeaves", () => {
    // Create points close enough to cluster at low zoom
    const coords: [number, number][] = [
      [-122.4, 37.8],
      [-122.401, 37.801],
      [-122.399, 37.799],
      [100, -30], // far away, won't cluster with the others
    ];
    const table = buildArrowTable(coords);

    const engine = new ArrowClusterEngine({
      radius: 80,
      maxZoom: 16,
      minZoom: 0,
    });
    engine.load(table);

    // Get clusters at a zoom where the first 3 points should cluster
    const clusters = engine.getClusters([-180, -85, 180, 85], 0);

    // Find a cluster (pointCount > 1)
    let clusterIdx = -1;
    for (let i = 0; i < clusters.length; i++) {
      if (clusters.isCluster[i] === 1) {
        clusterIdx = i;
        break;
      }
    }

    expect(clusterIdx).toBeGreaterThanOrEqual(0);

    const info = makePickingInfo(clusterIdx);
    const result = resolvePickingInfo(info, clusters, engine, table);

    expect(result.isCluster).toBe(true);
    expect(result.pointCount).toBeGreaterThan(1);
    expect(result.arrowIndices.length).toBe(result.pointCount);
    expect(result.rows.length).toBe(result.pointCount);

    // All returned indices should be valid Arrow row indices
    for (const idx of result.arrowIndices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(table.numRows);
    }

    // Materialized rows should have valid ids
    for (const row of result.rows) {
      expect(row).not.toBeNull();
      expect(typeof row.id).toBe("number");
    }
  });
});
