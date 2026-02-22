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

## Attempt 2: Reusable output buffers + direct coordinate reads (SHIPPED)

### Hypothesis

At high zoom levels (z8-z16) with small-to-medium datasets (10k-100k), the Arrow engine was 1.2-1.6× _slower_ than Supercluster. Two costs dominated the query hot path:

1. **Per-query typed array allocation**: `getClusters()` allocated 4 fresh typed arrays (`Float64Array`, `Uint32Array`, `Float64Array`, `Uint8Array`) on every call. At high zoom where `length ≈ numPoints`, this is significant.

2. **Per-point inverse mercator transforms**: Every result — cluster or individual point — called `xLng(data[k])` and `yLat(data[k+1])`. `yLat()` calls `Math.atan(Math.exp(...))` — expensive trig. At z16 with 200k points, that's 200k `atan` + `exp` calls per query.

Reading Supercluster's source revealed the key insight: for individual points (the vast majority at high zoom), Supercluster returns `this.points[data[k + OFFSET_ID]]` — a direct reference to the original GeoJSON input. No coordinate transform, no allocation. It only calls `xLng()`/`yLat()` for actual clusters, which are rare at high zoom.

### Implementation

Two changes, applied together:

**1. Reusable output buffers with `subarray()` views**

- Pre-allocate 4 output buffers during `load()`, sized to `maxItems` (the point count at the highest zoom level)
- `getClusters()` writes into these buffers, then returns `subarray()` views — zero allocation, zero copy
- Tradeoff: returned data is only valid until the next `getClusters()` call (standard pattern for GPU upload pipelines like deck.gl)

**2. Direct coordinate reads for individual points**

- Store a reference to the original Arrow coordinate buffer (`coordValues: Float64Array`) during `load()`
- In the query loop, branch on `numPts > 1`:
  - Cluster → `xLng(data[k])` / `yLat(data[k+1])` (inverse mercator, only for the few clusters)
  - Individual point → `coords[srcIdx * 2]` / `coords[srcIdx * 2 + 1]` (direct read, no trig)
- Applied the same pattern to `getChildren()`

### Results

**10k points (where the regression was worst):**

| Zoom | Before       | After        |
| ---- | ------------ | ------------ |
| z8   | 1.31× slower | 2.13× faster |
| z10  | 1.46× slower | 1.86× faster |
| z12  | 1.49× slower | 1.81× faster |
| z14  | 1.60× slower | 1.79× faster |
| z16  | 1.63× slower | 1.78× faster |

**100k points:**

| Zoom | Before       | After        |
| ---- | ------------ | ------------ |
| z8   | 2.58× faster | 3.81× faster |
| z10  | 1.18× slower | 1.14× faster |
| z12  | 1.31× slower | 1.42× faster |
| z14  | 1.27× slower | 1.38× faster |
| z16  | 1.33× slower | 1.42× faster |

**200k summary:** Average query speedup went from 6.80× to 7.54×. Arrow is now faster than Supercluster at every zoom level across all dataset sizes (with near-parity at 200k z14).

The high-zoom regression is completely eliminated.

### Why It Worked

The direct coordinate read is the big win. It mirrors exactly what Supercluster does — `this.points[id]` for individual points — but instead of referencing a GeoJSON object, we reference the Arrow `Float64Array` coordinate buffer. Same O(1) lookup, same zero-transform cost, but our output is still typed arrays rather than GeoJSON objects, so we keep the low/mid-zoom advantage too.

The reusable buffers with `subarray()` are a secondary win — they eliminate per-query allocation entirely. `subarray()` returns a view into the same `ArrayBuffer`, so there's no copy. The only cost is the loop that writes values into the buffer.

### Cleanup

- Removed unused `this.table` field (was stored but never read)
- Updated stale comments in `getClusters()`

---

## Future Optimization Candidates

### 1. Reduce `getChildren()` allocations in hierarchy navigation ← NEXT TARGET

**Problem**: `getClusterExpansionZoom()` and `getLeaves()` call `getChildren()` repeatedly, each call allocating 4 typed arrays. For deep cluster hierarchies this creates GC pressure. Unlike `getClusters()` (which now uses reusable buffers), `getChildren()` still allocates fresh arrays per call.

**Approach**: Add an internal `_getChildIndices()` that returns raw index arrays without typed array wrapping, used only by internal hierarchy methods (`_appendLeafIndices`, `getClusterExpansionZoom`). Keep `getChildren()` as the public API with full typed array output. This is low-risk, isolated to internal methods, and directly reduces GC pressure in the hierarchy traversal path.

**Why this is next**: It's the same pattern we just applied to `getClusters()` — avoid unnecessary allocation on internal hot paths. The implementation is straightforward and the risk is minimal.

### 2. Pre-size `nextData` in `_cluster()` to reduce `.push()` resizing

**Problem**: `_cluster()` builds `nextData` as an empty `number[]` and grows it via `.push()`. V8 handles this well, but at 1M points the array goes through many internal resizes. Since the output size is always ≤ the input size (clustering reduces count), we could pre-allocate `nextData` at the input's length and use index writes + a cursor, then truncate with `.length = cursor` at the end.

**Tradeoff**: This is the same direction as Attempt 1 but staying within `number[]` (no `Float64Array`). V8's packed double array with pre-set `.length` avoids resize copies while keeping the lightweight memory model. Worth benchmarking in isolation — the risk is low since it doesn't change the storage type.

### 3. Web Worker offloading (Phase 4 item)

**Problem**: `engine.load()` takes ~1s at 200k points, ~5.5s at 1M points, blocking the main thread.

**Approach**: Move `load()` to a Web Worker. KDBush stores its index as a single `ArrayBuffer` which is transferable between threads. The `treeData` arrays could also be transferred. This doesn't make load _faster_, but it unblocks the main thread.

### 4. Benchmark the _real_ pipeline, not just the engine

**Problem**: The current benchmark compares engine-to-engine, but the real win is the full pipeline: GeoJSON fetch + parse + Supercluster vs GeoParquet fetch + Arrow Table + ArrowClusterEngine. The ~84% wire size reduction and elimination of JSON parsing are likely the biggest real-world wins, but we're not measuring them yet.

**Approach**: Add a benchmark that simulates the full pipeline — serialize to JSON/Parquet, deserialize, load into engine, query. This would show the true end-to-end advantage.
