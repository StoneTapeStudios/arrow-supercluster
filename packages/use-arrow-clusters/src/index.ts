import { useMemo } from 'react';
import { ArrowClusterEngine } from 'arrow-supercluster';
import type { Table } from 'apache-arrow';

export interface UseArrowClustersOptions {
  table: Table | null;
  geometryColumn?: string;
  options?: {
    radius?: number;
    extent?: number;
    minZoom?: number;
    maxZoom?: number;
    minPoints?: number;
  };
  filterMask?: Uint8Array | null;
  bounds?: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
  zoom?: number;
}

export function useArrowClusters({
  table,
  geometryColumn = 'geometry',
  options,
  filterMask = null,
  bounds,
  zoom,
}: UseArrowClustersOptions) {
  
  // 1. exp operation
  const supercluster = useMemo(() => {
    if (!table) return null;

    const engine = new ArrowClusterEngine(options);
    engine.load(table, geometryColumn, "id", filterMask ?? undefined);
    
    return engine;
  }, [table, geometryColumn, filterMask, options]); 

  // 2. cheap operation
  const clusters = useMemo(() => {
    if (!supercluster || !bounds || typeof zoom === 'undefined') {
      return null;
    }
    
    return supercluster.getClusters(bounds, Math.floor(zoom));
  }, [supercluster, bounds, zoom]);

  return { clusters, supercluster };
}