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

## Attempt 3: Internal `_getChildIndices()` to eliminate hierarchy traversal allocations (SHIPPED)

### Hypothesis

`getClusterExpansionZoom()` and `_appendLeafIndices()` (used by `getLeaves()`) both called the public `getChildren()` method, which allocates 4 typed arrays per call. These internal callers don't need positions or typed array output — they only read `ids`, `isCluster`, and `pointCounts` to navigate the cluster hierarchy. For deep hierarchies, this creates unnecessary GC pressure.

### Implementation

- Extracted the neighbor-finding logic from `getChildren()` into a new private `_getChildIndices(clusterId)` method that returns `{ indices: number[], data: number[] }` — raw treeData item indices and a reference to the data array. Zero typed array allocation.
- `getClusterExpansionZoom()` now calls `_getChildIndices()` and reads `OFFSET_NUM` / `OFFSET_ID` directly from `data[k + ...]`.
- `_appendLeafIndices()` does the same — reads `numPts`, cluster IDs, and point IDs directly from the flat data array.
- `getChildren()` (public API) now delegates to `_getChildIndices()` for the neighbor search, then builds the typed array output only for external callers.

### Results

No regressions on any metric. All 17 tests pass. The query benchmark is unaffected (these methods aren't in the `getClusters` hot path), but `getClusterExpansionZoom` and `getLeaves` no longer allocate 4 typed arrays per recursion step.

At 200k points, the summary held steady at 8.65× average query speedup — confirming this was a clean structural refactor with no performance cost.

### Why It Worked

Same principle as Attempt 2: avoid allocating output structures on internal hot paths that don't need them. The typed array wrapping in `getChildren()` exists for the public API contract (rendering pipelines expect `ClusterOutput`). Internal hierarchy traversal only needs raw index lookups into the flat `treeData` array, which is what `_getChildIndices()` provides.

---

## Future Optimization Candidates

### ~~1. Pre-size `nextData` in `_cluster()` to reduce `.push()` resizing~~ (SKIPPED)

**Problem**: `_cluster()` builds `nextData` as an empty `number[]` and grows it via `.push()`. V8 handles this well, but at 1M points the array goes through many internal resizes.

**Why we're skipping it**: Attempt 1 already proved that internal flat array manipulation is not the bottleneck — KDBush index construction dominates load time. Pre-sizing a `number[]` avoids the `Float64Array` overhead that sank Attempt 1, but you're still optimizing a tiny fraction of the total load cost. Estimated impact: 1-3% load improvement at best, zero query impact. Not worth the code churn for an unnoticeable gain.

### 2. Web Worker offloading (Phase 4 item) — NEXT TARGET

**Problem**: `engine.load()` takes ~1s at 200k points, ~5.5s at 1M points, blocking the main thread.

**Approach**: Move `load()` to a Web Worker. KDBush stores its index as a single `ArrayBuffer` which is transferable between threads. The `treeData` arrays could also be transferred. This doesn't make load _faster_, but it unblocks the main thread.

### 3. Benchmark the _real_ pipeline, not just the engine (DONE)

Implemented as `benchmarks/pipeline.ts`. Run via `pnpm bench:pipeline` (or `--1m` for 1M points).

Measures the full end-to-end cost: serialize → wire size → deserialize → engine load → query. GeoJSON pipeline uses `JSON.stringify` / `JSON.parse` + Supercluster. Arrow pipeline uses `tableToIPC` / `tableFromIPC` + ArrowClusterEngine.

Six sections: wire size, serialization time, deserialization time, full pipeline, per-stage breakdown (at largest dataset), and a visual time distribution showing where the time goes.

**Results at 200k points (deserialize → load → query @ z6):**

- Wire size: ~84% smaller (24.2MB GeoJSON → 3.8MB Arrow IPC)
- Deserialization: ~4,000× faster (`tableFromIPC` is essentially a pointer cast over the IPC buffer — ~27µs vs ~112ms for `JSON.parse`)
- Engine load: ~1× (parity — KDBush index build dominates both pipelines)
- Query (z6): ~29× faster (typed array output vs GeoJSON Feature allocation)
- End-to-end: ~1.2× faster overall

**Key insight**: Engine load dominates both pipelines (~86% of GeoJSON time, ~100% of Arrow time). The Arrow pipeline's massive deserialization win (~112ms → ~27µs) is dwarfed by the ~945ms load step. This means the real-world user-facing wins are:

1. **Wire size** (84% smaller transfer — the biggest practical win for users on slow connections)
2. **Query speed** (29× at mid-zoom — matters for every pan/zoom interaction after initial load)
3. **Deserialization** (eliminates ~112ms of JSON parsing — noticeable but not dominant)

Load time parity confirms that the KDBush spatial index build is the true bottleneck, validating Future Optimization #2 (Web Worker offloading) as the next high-impact target.
