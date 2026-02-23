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

  const childField = new Field("xy", new Float64());
  const listType = new FixedSizeList(2, childField);
  const geomVector = vectorFromArray(
    coords.map(([lng, lat]) => [lng, lat]),
    listType,
  );

  const ids = new Int32Array(numRows);
  for (let i = 0; i < numRows; i++) ids[i] = i;
  const idVector = makeVector(ids);

  return new Table({ geometry: geomVector, id: idVector });
}
