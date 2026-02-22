/**
 * Output of a clustering query — typed arrays ready for rendering pipelines.
 */
export interface ClusterOutput {
  /** Cluster/point positions in lng/lat. Interleaved: [lng0, lat0, lng1, lat1, ...] */
  positions: Float64Array;
  /** Point count per cluster (1 for individual points) */
  pointCounts: Uint32Array;
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
}
