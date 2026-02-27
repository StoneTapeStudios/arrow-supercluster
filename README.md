# arrow-cluster-layer

[![CI](https://github.com/StoneTapeStudios/arrow-supercluster/actions/workflows/ci.yml/badge.svg)](https://github.com/StoneTapeStudios/arrow-supercluster/actions/workflows/ci.yml)

Monorepo for Arrow-native spatial clustering on the web.

**[Live Demo](https://arrow-cluster-layer-demo.jonathanstombaugh.workers.dev)** — cluster 200K / 1M / 2M points from GeoParquet in the browser.

| Package                                               | Description                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| [`arrow-supercluster`](packages/arrow-supercluster)   | Clustering engine — Supercluster reimplemented for Apache Arrow tables |
| [`arrow-cluster-layer`](packages/arrow-cluster-layer) | deck.gl CompositeLayer for rendering clustered Arrow point data        |

## Getting Started

Requires [Node.js](https://nodejs.org/) >= 18 and [pnpm](https://pnpm.io/) >= 9.

```bash
pnpm install
pnpm build
```

## Scripts

```bash
pnpm build          # Build all packages
pnpm test           # Run all tests
pnpm clean          # Clean all dist folders
```

## Benchmarks

Benchmarks live in `packages/arrow-supercluster/benchmarks/` and compare the Arrow engine against Supercluster across dataset sizes, zoom levels, and full pipeline stages.

```bash
# Engine benchmarks (load time, query speed, memory)
pnpm bench

# Full pipeline benchmarks (serialize → deserialize → load → query)
pnpm bench:pipeline

# Include 1M point dataset (slower, more thorough)
pnpm bench -- --1m
pnpm bench:pipeline -- --1m
```

`--expose-gc` is included in the bench scripts for accurate memory measurements.

## Example App

A standalone demo that loads synthetic points from GeoParquet and renders them with `ArrowClusterLayer` on an OSM basemap. Includes a dataset picker (200K / 1M / 2M points) and a city filter panel.

```bash
# Generate the test dataset (2M points, ~20MB GeoParquet)
pnpm generate-data

# Start the dev server
pnpm example
```

Then open [localhost:5173](http://localhost:5173). Click clusters to zoom in, hover for details.

The example uses [parquet-wasm](https://github.com/kylebarron/parquet-wasm) to load GeoParquet in the browser and [vite-plugin-wasm](https://github.com/nicolo-ribaudo/vite-plugin-wasm) for WASM support.

## Project Structure

```text
├── packages/
│   ├── arrow-supercluster/      # Clustering engine (no deck.gl dependency)
│   └── arrow-cluster-layer/     # deck.gl layer (depends on arrow-supercluster)
└── examples/
    └── basic/                   # Standalone demo app
```

## License

ISC
