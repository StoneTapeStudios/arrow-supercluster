# arrow-supercluster

## 0.4.1

### Patch Changes

- 0e36427: fix: use exact counting for narrow filterRange queries below histogram resolution

## 0.4.0

### Minor Changes

- 6051de7: Add real-time numeric range filtering to the clustering engine and layer.

  New `rangeColumn` parameter on `load()` precomputes per-cluster min/max/rangedCount aggregates and optional prefix-sum histograms for large clusters. New `filterRange` parameter on `getClusters()` filters at query time without rebuilding the spatial index — clusters with zero in-range leaves are omitted, and `filteredPointCounts` reports the in-range count per node.

  The layer gains `rangeColumn` and `filterRange` props with a rebuild-vs-requery split: changing the range column triggers a rebuild, changing the filter range triggers only a re-query. Radii and text labels now reflect filtered counts.
