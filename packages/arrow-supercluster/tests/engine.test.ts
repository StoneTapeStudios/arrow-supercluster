import { describe, it, expect, beforeAll } from "vitest";
import Supercluster from "supercluster";
import { ArrowClusterEngine } from "../src/index";
import {
  buildArrowTable,
  buildGeoJSON,
  generateTestPoints,
} from "./test-utils";

describe("ArrowClusterEngine vs Supercluster", () => {
  const testPoints = generateTestPoints(500);
  const options = { radius: 75, minZoom: 0, maxZoom: 16, minPoints: 2 };

  let sc: Supercluster;
  let engine: ArrowClusterEngine;

  beforeAll(() => {
    sc = new Supercluster(options);
    sc.load(buildGeoJSON(testPoints));

    engine = new ArrowClusterEngine(options);
    engine.load(buildArrowTable(testPoints));
  });

  it("should produce the same number of clusters at each zoom level", () => {
    const bbox: [number, number, number, number] = [-180, -85, 180, 85];

    for (let z = 0; z <= 16; z++) {
      const scClusters = sc.getClusters(bbox, z);
      const engineOutput = engine.getClusters(bbox, z);

      expect(engineOutput.length).toBe(scClusters.length);
    }
  });

  it("should produce clusters with matching point counts at each zoom", () => {
    const bbox: [number, number, number, number] = [-180, -85, 180, 85];

    for (let z = 0; z <= 16; z++) {
      const scClusters = sc.getClusters(bbox, z);
      const engineOutput = engine.getClusters(bbox, z);

      const scCounts = scClusters
        .map((f) => (f.properties.cluster ? f.properties.point_count : 1))
        .sort((a, b) => a - b);

      const engineCounts = Array.from(engineOutput.pointCounts).sort(
        (a, b) => a - b,
      );

      expect(engineCounts).toEqual(scCounts);
    }
  });

  it("should produce cluster positions close to Supercluster", () => {
    const bbox: [number, number, number, number] = [-180, -85, 180, 85];

    for (let z = 0; z <= 16; z++) {
      const scClusters = sc.getClusters(bbox, z);
      const engineOutput = engine.getClusters(bbox, z);

      const scPositions = scClusters
        .map((f) => ({
          lng: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
        }))
        .sort((a, b) => a.lng - b.lng || a.lat - b.lat);

      const enginePositions: { lng: number; lat: number }[] = [];
      for (let i = 0; i < engineOutput.length; i++) {
        enginePositions.push({
          lng: engineOutput.positions[i * 2],
          lat: engineOutput.positions[i * 2 + 1],
        });
      }
      enginePositions.sort((a, b) => a.lng - b.lng || a.lat - b.lat);

      for (let i = 0; i < scPositions.length; i++) {
        expect(enginePositions[i].lng).toBeCloseTo(scPositions[i].lng, 4);
        expect(enginePositions[i].lat).toBeCloseTo(scPositions[i].lat, 4);
      }
    }
  });

  it("should correctly identify clusters vs individual points", () => {
    const bbox: [number, number, number, number] = [-180, -85, 180, 85];

    for (let z = 0; z <= 16; z++) {
      const scClusters = sc.getClusters(bbox, z);
      const engineOutput = engine.getClusters(bbox, z);

      const scClusterCount = scClusters.filter(
        (f) => f.properties.cluster,
      ).length;
      const engineClusterCount = Array.from(engineOutput.isCluster).filter(
        (v) => v === 1,
      ).length;

      expect(engineClusterCount).toBe(scClusterCount);
    }
  });

  it("getClusterExpansionZoom should match Supercluster", () => {
    const bbox: [number, number, number, number] = [-180, -85, 180, 85];
    const scClusters = sc.getClusters(bbox, 2);
    const engineOutput = engine.getClusters(bbox, 2);

    for (let i = 0; i < engineOutput.length; i++) {
      if (engineOutput.isCluster[i]) {
        const clusterId = engineOutput.ids[i];
        const engineExpZoom = engine.getClusterExpansionZoom(clusterId);

        const eLng = engineOutput.positions[i * 2];
        const eLat = engineOutput.positions[i * 2 + 1];

        const scMatch = scClusters.find((f) => {
          if (!f.properties.cluster) return false;
          const sLng = f.geometry.coordinates[0];
          const sLat = f.geometry.coordinates[1];
          return Math.abs(sLng - eLng) < 0.001 && Math.abs(sLat - eLat) < 0.001;
        });

        if (scMatch) {
          const scExpZoom = sc.getClusterExpansionZoom(
            scMatch.properties.cluster_id!,
          );
          expect(engineExpZoom).toBe(scExpZoom);
        }
      }
    }
  });

  it("getLeaves should return valid Arrow row indices", () => {
    const bbox: [number, number, number, number] = [-180, -85, 180, 85];
    const engineOutput = engine.getClusters(bbox, 2);

    for (let i = 0; i < engineOutput.length; i++) {
      if (engineOutput.isCluster[i]) {
        const clusterId = engineOutput.ids[i];
        const leaves = engine.getLeaves(clusterId);

        for (const idx of leaves) {
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(idx).toBeLessThan(testPoints.length);
        }

        expect(leaves.length).toBe(engineOutput.pointCounts[i]);
        break;
      }
    }
  });

  it("getChildren should return non-empty results for clusters", () => {
    const bbox: [number, number, number, number] = [-180, -85, 180, 85];
    const engineOutput = engine.getClusters(bbox, 2);

    for (let i = 0; i < engineOutput.length; i++) {
      if (engineOutput.isCluster[i]) {
        const clusterId = engineOutput.ids[i];
        const children = engine.getChildren(clusterId);

        expect(children.length).toBeGreaterThan(0);

        let childSum = 0;
        for (let j = 0; j < children.length; j++) {
          childSum += children.pointCounts[j];
        }
        expect(childSum).toBe(engineOutput.pointCounts[i]);
        break;
      }
    }
  });
});
