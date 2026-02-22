import { Table } from "apache-arrow";

//#region src/types.d.ts
/**
* Output of a clustering query — typed arrays ready for rendering pipelines.
*/
/**
 * Output of a clustering query — typed arrays ready for rendering pipelines.
 */
interface ClusterOutput {
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
interface ArrowClusterEngineOptions {
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
} //#endregion
//#region src/arrow-cluster-engine.d.ts

//# sourceMappingURL=types.d.ts.map
/**
 * Arrow-native spatial clustering engine.
 *
 * Reimplements Supercluster's algorithm to work directly with Apache Arrow
 * typed array buffers. No GeoJSON, no rendering opinion.
 */
declare class ArrowClusterEngine {
  private trees;
  private treeData;
  private numPoints;
  private table;
  readonly radius: number;
  readonly extent: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly minPoints: number;
  constructor(options?: ArrowClusterEngineOptions);
  /**
   * Load an Arrow Table and build the spatial index.
   */
  load(table: Table, geometryColumn?: string, _idColumn?: string): void;
  /**
   * Get clusters and individual points for a bounding box at a given zoom level.
   */
  getClusters(bbox: [number, number, number, number], zoom: number): ClusterOutput;
  /**
   * Get the immediate children of a cluster.
   */
  getChildren(clusterId: number): ClusterOutput;
  /**
   * Get the Arrow row indices of all leaf points in a cluster.
   */
  getLeaves(clusterId: number, limit?: number, offset?: number): number[];
  /**
   * Get the zoom level at which a cluster expands into its children.
   */
  getClusterExpansionZoom(clusterId: number): number;
  /** Decode the zoom level from a cluster ID. */
  getOriginZoom(clusterId: number): number;
  /** Decode the origin index from a cluster ID. */
  getOriginId(clusterId: number): number;
  private _getOriginZoom;
  private _getOriginId;
  private _appendLeafIndices;
  /**
   * Cluster points at a given zoom level.
   * Matches Supercluster._cluster() exactly.
   */
  private _cluster;
  private _createTree;
  private _limitZoom;
  private _emptyOutput;
  private _mergeOutputs;
} //#endregion

//# sourceMappingURL=arrow-cluster-engine.d.ts.map
export { ArrowClusterEngine, ArrowClusterEngineOptions, ClusterOutput };
//# sourceMappingURL=index.d.ts.map