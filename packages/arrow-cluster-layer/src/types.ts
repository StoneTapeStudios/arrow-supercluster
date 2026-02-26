import type { CompositeLayerProps, PickingInfo } from "@deck.gl/core";
import type { Table, StructRowProxy } from "apache-arrow";
import type { ClusterOutput } from "arrow-supercluster";

/** RGBA color as a 4-element tuple, each channel 0-255. */
export type ColorRGBA = [number, number, number, number];

/** Options controlling cluster visual styling. */
export interface ClusterStyleOptions {
  primaryColor: ColorRGBA;
  secondaryColor: ColorRGBA;
  selectedColor: ColorRGBA;
  textOpacity: number;
}

/** Props for ArrowClusterLayer. */
export interface ArrowClusterLayerProps extends CompositeLayerProps {
  // Data
  data: Table;
  geometryColumn?: string;
  idColumn?: string;

  // Clustering (passed through to ArrowClusterEngine)
  clusterRadius?: number;
  clusterMaxZoom?: number;
  clusterMinZoom?: number;
  clusterMinPoints?: number;

  // Styling
  primaryColor?: ColorRGBA;
  secondaryColor?: ColorRGBA;
  selectedColor?: ColorRGBA;
  textOpacity?: number;
  pointRadiusMinPixels?: number;
  pointRadiusMaxPixels?: number;

  // Interaction state
  selectedClusterId?: number | null;
  focusedClusterId?: number | null;

  /** Boolean mask for filtering which points enter the cluster index.
   *  Length must equal table.numRows. 0 = excluded, non-zero = included.
   *  When null/undefined, all points are included (default behavior). */
  filterMask?: Uint8Array | null;

  // View
  viewType?: "map" | "globe";
}

/** Picking info returned by ArrowClusterLayer. */
export interface ArrowClusterPickingInfo extends PickingInfo {
  /** Whether the picked object is a cluster (vs individual point). */
  isCluster: boolean;
  /** The cluster ID (encoded) if cluster, or Arrow row index if point. */
  clusterId: number;
  /** Number of points in the cluster (1 for individual points). */
  pointCount: number;
  /** Arrow row indices of all leaf points in the cluster. */
  arrowIndices: number[];
  /** Materialized Arrow rows for the leaf points. */
  rows: StructRowProxy[];
}

/** Internal layer state. */
export interface ArrowClusterLayerState {
  [key: string]: unknown;
  engine: import("arrow-supercluster").ArrowClusterEngine | null;
  clusterOutput: ClusterOutput | null;
  /** Set of all descendant point IDs for the focused cluster. */
  focusedChildrenIds: Set<number> | null;
  /** The integer zoom level we last queried clusters for. */
  lastQueriedZoom: number;
}
