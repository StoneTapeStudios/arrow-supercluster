# Contributing

Thanks for your interest in contributing to arrow-supercluster and arrow-cluster-layer.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 9

## Setup

```bash
git clone https://github.com/StoneTapeStudios/arrow-supercluster.git
cd arrow-supercluster
pnpm install
pnpm build
pnpm test
```

## Project structure

This is a pnpm monorepo with two packages:

- `packages/arrow-supercluster` — the clustering engine. No deck.gl dependency. Takes an Arrow Table in, outputs typed arrays.
- `packages/arrow-cluster-layer` — a deck.gl CompositeLayer that wraps the engine. Depends on `arrow-supercluster` via `workspace:*`.

Changes to the engine may affect the layer, so always run the full test suite from the root.

## Running tests

```bash
pnpm test           # runs vitest across both packages
```

## Building

```bash
pnpm build          # builds both packages (tsdown) in dependency order
```

## Running benchmarks

```bash
pnpm bench              # engine benchmarks (200k points)
pnpm bench -- --1m      # include 1M point dataset
pnpm bench:pipeline     # full pipeline benchmarks
```

Note: `--expose-gc` is included in the bench scripts for accurate memory measurements.

## Running the example app

```bash
pnpm generate-data      # generates synthetic 2M-point GeoParquet
pnpm example            # starts vite dev server at localhost:5173
```

## Submitting a PR

- Make sure `pnpm test` passes
- Make sure `pnpm build` succeeds
- Describe what changed and why in the PR description

## Questions?

Open a [GitHub Discussion](https://github.com/StoneTapeStudios/arrow-supercluster/discussions) on the repo.
