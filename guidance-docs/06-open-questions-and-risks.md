# arrow-cluster-layer — Open Questions & Risks

> These questions and risks apply across both packages in the monorepo (`arrow-supercluster` and `arrow-cluster-layer`). Where a concern is specific to one package, it's noted.

## Open Questions

### 1. Geometry Column Access Pattern (arrow-supercluster)

GeoArrow Point encoding stores coordinates as `FixedSizeList[2]` of Float64. The underlying buffer layout is `[lng0, lat0, lng1, lat1, ...]` — exactly what we need.

However, Arrow JS's `Vector.get(i)` returns a JS array `[lng, lat]`, which allocates. For the `load()` phase we want to access the raw `Float64Array` directly:

```ts
// Zero-copy access to coordinate buffer
const coordValues = geomCol.data[0].children[0].values as Float64Array;
const lng = coordValues[i * 2];
const lat = coordValues[i * 2 + 1];
```

**Question**: Is this access pattern stable across Arrow JS versions? The internal `data[0].children[0].values` path works in v14-v20 but isn't part of the public API.

**Mitigation**: Add a helper function that abstracts this access. If the internal layout changes, we only fix one place. Also add a fallback to `geomCol.get(i)` for safety.

### 2. Multi-Chunk Tables (arrow-supercluster)

If the Arrow Table has multiple chunks (e.g., from streaming load or large files), the geometry column's data is split across multiple `Float64Array` buffers. Our engine needs to handle this.

**Recommendation**: Phase 1 assumes single-chunk (typical for `readParquet` which returns a single-chunk table). Add multi-chunk support in Phase 2 by iterating `geomCol.data` and adjusting index offsets.

### 3. Cluster ID Encoding (arrow-supercluster)

Supercluster encodes cluster IDs as `((index << 5) + (zoom + 1) + numOriginalPoints)`. This means cluster IDs depend on the total number of input points. Our engine uses the same encoding, so IDs will be compatible.

**Question**: Should we expose the ID encoding/decoding as public API for consumers who need to serialize cluster state?

**Recommendation**: Yes, expose `getOriginZoom(clusterId)` and `getOriginId(clusterId)` as public methods.

### 4. TextLayer String Array (arrow-cluster-layer)

deck.gl's TextLayer doesn't support binary data for the `getText` accessor — it needs actual strings. So we can't go fully binary for the text sublayer. We still need a `(string | null)[]` array for cluster count labels.

This is a minor cost (a few KB for the visible clusters, typically <1000 items).

### 5. Full-World Bounding Box Query Pattern (arrow-supercluster)

deck.gl's `onViewStateChange` provides the current viewport bounds. At low zoom levels (0-2), the viewport can span the entire world. Supercluster handles this by clamping the bbox to `[-180, -85, 180, 85]` (the Mercator projection limit). Our engine must do the same.

**Important**: The latitude clamp is ~85.051129, not 90, because Mercator projection goes to infinity at the poles. Supercluster uses `latY()` which clamps internally, but we should also clamp the input bbox to avoid edge cases with the KDBush range query.

### 6. Null Geometry Handling (arrow-supercluster)

Some rows in the Arrow Table may have null geometry (missing coordinates). The `load()` method must skip these rows rather than inserting NaN coordinates into the KDBush index, which would corrupt spatial queries.

```ts
// In load(), before pushing to the data array:
if (lng === null || lat === null || Number.isNaN(lng) || Number.isNaN(lat)) {
  continue; // skip this row
}
```

The `ids` array in `ClusterOutput` will only reference rows with valid geometry.

### 7. Picking with Binary Data (arrow-cluster-layer)

When using deck.gl's binary data interface (`data.attributes`), picking works differently. The picked `index` corresponds to the position in the typed arrays. We need to maintain a mapping from that index back to our cluster/point data.

**Solution**: Keep the `ClusterOutput` object (with `ids`, `isCluster`, `pointCounts` arrays) in layer state. On pick, use the picked index to look up the cluster ID, then call `engine.getLeaves()` or resolve the Arrow row directly.

## Risks

### 1. Algorithm Correctness

We're reimplementing Supercluster's algorithm. Even though it's only ~400 lines, subtle bugs in the clustering logic could produce incorrect results (wrong cluster positions, missing points, broken hierarchy).

**Mitigation**: Comprehensive test suite that compares our output against Supercluster's output for the same input data. Use Supercluster as the reference implementation. Test edge cases: antimeridian wrapping, poles, single-point clusters, max zoom behavior.

### 2. KDBush Version Compatibility

Supercluster 8.x uses KDBush 4.x. We need to use the same KDBush version to ensure compatible behavior. KDBush's API is small and stable, but we should pin the version.

### 3. WASM Initialization in Next.js

`parquet-wasm` requires WASM initialization. Next.js has specific constraints:

- No WASM on server-side rendering
- Dynamic imports needed
- Webpack may need `asyncWebAssembly` experiment enabled

**Mitigation**: Test early in the Next.js environment. Use `parquet-wasm/bundler` entry point. Document the setup clearly.

### 4. Arrow JS API Stability (arrow-supercluster)

The internal buffer access pattern (`data[0].children[0].values`) isn't part of Arrow JS's public API. It could change in future versions.

**Mitigation**: Abstract behind a helper function. Test against multiple Arrow JS versions in CI. The `apache-arrow` peer dep range should be `>=14.0.0 <22.0.0` initially.

### 5. Bundle Size

`arrow-supercluster` bundles KDBush (~3KB) and the clustering engine (~15KB). Total ~18KB minified. `arrow-cluster-layer` adds style helpers and the CompositeLayer wrapper (~10KB). Combined total well under 50KB minified. This is comparable to Supercluster + its KDBush dependency.

No WASM in either package — that's the consumer's responsibility (parquet-wasm for data loading).

### 6. Performance Regression Risk

If our clustering engine is slower than Supercluster for some reason (e.g., different memory allocation patterns), the migration could hurt performance instead of helping.

**Mitigation**: Benchmark `load()` and `getClusters()` against Supercluster with the same data. The algorithms are identical, so performance should be comparable. The win comes from avoiding GeoJSON serialization, not from faster clustering.
