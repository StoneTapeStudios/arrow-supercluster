import type { Vector } from "apache-arrow";

/**
 * Extract coordinate buffer from a GeoArrow Point column.
 *
 * GeoArrow Point encoding: FixedSizeList[2] of Float64
 * Buffer layout: [lng0, lat0, lng1, lat1, ...]
 *
 * Single-chunk: returns the internal Float64Array directly (zero copy).
 * Multi-chunk: concatenates chunk buffers into a single Float64Array.
 */
export function getCoordBuffer({ geomCol }: { geomCol: Vector }): Float64Array {
  const chunks = geomCol.data;

  // Fast path: single chunk — zero copy, return the internal buffer directly.
  // This is the common case for tables loaded via parquet-wasm with
  // batchSize >= total row count.
  if (chunks.length === 1) {
    const chunk = chunks[0];
    if (chunk.children && chunk.children.length > 0) {
      const childData = chunk.children[0];
      const values = childData.values;
      if (values instanceof Float64Array) {
        // Handle potential non-zero offset (rare, but possible from slicing).
        // For FixedSizeList[2], child offset = parent offset * 2.
        const start = (childData.offset ?? 0) * 2;
        const end = start + chunk.length * 2;
        if (start === 0 && end === values.length) return values;
        return values.subarray(start, end);
      }
    }
  }

  // Multi-chunk path: concatenate coordinate buffers from each chunk.
  //
  // Uses Float64Array.set() per chunk — a hardware-level memcpy. For 200k
  // points across 3 chunks, this allocates one 3.2MB buffer and copies
  // 3.2MB of data. Sub-millisecond, negligible vs the ~1s KDBush build.
  const totalRows = geomCol.length;
  const coords = new Float64Array(totalRows * 2);
  let destOffset = 0;

  for (const chunk of chunks) {
    const childData = chunk.children?.[0];
    const childValues = childData?.values;

    if (childValues instanceof Float64Array) {
      const srcStart = (childData!.offset ?? 0) * 2;
      const srcEnd = srcStart + chunk.length * 2;
      coords.set(childValues.subarray(srcStart, srcEnd), destOffset * 2);
    } else {
      // Per-row fallback for non-GeoArrow encoding (WKB, etc.)
      for (let j = 0; j < chunk.length; j++) {
        const point = geomCol.get(destOffset + j);
        if (point) {
          coords[(destOffset + j) * 2] = point[0];
          coords[(destOffset + j) * 2 + 1] = point[1];
        } else {
          coords[(destOffset + j) * 2] = NaN;
          coords[(destOffset + j) * 2 + 1] = NaN;
        }
      }
    }

    destOffset += chunk.length;
  }

  return coords;
}
