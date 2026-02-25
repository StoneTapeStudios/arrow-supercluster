import { Deck, MapView, FlyToInterpolator } from "@deck.gl/core";
import { BitmapLayer } from "@deck.gl/layers";
import { TileLayer } from "@deck.gl/geo-layers";
import { tableFromIPC, type Table } from "apache-arrow";
import initParquetWasm, { readParquet } from "parquet-wasm";
import { ArrowClusterLayer } from "arrow-cluster-layer";
import type { ArrowClusterPickingInfo } from "arrow-cluster-layer";

// --- Load GeoParquet → Arrow Table ---

const PARQUET_URL = "/data/points-2m.parquet";

async function loadParquetTable(): Promise<Table> {
  // Initialize parquet-wasm (loads the .wasm binary once)
  await initParquetWasm();

  const resp = await fetch(PARQUET_URL);
  if (!resp.ok)
    throw new Error(`Failed to fetch ${PARQUET_URL}: ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());

  // batchSize must cover the full file to get a single-chunk Arrow table.
  // This lets getCoordBuffer() use the zero-copy fast path (reads data[0] only).
  const wasmTable = readParquet(buf, { batchSize: 2_100_000 });
  return tableFromIPC(wasmTable.intoIPCStream());
}

// --- UI state ---

let selectedClusterId: number | null = null;
let focusedClusterId: number | null = null;
let currentZoom = 2;

const statsEl = document.getElementById("stats")!;
const hoverEl = document.getElementById("hover-info")!;

function updateStats(table: Table) {
  statsEl.innerHTML = `
    Points: <span class="stat">${table.numRows.toLocaleString()}</span><br>
    Zoom: <span class="stat">${currentZoom}</span><br>
    Arrow Table rows: <span class="stat">${table.numRows.toLocaleString()}</span><br>
    <br>
    <em>Click a cluster to select it.<br>
    Hover to see details.<br>
    Scroll to zoom.</em>
  `;
}

// --- Basemap layer (free OSM tiles, no token required) ---

function createBasemapLayer() {
  return new TileLayer({
    id: "osm-basemap",
    data: "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    minZoom: 0,
    renderSubLayers: (props) => {
      const {
        boundingBox: [[west, south], [east, north]],
      } = props.tile;
      return new BitmapLayer(props, {
        data: undefined,
        image: props.data,
        bounds: [west, south, east, north],
      });
    },
  });
}

// --- Cluster layer ---

let clusterLayerRef: ArrowClusterLayer | null = null;

function createClusterLayer(table: Table) {
  const layer = new ArrowClusterLayer({
    id: "arrow-clusters",
    data: table,
    geometryColumn: "geometry",
    idColumn: "id",
    clusterRadius: 60,
    clusterMaxZoom: 16,
    clusterMinZoom: 0,
    clusterMinPoints: 2,
    primaryColor: [26, 26, 64, 200],
    secondaryColor: [80, 80, 220, 220],
    selectedColor: [255, 140, 0, 230],
    textOpacity: 255,
    pointRadiusMinPixels: 6,
    pointRadiusMaxPixels: 80,
    selectedClusterId,
    focusedClusterId,
    pickable: true,
  });
  clusterLayerRef = layer;
  return layer;
}

// --- Boot ---

async function main() {
  statsEl.innerHTML = "Loading GeoParquet...";

  const t0 = performance.now();
  const table = await loadParquetTable();
  const loadMs = (performance.now() - t0).toFixed(0);
  console.log(`Loaded ${table.numRows.toLocaleString()} rows in ${loadMs}ms`);

  updateStats(table);

  const deckInstance = new Deck({
    views: new MapView({ repeat: true }),
    initialViewState: {
      longitude: 0,
      latitude: 20,
      zoom: 2,
    },
    controller: true,
    layers: [createBasemapLayer(), createClusterLayer(table)],
    getTooltip: () => null,

    onViewStateChange: ({ viewState }) => {
      const newZoom = Math.floor(viewState.zoom);
      if (newZoom !== currentZoom) {
        currentZoom = newZoom;
        updateStats(table);
      }
      return viewState;
    },

    onHover: (info) => {
      const pickInfo = info as ArrowClusterPickingInfo;
      if (
        pickInfo.index >= 0 &&
        pickInfo.clusterId !== undefined &&
        pickInfo.clusterId >= 0
      ) {
        hoverEl.style.display = "block";
        if (pickInfo.isCluster) {
          hoverEl.innerHTML = `
            <strong>Cluster</strong><br>
            Points: ${pickInfo.pointCount}<br>
            ID: ${pickInfo.clusterId}
          `;
        } else {
          const row = pickInfo.rows?.[0];
          hoverEl.innerHTML = `
            <strong>Point</strong><br>
            Row index: ${pickInfo.arrowIndices?.[0]}<br>
            City: ${row?.city ?? "unknown"}
          `;
        }

        if (pickInfo.isCluster && pickInfo.clusterId !== focusedClusterId) {
          focusedClusterId = pickInfo.clusterId;
          deckInstance.setProps({
            layers: [createBasemapLayer(), createClusterLayer(table)],
          });
        }
      } else {
        hoverEl.style.display = "none";
        if (focusedClusterId !== null) {
          focusedClusterId = null;
          deckInstance.setProps({
            layers: [createBasemapLayer(), createClusterLayer(table)],
          });
        }
      }
    },

    onClick: (info) => {
      const pickInfo = info as ArrowClusterPickingInfo;
      if (pickInfo.index >= 0 && pickInfo.isCluster) {
        const expansionZoom = clusterLayerRef
          ? clusterLayerRef.getClusterExpansionZoom(pickInfo.clusterId)
          : currentZoom + 2;

        deckInstance.setProps({
          initialViewState: {
            longitude: pickInfo.coordinate?.[0] ?? 0,
            latitude: pickInfo.coordinate?.[1] ?? 0,
            zoom: Math.min(expansionZoom, 20),
            transitionDuration: 500,
            transitionInterpolator: new FlyToInterpolator(),
          },
          layers: [createBasemapLayer(), createClusterLayer(table)],
        });
      }
    },
  });
}

main().catch((err) => {
  statsEl.innerHTML = `<span style="color: #ff6666">Error: ${err.message}</span>`;
  console.error(err);
});
