import {
  makeVector,
  vectorFromArray,
  Table,
  Float64,
  Int32,
  Field,
  FixedSizeList,
} from "apache-arrow";

/**
 * Build an Arrow Table with a GeoArrow Point geometry column
 * from an array of [lng, lat] pairs.
 */
export function buildArrowTable(coords: [number, number][]): Table {
  const numRows = coords.length;

  // Build the geometry column via vectorFromArray (uses Builder internally)
  const childField = new Field("xy", new Float64());
  const listType = new FixedSizeList(2, childField);
  const geomVector = vectorFromArray(
    coords.map(([lng, lat]) => [lng, lat]),
    listType,
  );

  // Build the id column
  const ids = new Int32Array(numRows);
  for (let i = 0; i < numRows; i++) ids[i] = i;
  const idVector = makeVector(ids);

  return new Table({ geometry: geomVector, id: idVector });
}

/**
 * Build GeoJSON features from coordinate array (for Supercluster comparison).
 */
export function buildGeoJSON(
  coords: [number, number][],
): GeoJSON.Feature<GeoJSON.Point, { id: number }>[] {
  return coords.map((c, i) => ({
    type: "Feature" as const,
    properties: { id: i },
    geometry: { type: "Point" as const, coordinates: c },
  }));
}

/**
 * Generate deterministic pseudo-random points spread across the globe.
 */
export function generateTestPoints(count: number): [number, number][] {
  const points: [number, number][] = [];
  let seed = 42;
  const rand = () => {
    seed = (seed * 16807 + 0) % 2147483647;
    return seed / 2147483647;
  };

  for (let i = 0; i < count; i++) {
    const lng = rand() * 360 - 180;
    const lat = rand() * 170 - 85;
    points.push([lng, lat]);
  }
  return points;
}
