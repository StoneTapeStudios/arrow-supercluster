/**
 * Output of a clustering query — typed arrays ready for rendering pipelines.
 */
export interface ClusterOutput {
  /** Cluster/point positions in lng/lat. Interleaved: [lng0, lat0, lng1, lat1, ...] */
  positions: Float64Array;
  /** Point count per cluster (1 for individual points) */
  pointCounts: Uint32Array;
  /** Range-filtered point count per cluster. Equals pointCounts when no filterRange is active. */
  filteredPointCounts: Uint32Array;
  /** Cluster IDs (encoded) for clusters, or Arrow row index for individual points */
  ids: Float64Array;
  /** 1 if the entry is a cluster, 0 if it's an individual point */
  isCluster: Uint8Array;
  /** Total number of clusters/points in this output */
  length: number;
}

/**
 * Options for configuring the ArrowClusterEngine.
 */
export interface ArrowClusterEngineOptions {
  /** Cluster radius in pixels. Default: 40 */
  radius?: number;
  /** Tile extent (radius is calculated relative to it). Default: 512 */
  extent?: number;
  /** Minimum zoom level for clustering. Default: 0 */
  minZoom?: number;
  /** Maximum zoom level for clustering. Default: 16 */
  maxZoom?: number;
  /** Minimum number of points to form a cluster. Default: 2 */
  minPoints?: number;

  /** Number of histogram bins for range filtering. Default: 256. 0 disables
   *  histograms (min/max + leaf-walk only). */
  histogramBins?: number;

  /** Clusters with >= this many points get a prefix-sum histogram; smaller clusters
   *  are leaf-walked at query time. Default: 256. */
  histogramThreshold?: number;

  /** Value in the range column that marks an excluded row (excluded from every real
   *  range). Default: Arrow nulls are excluded. Provide this when the caller encodes
   *  "no value" as an in-band constant rather than null. */
  excludedValue?: number;
}
