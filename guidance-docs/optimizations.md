# arrow-supercluster — Optimization Log

## Baseline Performance (pre-optimization)

Benchmark at 200k points:

- Load time: ~1× (parity with Supercluster)
- Query time: ~6× faster average (up to 20× at mid-zoom where heavy clustering occurs)
- Memory: ~8% less (full pipeline: input data + index build)
- Wire size: 84% smaller (Arrow columnar vs GeoJSON)

At 1M points:

- Load time: ~1× (parity)
- Query time: ~8× faster average (up to 27× at z6)
- Memory: ~10% less

Key observation: the query wins come from returning pre-allocated typed arrays (`Float64Array`, `Uint32Array`, `Uint8Array`) instead of Supercluster's GeoJSON Feature objects. The more clustering happening (low/mid zoom), the bigger the win because Supercluster allocates a JS object with nested `geometry`, `properties`, `coordinates` per result.

---

## Attempt 1: Replace `number[]` with `Float64Array` for internal `treeData`

### Hypothesis

The engine stores its internal tree data as `number[]` arrays built with `.push()`. This means dynamic array resizing and V8 boxed doubles. Switching to pre-allocated `Float64Array` with cursor-based writes should eliminate resizing overhead and give V8 a contiguous memory layout, improving load time by 20-40%.

### Implementation

- Changed `treeData: number[][]` → `treeData: Float64Array[]` with a parallel `treeDataLengths: number[]` to track used capacity
- `load()`: two-pass approach — count valid points first, then pre-allocate exactly `validCount * STRIDE`
- `_cluster()`: pre-allocate `nextData` at previous level's capacity, write via index assignment + cursor, grow by doubling if needed
- `_createTree()`: updated to accept `Float64Array` + `numItems`
- Added `.slice(0, nextLen)` trim after each `_cluster()` call to right-size the stored array

### Results

Load time: no meaningful change (~1× parity, sometimes slightly faster, sometimes slightly slower)

Query time: unchanged (expected — query path was already using typed arrays for output)

Memory: **significantly worse** — went from ~8% less to ~50% MORE than Supercluster

### Why It Failed

1. **V8 is already efficient with dense `number[]`**: When V8 sees a `number[]` that only contains doubles (no holes, no mixed types), it stores them internally as a packed `HOLEY_DOUBLE_ELEMENTS` backing store — essentially a raw double array with V8's own memory management. The `.push()` overhead we assumed was significant is actually well-optimized by V8's JIT.

2. **`Float64Array` has higher per-allocation overhead**: Each `Float64Array` carries an `ArrayBuffer` object with its own metadata, alignment requirements, and GC tracking. For 17 zoom levels of tree data, this overhead adds up.

3. **Pre-allocation wastes capacity**: Even with `.slice()` trimming, the clustering algorithm's output size is unpredictable. Pre-allocating at the previous level's full capacity means temporary allocations that are much larger than needed. The `.slice()` copies into a right-sized array, but now you've allocated _two_ arrays per zoom level during build (the working buffer + the trimmed copy), doubling GC pressure.

4. **`.slice()` doesn't help enough**: While it right-sizes the final stored array, the temporary oversized buffer still gets allocated and must be GC'd. At 1M points × 6 stride × 8 bytes × 17 zoom levels, that's a lot of transient memory.

5. **The bottleneck isn't where we thought**: Load time is dominated by KDBush index construction (which is the same in both implementations), not by the flat array manipulation. The `number[]` push/read pattern is a tiny fraction of the total load cost.

### Conclusion

The `number[]` → `Float64Array` swap is a net negative. V8's internal representation of dense number arrays is already close to optimal for this access pattern. The real performance wins in this engine come from the _output_ format (typed arrays vs GeoJSON objects), not the internal storage format.

---

## Future Optimization Candidates

### 1. High-zoom query performance (the remaining gap)

**Problem**: At high zoom levels (z10-z16) with small-to-medium datasets (10k-100k), the Arrow engine is 1.2-1.6× _slower_ than Supercluster. At these zoom levels there's minimal clustering — nearly all points are returned individually.

**Root cause**: Supercluster caches its GeoJSON features during `load()` and returns references to them at query time. The Arrow engine allocates fresh typed arrays for every `getClusters()` call. When the result set is large (nearly all points), the allocation cost of 4 typed arrays dominates.

**Possible approaches**:

- Pre-allocate reusable output buffers sized to `numPoints` and return views/slices into them
- At zoom levels above a threshold where clustering is minimal, skip the typed array allocation and return a lightweight wrapper that reads directly from `treeData`
- This gap closes naturally at larger datasets (200k+) where the GeoJSON object creation cost outweighs typed array allocation

### 2. Web Worker offloading (Phase 4 item)

**Problem**: `engine.load()` takes ~1s at 200k points, ~5.5s at 1M points, blocking the main thread.

**Approach**: Move `load()` to a Web Worker. KDBush stores its index as a single `ArrayBuffer` which is transferable between threads. The `treeData` arrays could also be transferred. This doesn't make load _faster_, but it unblocks the main thread.

### 3. Pre-size `nextData` in `_cluster()` to reduce `.push()` resizing

**Problem**: `_cluster()` builds `nextData` as an empty `number[]` and grows it via `.push()`. V8 handles this well, but at 1M points the array goes through many internal resizes. Since the output size is always ≤ the input size (clustering reduces count), we could pre-allocate `nextData` at the input's length and use index writes + a cursor, then truncate with `.length = cursor` at the end.

**Tradeoff**: This is the same direction as Attempt 1 but staying within `number[]` (no `Float64Array`). V8's packed double array with pre-set `.length` avoids resize copies while keeping the lightweight memory model. Worth benchmarking in isolation — the risk is low since it doesn't change the storage type.

### 4. Reduce `getChildren()` allocations in hierarchy navigation

**Problem**: `getClusterExpansionZoom()` and `getLeaves()` call `getChildren()` repeatedly, each call allocating 4 typed arrays. For deep cluster hierarchies this creates GC pressure.

**Approach**: Add an internal `_getChildIndices()` that returns raw index arrays without typed array wrapping, used only by internal hierarchy methods. Keep `getChildren()` as the public API with full typed array output.

### 5. Benchmark the _real_ pipeline, not just the engine

**Problem**: The current benchmark compares engine-to-engine, but the real win is the full pipeline: GeoJSON fetch + parse + Supercluster vs GeoParquet fetch + Arrow Table + ArrowClusterEngine. The ~84% wire size reduction and elimination of JSON parsing are likely the biggest real-world wins, but we're not measuring them yet.

**Approach**: Add a benchmark that simulates the full pipeline — serialize to JSON/Parquet, deserialize, load into engine, query. This would show the true end-to-end advantage.
