# arrow-cluster-layer — Monorepo & Package Structure

## Monorepo Layout

```
arrow-cluster-layer/                    # monorepo root
├── packages/
│   ├── arrow-supercluster/             # clustering engine (no deck.gl)
│   │   ├── src/
│   │   │   ├── index.ts                # Public API exports
│   │   │   ├── arrow-cluster-engine.ts # Arrow-native clustering (replaces Supercluster)
│   │   │   ├── arrow-helpers.ts        # Arrow geometry column access utilities
│   │   │   ├── mercator.ts             # lng/lat ↔ Mercator conversion (from Supercluster)
│   │   │   └── types.ts               # ClusterOutput, engine options types
│   │   ├── tests/
│   │   │   ├── engine.test.ts          # Clustering correctness vs Supercluster reference
│   │   │   └── edge-cases.test.ts      # Antimeridian, poles, nulls, empty data
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── tsdown.config.ts
│   │   └── README.md
│   │
│   └── arrow-cluster-layer/            # deck.gl CompositeLayer
│       ├── src/
│       │   ├── index.ts                # Public API exports
│       │   ├── arrow-cluster-layer.ts  # Main CompositeLayer class
│       │   ├── picking.ts              # Picking info resolution (cluster → Arrow rows)
│       │   ├── style-helpers.ts        # Fill color, radius, text color computations
│       │   └── types.ts               # Layer props, picking info types
│       ├── tests/
│       │   ├── style-helpers.test.ts   # Color/radius computation
│       │   └── picking.test.ts         # Index resolution
│       ├── package.json
│       ├── tsconfig.json
│       ├── tsdown.config.ts
│       └── README.md
│
├── package.json                        # workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json                  # shared TypeScript config
├── vitest.workspace.ts                 # shared vitest config
├── LICENSE
└── README.md
```

## Workspace Root

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
```

```json
// package.json (root — not published)
{
  "name": "arrow-cluster-layer-monorepo",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "lint": "pnpm -r lint",
    "clean": "pnpm -r clean"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

## Package 1: arrow-supercluster

### Public API Surface

```ts
// packages/arrow-supercluster/src/index.ts
export { ArrowClusterEngine } from "./arrow-cluster-engine";
export type { ClusterOutput, ArrowClusterEngineOptions } from "./types";
```

Deliberately minimal. The engine class and its output type — that's it.

### package.json

```json
{
  "name": "arrow-supercluster",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.cjs",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "dependencies": {
    "kdbush": "^4.0.2"
  },
  "peerDependencies": {
    "apache-arrow": ">=14.0.0"
  },
  "devDependencies": {
    "apache-arrow": "^20.0.0",
    "supercluster": "^8.0.1",
    "@types/supercluster": "^7.1.3",
    "tsdown": "^0.9.0"
  }
}
```

Key decisions:

- `kdbush` is a direct dependency (bundled) — internal implementation detail
- `apache-arrow` is a peer dependency — the consumer controls the version
- `supercluster` is dev-only — used for reference testing, not shipped
- No deck.gl dependency at all — this package is framework-agnostic
- No runtime dependency on `parquet-wasm` — data loading is the consumer's responsibility

### Build Configuration

```ts
// packages/arrow-supercluster/tsdown.config.ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["apache-arrow"],
});
```

### Testing Strategy

- **Correctness tests** (`engine.test.ts`): Load the same point set into both Supercluster and ArrowClusterEngine. Compare cluster counts, positions, and hierarchy at every zoom level. This is the most critical test — the algorithm must produce identical results.
- **Edge case tests** (`edge-cases.test.ts`): Antimeridian wrapping, polar coordinates, single-point clusters, empty data, max zoom behavior, null geometries, large datasets (cluster ID overflow)

## Package 2: arrow-cluster-layer

### Public API Surface

```ts
// packages/arrow-cluster-layer/src/index.ts
export { ArrowClusterLayer } from "./arrow-cluster-layer";
export type {
  ArrowClusterLayerProps,
  ArrowClusterPickingInfo,
  ClusterStyleOptions,
  ColorRGBA,
} from "./types";
export {
  computeFillColors,
  computeRadii,
  computeTextColors,
  computeTexts,
} from "./style-helpers";

// Re-export engine types for convenience (consumer doesn't need to install arrow-supercluster separately)
export { ArrowClusterEngine } from "arrow-supercluster";
export type {
  ClusterOutput,
  ArrowClusterEngineOptions,
} from "arrow-supercluster";
```

The layer package re-exports the engine and its types so that consumers who only need the layer don't have to add `arrow-supercluster` as a separate dependency. It comes in transitively.

### package.json

```json
{
  "name": "arrow-cluster-layer",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.cjs",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "dependencies": {
    "arrow-supercluster": "workspace:*"
  },
  "peerDependencies": {
    "@deck.gl/core": "^9.0.0",
    "@deck.gl/layers": "^9.0.0",
    "apache-arrow": ">=14.0.0"
  },
  "devDependencies": {
    "@deck.gl/core": "^9.1.10",
    "@deck.gl/layers": "^9.1.10",
    "apache-arrow": "^20.0.0",
    "tsdown": "^0.9.0"
  }
}
```

Key decisions:

- `arrow-supercluster` is a direct dependency via `workspace:*` (resolved to the actual version on publish)
- deck.gl packages are peer dependencies — the consumer controls versions
- `apache-arrow` is a peer dependency (shared with the engine)
- No `kdbush` or `supercluster` here — those are the engine's concern
- Style helpers are exported so consumers can customize or extend

### Build Configuration

```ts
// packages/arrow-cluster-layer/tsdown.config.ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    "@deck.gl/core",
    "@deck.gl/layers",
    "apache-arrow",
    "arrow-supercluster",
  ],
});
```

Note: `arrow-supercluster` is externalized in the bundle — it's a direct dependency, not inlined. This avoids duplicate code if the consumer also imports from `arrow-supercluster` directly.

### Testing Strategy

- **Style tests** (`style-helpers.test.ts`): Color/radius computation with known inputs
- **Picking tests** (`picking.test.ts`): Index resolution from picked cluster to Arrow rows
- No visual/rendering tests in the package — those belong in the consuming app

## Shared Configuration

### TypeScript

```json
// tsconfig.base.json (root)
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Each package extends this:

```json
// packages/arrow-supercluster/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### Vitest

```ts
// vitest.workspace.ts (root)
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/arrow-supercluster",
  "packages/arrow-cluster-layer",
]);
```

## Versioning & Publishing

- Semantic versioning for both packages independently
- Use [changesets](https://github.com/changesets/changesets) for version management
- `workspace:*` references are resolved to actual versions on `pnpm publish`
- Publish to npm (or GitHub Packages for private use initially)
- Both packages can have different version numbers — they're independent
