import { Deck, MapView, FlyToInterpolator } from "@deck.gl/core";
import { BitmapLayer } from "@deck.gl/layers";
import { TileLayer } from "@deck.gl/geo-layers";
import { tableFromIPC, type Table } from "apache-arrow";
import initParquetWasm, { readParquet } from "parquet-wasm";
import { ArrowClusterLayer } from "arrow-cluster-layer";
import type { ArrowClusterPickingInfo } from "arrow-cluster-layer";

// --- Dataset options ---

type DatasetKey = "200k" | "1m" | "2m";

const DATASETS: Record<
  DatasetKey,
  { url: string; label: string; batchSize: number }
> = {
  "200k": {
    url: "/data/points-200k.parquet",
    label: "200K points (~2 MB)",
    batchSize: 210_000,
  },
  "1m": {
    url: "/data/points-1m.parquet",
    label: "1M points (~10 MB)",
    batchSize: 1_100_000,
  },
  "2m": {
    url: "/data/points-2m.parquet",
    label: "2M points (~20 MB)",
    batchSize: 2_100_000,
  },
};

let currentDataset: DatasetKey = "200k";
let wasmReady = false;

// --- Load GeoParquet → Arrow Table ---

async function loadParquetTable(key: DatasetKey): Promise<Table> {
  if (!wasmReady) {
    await initParquetWasm();
    wasmReady = true;
  }

  const { url, batchSize } = DATASETS[key];
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());

  const wasmTable = readParquet(buf, { batchSize });
  return tableFromIPC(wasmTable.intoIPCStream());
}

// --- Filter mask builder ---

function buildCityMask(table: Table, activeCities: Set<string>): Uint8Array {
  const mask = new Uint8Array(table.numRows);
  const cityCol = table.getChild("city")!;
  for (let i = 0; i < table.numRows; i++) {
    mask[i] = activeCities.has(cityCol.get(i) as string) ? 1 : 0;
  }
  return mask;
}

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
const loadingEl = document.getElementById("loading-overlay")!;

function showLoading(message: string) {
  loadingEl.querySelector(".loading-text")!.textContent = message;
  loadingEl.classList.remove("hidden");
}

function hideLoading() {
  loadingEl.classList.add("hidden");
}

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

// --- Dataset picker ---

function createDatasetPicker(onChange: (key: DatasetKey) => void): HTMLElement {
  const picker = document.createElement("div");
  picker.id = "dataset-picker";

  const label = document.createElement("h3");
  label.textContent = "Dataset";
  picker.appendChild(label);

  for (const [key, { label: text }] of Object.entries(DATASETS)) {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.dataset.key = key;
    if (key === currentDataset) btn.classList.add("active");
    btn.onclick = () => {
      if (key === currentDataset) return;
      picker
        .querySelectorAll("button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onChange(key as DatasetKey);
    };
    picker.appendChild(btn);
  }

  document.body.appendChild(picker);
  return picker;
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
  showLoading("Loading GeoParquet…");

  let table = await loadParquetTable(currentDataset);
  const cities = getUniqueCities(table);
  activeCities = new Set(cities);

  function getFilteredCount(): number {
    if (!filterMask) return table.numRows;
    let count = 0;
    for (let i = 0; i < filterMask.length; i++) {
      if (filterMask[i]) count++;
    }
    return count;
  }

  updateStats(table, table.numRows);

  showLoading("Building clusters…");

  let loadingPending = true;

  const deckInstance = new Deck({
    views: new MapView({ repeat: true }),
    initialViewState: {
      longitude: 0,
      latitude: 20,
      zoom: 2,
      minZoom: 2,
    },
    controller: true,
    layers: [createBasemapLayer(), createClusterLayer(table)],
    getTooltip: () => null,

    onAfterRender: () => {
      if (loadingPending) {
        loadingPending = false;
        hideLoading();
      }
    },

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
    if (activeCities.size === cities.length) {
      filterMask = null;
    } else {
      filterMask = buildCityMask(table, activeCities);
    }

    showLoading("Rebuilding clusters…");

    setTimeout(() => {
      const t = performance.now();
      deckInstance.setProps({
        layers: [createBasemapLayer(), createClusterLayer(table)],
      });
      console.log(`Filter applied in ${(performance.now() - t).toFixed(0)}ms`);
      updateStats(table, getFilteredCount());
      loadingPending = true;
    }, 0);
  }

  // --- Dataset switching ---

  createDatasetPicker(async (key) => {
    currentDataset = key;
    showLoading(`Loading ${DATASETS[key].label}…`);

    try {
      // Release old data before loading new dataset to avoid holding
      // both in memory simultaneously (matters for large datasets on
      // constrained devices).
      // @ts-expect-error — intentional null to release Arrow Table reference
      table = null;
      filterMask = null;
      selectedClusterId = null;
      focusedClusterId = null;

      const t0 = performance.now();
      table = await loadParquetTable(key);
      console.log(
        `Loaded ${table.numRows.toLocaleString()} rows in ${(performance.now() - t0).toFixed(0)}ms`,
      );

      activeCities = new Set(getUniqueCities(table));
      updateCheckboxes(filterPanel, activeCities);
      updateStats(table, table.numRows);

      showLoading("Building clusters…");
      setTimeout(() => {
        deckInstance.setProps({
          layers: [createBasemapLayer(), createClusterLayer(table)],
        });
        loadingPending = true;
      }, 0);
    } catch (err) {
      hideLoading();
      statsEl.innerHTML = `<span style="color: #ff6666">Error loading dataset: ${(err as Error).message}</span>`;
    }
  });

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
