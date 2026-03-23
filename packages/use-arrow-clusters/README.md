# use-arrow-clusters

A React hook for rendering clustered point data from Apache Arrow tables, built on top of `arrow-supercluster`.

This package provides a framework-agnostic React wrapper that efficiently manages the instantiation of the clustering engine and the computation of clusters based on the map's viewport.

## Install

```bash
# pnpm
pnpm add use-arrow-clusters arrow-supercluster apache-arrow

# npm
npm install use-arrow-clusters arrow-supercluster apache-arrow

# yarn
yarn add use-arrow-clusters arrow-supercluster apache-arrow
```

## Usage

```tsx
import { useArrowClusters } from 'use-arrow-clusters';
import type { Table } from 'apache-arrow';

function MapComponent({ table }: { table: Table }) {
  const { clusters, supercluster } = useArrowClusters({
    table,
    geometryColumn: 'geometry',
    idColumn: 'id',
    bounds: [-180, -85, 180, 85], // [minLng, minLat, maxLng, maxLat]
    zoom: 4,
    options: {
      radius: 75,
      maxZoom: 16,
    }
  });

  // Render your clusters here...
  return null;
}
```

## Performance Note

The hook utilizes dual `useMemo` blocks to separate expensive operations (loading the Arrow table) from cheap operations (querying clusters based on viewport).

Dependencies like `options` and `bounds` are destructured internally to prevent unnecessary re-renders due to React's reference equality checks. You do not need to memoize the `options` object or `bounds` array before passing them to the hook.