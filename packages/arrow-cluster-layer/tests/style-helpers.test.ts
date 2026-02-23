import { describe, it, expect } from "vitest";
import type { ClusterOutput } from "arrow-supercluster";
import {
  computeFillColors,
  computeRadii,
  computeTextColors,
  computeTexts,
} from "../src/style-helpers";
import type { ColorRGBA } from "../src/types";

/** Helper to build a minimal ClusterOutput for testing. */
function makeOutput(
  items: { id: number; pointCount: number; isCluster: boolean }[],
): ClusterOutput {
  const length = items.length;
  const positions = new Float64Array(length * 2); // not used by style helpers
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

const PRIMARY: ColorRGBA = [26, 26, 64, 200];
const SECONDARY: ColorRGBA = [100, 100, 200, 200];
const SELECTED: ColorRGBA = [255, 140, 0, 230];

describe("computeFillColors", () => {
  it("assigns primaryColor to all items when no selection or focus", () => {
    const output = makeOutput([
      { id: 0, pointCount: 1, isCluster: false },
      { id: 100, pointCount: 50, isCluster: true },
    ]);

    const colors = computeFillColors(
      output,
      PRIMARY,
      SECONDARY,
      SELECTED,
      null,
      null,
      null,
    );

    expect(colors.length).toBe(8); // 2 items * 4 channels
    // Both should be primary
    expect(Array.from(colors.subarray(0, 4))).toEqual(PRIMARY);
    expect(Array.from(colors.subarray(4, 8))).toEqual(PRIMARY);
  });

  it("assigns selectedColor to the selected cluster", () => {
    const output = makeOutput([
      { id: 0, pointCount: 1, isCluster: false },
      { id: 100, pointCount: 50, isCluster: true },
      { id: 200, pointCount: 30, isCluster: true },
    ]);

    const colors = computeFillColors(
      output,
      PRIMARY,
      SECONDARY,
      SELECTED,
      null,
      null,
      100, // selectedClusterId
    );

    expect(Array.from(colors.subarray(0, 4))).toEqual(PRIMARY); // id=0
    expect(Array.from(colors.subarray(4, 8))).toEqual(SELECTED); // id=100 (selected)
    expect(Array.from(colors.subarray(8, 12))).toEqual(PRIMARY); // id=200
  });

  it("assigns secondaryColor to focused cluster and its children", () => {
    const output = makeOutput([
      { id: 0, pointCount: 1, isCluster: false },
      { id: 100, pointCount: 50, isCluster: true },
      { id: 5, pointCount: 1, isCluster: false },
    ]);

    const focusedChildren = new Set([5]); // child of cluster 100

    const colors = computeFillColors(
      output,
      PRIMARY,
      SECONDARY,
      SELECTED,
      100, // focusedClusterId
      focusedChildren,
      null,
    );

    expect(Array.from(colors.subarray(0, 4))).toEqual(PRIMARY); // id=0
    expect(Array.from(colors.subarray(4, 8))).toEqual(SECONDARY); // id=100 (focused)
    expect(Array.from(colors.subarray(8, 12))).toEqual(SECONDARY); // id=5 (child of focused)
  });

  it("selectedColor takes priority over secondaryColor", () => {
    const output = makeOutput([{ id: 100, pointCount: 50, isCluster: true }]);

    const colors = computeFillColors(
      output,
      PRIMARY,
      SECONDARY,
      SELECTED,
      100, // also focused
      new Set<number>(),
      100, // also selected
    );

    // Selected wins over focused
    expect(Array.from(colors.subarray(0, 4))).toEqual(SELECTED);
  });
});

describe("computeRadii", () => {
  it("returns correct length", () => {
    const output = makeOutput([
      { id: 0, pointCount: 1, isCluster: false },
      { id: 1, pointCount: 100, isCluster: true },
    ]);

    const radii = computeRadii(output, 1000);
    expect(radii.length).toBe(2);
  });

  it("single points get the smallest radius", () => {
    const output = makeOutput([
      { id: 0, pointCount: 1, isCluster: false },
      { id: 1, pointCount: 500, isCluster: true },
    ]);

    const radii = computeRadii(output, 1000);
    expect(radii[0]).toBeLessThan(radii[1]);
  });

  it("radius scales logarithmically with point count", () => {
    const output = makeOutput([
      { id: 0, pointCount: 10, isCluster: true },
      { id: 1, pointCount: 100, isCluster: true },
      { id: 2, pointCount: 1000, isCluster: true },
    ]);

    const radii = computeRadii(output, 10000);

    // Each should be larger than the previous
    expect(radii[0]).toBeLessThan(radii[1]);
    expect(radii[1]).toBeLessThan(radii[2]);

    // But the gap should shrink (log scale)
    const gap1 = radii[1] - radii[0];
    const gap2 = radii[2] - radii[1];
    expect(gap2).toBeLessThan(gap1 * 2); // not linear
  });

  it("matches the expected formula: baseSize + (log(count+1)/log(total+1)) * scaleFactor", () => {
    const output = makeOutput([{ id: 0, pointCount: 50, isCluster: true }]);

    const totalPoints = 200;
    const radii = computeRadii(output, totalPoints);

    const expected = 4 + (Math.log(51) / Math.log(201)) * 50;
    expect(radii[0]).toBeCloseTo(expected, 5);
  });
});

describe("computeTextColors", () => {
  it("returns white text on dark backgrounds", () => {
    // Dark fill: [26, 26, 64, 200]
    const fillColors = new Uint8Array([26, 26, 64, 200]);
    const textColors = computeTextColors(fillColors, 255);

    expect(textColors[0]).toBe(255); // white
    expect(textColors[1]).toBe(255);
    expect(textColors[2]).toBe(255);
    expect(textColors[3]).toBe(255); // opacity
  });

  it("returns black text on light backgrounds", () => {
    // Light fill: [255, 255, 200, 255]
    const fillColors = new Uint8Array([255, 255, 200, 255]);
    const textColors = computeTextColors(fillColors, 200);

    expect(textColors[0]).toBe(0); // black
    expect(textColors[1]).toBe(0);
    expect(textColors[2]).toBe(0);
    expect(textColors[3]).toBe(200); // opacity
  });

  it("respects textOpacity parameter", () => {
    const fillColors = new Uint8Array([0, 0, 0, 255]);
    const textColors = computeTextColors(fillColors, 128);
    expect(textColors[3]).toBe(128);
  });

  it("handles multiple items", () => {
    // Dark then light
    const fillColors = new Uint8Array([
      10,
      10,
      10,
      255, // dark → white text
      240,
      240,
      240,
      255, // light → black text
    ]);
    const textColors = computeTextColors(fillColors, 255);

    expect(textColors[0]).toBe(255); // white for dark bg
    expect(textColors[4]).toBe(0); // black for light bg
  });
});

describe("computeTexts", () => {
  it("returns count string for clusters, null for points", () => {
    const output = makeOutput([
      { id: 0, pointCount: 1, isCluster: false },
      { id: 100, pointCount: 42, isCluster: true },
      { id: 200, pointCount: 1337, isCluster: true },
      { id: 3, pointCount: 1, isCluster: false },
    ]);

    const texts = computeTexts(output);

    expect(texts).toEqual([null, "42", "1337", null]);
  });

  it("returns empty array for empty output", () => {
    const output = makeOutput([]);
    const texts = computeTexts(output);
    expect(texts).toEqual([]);
  });
});
