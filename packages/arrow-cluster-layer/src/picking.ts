import type { PickingInfo } from "@deck.gl/core";
import type { Table } from "apache-arrow";
import type { ArrowClusterEngine, ClusterOutput } from "arrow-supercluster";
import type { ArrowClusterPickingInfo } from "./types";

/**
 * Resolve a raw picking info into an ArrowClusterPickingInfo.
 *
 * For clusters: calls engine.getLeaves() to get all leaf Arrow row indices,
 * then materializes the rows from the table.
 *
 * For individual points: the id IS the Arrow row index.
 */
export function resolvePickingInfo(
  info: PickingInfo,
  clusterOutput: ClusterOutput | null,
  engine: ArrowClusterEngine | null,
  table: Table | null,
): ArrowClusterPickingInfo {
  const result = info as ArrowClusterPickingInfo;

  if (info.index < 0 || !clusterOutput || !engine || !table) {
    result.isCluster = false;
    result.clusterId = -1;
    result.pointCount = 0;
    result.arrowIndices = [];
    result.rows = [];
    return result;
  }

  const idx = info.index;
  const id = clusterOutput.ids[idx];
  const cluster = clusterOutput.isCluster[idx] === 1;
  const pointCount = clusterOutput.pointCounts[idx];

  result.isCluster = cluster;
  result.clusterId = id;
  result.pointCount = pointCount;

  if (cluster) {
    const leafIndices = engine.getLeaves(id);
    result.arrowIndices = leafIndices;
    result.rows = leafIndices.map((i) => table.get(i)!);
  } else {
    // Individual point — id is the Arrow row index
    result.arrowIndices = [id];
    result.rows = [table.get(id)!];
  }

  return result;
}
