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
  await initParquetWasm();

  const resp = await fetch(PARQUET_URL);
  if (!resp.ok)
    throw new Error(`Failed to fetch ${PARQUET_URL}: ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());

  const wasmTable = readParquet(buf, { batchSize: 2_100_000 });
  return tableFromIPC(wasmTable.intoIPCStream());
}

// --- Filter mask builder ---

/**
 * Build a Uint8Array mask from the city column and active city set.
 * 0 = excluded, 1 = included. O(n) single pass.
 */
function buildCityMask(table: Table, activeCities: Set<string>): Uint8Array {
  const mask = new Uint8Array(table.numRows);
  const cityCol = table.getChild("city")!;
  for (let i = 0; i < table.numRows; i++) {
    mask[i] = activeCities.has(cityCol.get(i) as string) ? 1 : 0;
  }
  return mask;
}

/**
 * Extract unique city names from the table's city column.
 */
function getUniqueCities(table: Table): string[] {
  const cityCol = table.getChild("city")!;
  const seen = new Set<string>();
  for (let i = 0; i < table.numRows; i++) {
    seen.add(cityCol.get(i) as string);
  }
  return Array.from(seen).sort();
}

// --- UI state ---

let selectedClusterId: number | null = null;
let focusedClusterId: number | null = null;
let currentZoom = 2;
let activeCities: Set<string> = new Set();
let filterMask: Uint8Array | null = null;

const statsEl = document.getElementById("stats")!;
const hoverEl = document.getElementById("hover-info")!;

function updateStats(table: Table, filteredCount: number) {
  const total = table.numRows.toLocaleString();
  const filtered = filteredCount.toLocaleString();
  const isFiltered = filterMask !== null;
  statsEl.innerHTML = `
    Points: <span class="stat">${total}</span>
    ${isFiltered ? `(showing <span class="stat">${filtered}</span>)` : ""}<br>
    Zoom: <span class="stat">${currentZoom}</span><br>
    Cities: <span class="stat">${activeCities.size}</span> active<br>
    <br>
    <em>Click a cluster to select it.<br>
    Hover to see details.<br>
    Toggle regions in the filter panel.</em>
  `;
}

// --- Filter panel ---

function createFilterPanel(
  cities: string[],
  onToggle: (city: string) => void,
  onToggleAll: (selectAll: boolean) => void,
): HTMLElement {
  const panel = document.createElement("div");
  panel.id = "filter-panel";

  const header = document.createElement("div");
  header.className = "filter-header";
  header.innerHTML = `<h3>Region Filter</h3>`;

  const controls = document.createElement("div");
  controls.className = "filter-controls";

  const allBtn = document.createElement("button");
  allBtn.textContent = "All";
  allBtn.onclick = () => onToggleAll(true);

  const noneBtn = document.createElement("button");
  noneBtn.textContent = "None";
  noneBtn.onclick = () => onToggleAll(false);

  controls.appendChild(allBtn);
  controls.appendChild(noneBtn);
  header.appendChild(controls);
  panel.appendChild(header);

  const hint = document.createElement("div");
  hint.className = "filter-hint";
  hint.textContent =
    "Points are spread around each city center. Clusters may appear outside city limits.";
  panel.appendChild(hint);

  const list = document.createElement("div");
  list.className = "filter-list";

  for (const city of cities) {
    const label = document.createElement("label");
    label.className = "filter-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.city = city;
    checkbox.onchange = () => onToggle(city);

    const span = document.createElement("span");
    span.textContent = city;

    label.appendChild(checkbox);
    label.appendChild(span);
    list.appendChild(label);
  }

  panel.appendChild(list);
  document.body.appendChild(panel);
  return panel;
}

function updateCheckboxes(panel: HTMLElement, activeCities: Set<string>) {
  const checkboxes = panel.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  for (const cb of checkboxes) {
    cb.checked = activeCities.has(cb.dataset.city!);
  }
}

// --- Basemap layer ---

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
    filterMask,
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

  // Extract unique cities and initialize all as active
  const cities = getUniqueCities(table);
  activeCities = new Set(cities);

  // Helper to count active points in the current mask
  function getFilteredCount(): number {
    if (!filterMask) return table.numRows;
    let count = 0;
    for (let i = 0; i < filterMask.length; i++) {
      if (filterMask[i]) count++;
    }
    return count;
  }

  updateStats(table, table.numRows);

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
        updateStats(table, getFilteredCount());
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

  // --- Rebuild layers when filter changes ---

  function applyFilter() {
    // When all cities are active, pass null (no filter) for best performance
    if (activeCities.size === cities.length) {
      filterMask = null;
    } else {
      filterMask = buildCityMask(table, activeCities);
    }

    const t = performance.now();
    deckInstance.setProps({
      layers: [createBasemapLayer(), createClusterLayer(table)],
    });
    console.log(`Filter applied in ${(performance.now() - t).toFixed(0)}ms`);

    updateStats(table, getFilteredCount());
  }

  // --- Create filter panel ---

  const filterPanel = createFilterPanel(
    cities,
    (city) => {
      if (activeCities.has(city)) {
        activeCities.delete(city);
      } else {
        activeCities.add(city);
      }
      applyFilter();
    },
    (selectAll) => {
      if (selectAll) {
        activeCities = new Set(cities);
      } else {
        activeCities.clear();
      }
      updateCheckboxes(filterPanel, activeCities);
      applyFilter();
    },
  );
}

main().catch((err) => {
  statsEl.innerHTML = `<span style="color: #ff6666">Error: ${err.message}</span>`;
  console.error(err);
});
