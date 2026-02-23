import { Deck, MapView } from "@deck.gl/core";
import {
  makeVector,
  vectorFromArray,
  Table,
  Float64,
  Int32,
  Utf8,
  Field,
  FixedSizeList,
} from "apache-arrow";
import { ArrowClusterLayer } from "arrow-cluster-layer";
import type { ArrowClusterPickingInfo } from "arrow-cluster-layer";

// --- Generate synthetic data ---

function seededRandom(seed: number) {
  return () => {
    seed = (seed * 16807 + 0) % 2147483647;
    return seed / 2147483647;
  };
}

const NUM_POINTS = 50_000;
const rand = seededRandom(42);

// Generate clusters of points around world cities
const CITY_CENTERS: [number, number, string][] = [
  [-122.42, 37.78, "San Francisco"],
  [-73.97, 40.76, "New York"],
  [-0.12, 51.51, "London"],
  [2.35, 48.86, "Paris"],
  [139.69, 35.69, "Tokyo"],
  [151.21, -33.87, "Sydney"],
  [-43.17, -22.91, "Rio de Janeiro"],
  [28.98, 41.01, "Istanbul"],
  [77.21, 28.61, "New Delhi"],
  [37.62, 55.75, "Moscow"],
  [-118.24, 34.05, "Los Angeles"],
  [13.41, 52.52, "Berlin"],
  [100.5, 13.76, "Bangkok"],
  [-46.63, -23.55, "São Paulo"],
  [31.24, 30.04, "Cairo"],
];

const lngs = new Float64Array(NUM_POINTS);
const lats = new Float64Array(NUM_POINTS);
const cityNames: string[] = [];

for (let i = 0; i < NUM_POINTS; i++) {
  const cityIdx = Math.floor(rand() * CITY_CENTERS.length);
  const [cLng, cLat, name] = CITY_CENTERS[cityIdx];
  // Spread points around the city center with gaussian-ish distribution
  const spread = 2 + rand() * 5;
  lngs[i] = cLng + (rand() - 0.5) * spread;
  lats[i] = Math.max(-85, Math.min(85, cLat + (rand() - 0.5) * spread));
  cityNames.push(name);
}

// --- Build Arrow Table ---

const coordData: [number, number][] = [];
for (let i = 0; i < NUM_POINTS; i++) {
  coordData.push([lngs[i], lats[i]]);
}

const childField = new Field("xy", new Float64());
const listType = new FixedSizeList(2, childField);
const geomVector = vectorFromArray(coordData, listType);

const ids = new Int32Array(NUM_POINTS);
for (let i = 0; i < NUM_POINTS; i++) ids[i] = i;
const idVector = makeVector(ids);

const cityVector = vectorFromArray(cityNames, new Utf8());

const table = new Table({
  geometry: geomVector,
  id: idVector,
  city: cityVector,
});

// --- UI state ---

let selectedClusterId: number | null = null;
let focusedClusterId: number | null = null;
let currentZoom = 2;

const statsEl = document.getElementById("stats")!;
const hoverEl = document.getElementById("hover-info")!;

function updateStats() {
  statsEl.innerHTML = `
    Points: <span class="stat">${NUM_POINTS.toLocaleString()}</span><br>
    Zoom: <span class="stat">${currentZoom}</span><br>
    Arrow Table rows: <span class="stat">${table.numRows.toLocaleString()}</span><br>
    <br>
    <em>Click a cluster to select it.<br>
    Hover to see details.<br>
    Scroll to zoom.</em>
  `;
}
updateStats();

// --- Deck.gl setup ---

function createLayer() {
  return new ArrowClusterLayer({
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
}

const deckInstance = new Deck({
  views: new MapView({ repeat: true }),
  initialViewState: {
    longitude: 0,
    latitude: 20,
    zoom: 2,
  },
  controller: true,
  layers: [createLayer()],
  getTooltip: () => null,

  onViewStateChange: ({ viewState }) => {
    const newZoom = Math.floor(viewState.zoom);
    if (newZoom !== currentZoom) {
      currentZoom = newZoom;
      updateStats();
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

      // Set focused on hover
      if (pickInfo.isCluster && pickInfo.clusterId !== focusedClusterId) {
        focusedClusterId = pickInfo.clusterId;
        deckInstance.setProps({ layers: [createLayer()] });
      }
    } else {
      hoverEl.style.display = "none";
      if (focusedClusterId !== null) {
        focusedClusterId = null;
        deckInstance.setProps({ layers: [createLayer()] });
      }
    }
  },

  onClick: (info) => {
    const pickInfo = info as ArrowClusterPickingInfo;
    if (pickInfo.index >= 0 && pickInfo.isCluster) {
      if (selectedClusterId === pickInfo.clusterId) {
        // Deselect
        selectedClusterId = null;
      } else {
        selectedClusterId = pickInfo.clusterId;
      }
      deckInstance.setProps({ layers: [createLayer()] });
    } else {
      if (selectedClusterId !== null) {
        selectedClusterId = null;
        deckInstance.setProps({ layers: [createLayer()] });
      }
    }
  },
});
