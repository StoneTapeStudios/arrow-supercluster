import {
  makeVector,
  vectorFromArray,
  Table,
  Float64,
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
export function buildGeoJSON(coords: [number, number][]): {
  type: "Feature";
  properties: { id: number };
  geometry: { type: "Point"; coordinates: [number, number] };
}[] {
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

/**
 * Build a multi-chunk Arrow Table by splitting coords into `chunkCount` batches.
 * Each batch is a separate RecordBatch — simulates what parquet-wasm produces
 * with small batchSize or what happens with multiple IPC record batches.
 */
export function buildMultiChunkArrowTable(
  coords: [number, number][],
  chunkCount: number,
): Table {
  const chunkSize = Math.ceil(coords.length / chunkCount);
  const tables: Table[] = [];

  for (let c = 0; c < chunkCount; c++) {
    const start = c * chunkSize;
    const end = Math.min(start + chunkSize, coords.length);
    const slice = coords.slice(start, end);
    if (slice.length === 0) continue;
    tables.push(buildArrowTable(slice));
  }

  // Combine batches from all small tables into one multi-chunk table.
  // Since all tables were built with the same schema via buildArrowTable,
  // Arrow JS accepts the batch combination.
  const allBatches = tables.flatMap((t) => t.batches);
  return new Table(allBatches);
}
