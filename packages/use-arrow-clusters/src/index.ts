import { useMemo } from 'react';
import { ArrowClusterEngine } from 'arrow-supercluster';
import type { ArrowClusterEngineOptions, ClusterOutput } from 'arrow-supercluster';
import type { Table } from 'apache-arrow';

export interface UseArrowClustersOptions {
  table: Table | null;
  geometryColumn?: string;
  idColumn?: string;
  options?: ArrowClusterEngineOptions;
  filterMask?: Uint8Array | null;
  bounds?: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
  zoom?: number;
}

export interface UseArrowClustersResult {
  clusters: ClusterOutput | null;
  supercluster: ArrowClusterEngine | null;
}

/**
 * React hook for clustering Arrow tables using arrow-supercluster.
 */
export function useArrowClusters({
  table,
  geometryColumn = 'geometry',
  idColumn,
  options,
  filterMask = null,
  bounds,
  zoom,
}: UseArrowClustersOptions): UseArrowClustersResult {
  
  // 1. Expensive operation: Initialize engine and load data
  const supercluster = useMemo(() => {
    if (!table) return null;

    const engine = new ArrowClusterEngine(options);
    
    // Pass undefined if idColumn or filterMask are not provided to fallback to engine defaults
    engine.load(table, geometryColumn, idColumn ?? undefined, filterMask ?? undefined);
    
    return engine;
  }, [
    table, 
    geometryColumn, 
    idColumn, 
    filterMask, 
    // Destructure options object to prevent unnecessary re-runs due to reference equality checks
    options?.radius, 
    options?.extent, 
    options?.minZoom, 
    options?.maxZoom, 
    options?.minPoints
  ]); 

  // 2. Cheap operation: Calculate clusters for the current viewport bounds
  const clusters = useMemo(() => {
    if (!supercluster || !bounds || typeof zoom === 'undefined') {
      return null;
    }
    
    return supercluster.getClusters(bounds, Math.floor(zoom));
  }, [
    supercluster, 
    // Spread bounds tuple to prevent unnecessary re-runs due to reference equality checks
    bounds?.[0], 
    bounds?.[1], 
    bounds?.[2], 
    bounds?.[3], 
    zoom
  ]);

  return { clusters, supercluster };
}