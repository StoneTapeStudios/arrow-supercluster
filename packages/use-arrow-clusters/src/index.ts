import { useMemo, useRef } from 'react';
import { ArrowClusterEngine, type ArrowClusterEngineOptions, type ClusterOutput } from 'arrow-supercluster';
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

// Helper function to check if dependency arrays are shallowly equal
function depsShallowEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

/**
 * A React hook for clustering Apache Arrow tables using arrow-supercluster.
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
  
  // Ref to securely hold the engine instance and its initialization dependencies.
  // This prevents React from inadvertently garbage-collecting our expensive engine instance.
  const engineRef = useRef<{ engine: ArrowClusterEngine; deps: unknown[] } | null>(null);

  // 1. Expensive operation: Initialize engine and load data
  // We use a manual memoization pattern with useRef to ensure the engine is not re-created
  // unexpectedly due to React's aggressive cache clearing of useMemo.
  const supercluster = useMemo(() => {
    if (!table) return null;

    // Destructure options to prevent unnecessary re-runs due to React's strict reference equality checks
    const deps = [
      table, 
      geometryColumn, 
      idColumn, 
      filterMask,
      options?.radius, 
      options?.extent, 
      options?.minZoom, 
      options?.maxZoom, 
      options?.minPoints
    ];

    // Return the cached engine if dependencies haven't changed
    if (engineRef.current && depsShallowEqual(engineRef.current.deps, deps)) {
      return engineRef.current.engine;
    }

    // Initialize a new engine if dependencies changed or it's the first run
    const engine = new ArrowClusterEngine(options);
    
    // Pass undefined if idColumn or filterMask are not provided to fallback to engine defaults
    engine.load(table, geometryColumn, idColumn ?? undefined, filterMask ?? undefined);
    
    // Cache the newly created engine and its dependencies
    engineRef.current = { engine, deps };
    
    return engine;
  }, [table, geometryColumn, idColumn, filterMask, options]); 

  // 2. Cheap operation: Calculate clusters for the current viewport bounds
  const clusters = useMemo(() => {
    if (!supercluster || !bounds || typeof zoom === 'undefined') {
      return null;
    }
    
   return supercluster.getClusters(bounds, Math.floor(zoom));
  }, [
    supercluster, 
    bounds?.[0], 
    bounds?.[1], 
    bounds?.[2], 
    bounds?.[3], 
    zoom
  ]);

  return { clusters, supercluster };
}