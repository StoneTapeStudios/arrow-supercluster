import type { Vector } from "apache-arrow";

/**
 * Extract the raw Float64Array coordinate buffer from a GeoArrow Point column.
 *
 * GeoArrow Point encoding: FixedSizeList[2] of Float64
 * Buffer layout: [lng0, lat0, lng1, lat1, ...]
 *
 * This accesses Arrow's internal buffer directly — zero copy.
 * Single-chunk only in this version.
 */
export function getCoordBuffer(geomCol: Vector): Float64Array {
  const data = geomCol.data[0];

  // GeoArrow Point = FixedSizeList[2] → children[0] is the Float64 values vector
  if (data.children && data.children.length > 0) {
    const values = data.children[0].values;
    if (values instanceof Float64Array) {
      return values;
    }
  }

  // Fallback: manually extract coordinates via the public API
  const numRows = geomCol.length;
  const coords = new Float64Array(numRows * 2);
  for (let i = 0; i < numRows; i++) {
    const point = geomCol.get(i);
    if (point) {
      coords[i * 2] = point[0];
      coords[i * 2 + 1] = point[1];
    } else {
      coords[i * 2] = NaN;
      coords[i * 2 + 1] = NaN;
    }
  }
  return coords;
}
