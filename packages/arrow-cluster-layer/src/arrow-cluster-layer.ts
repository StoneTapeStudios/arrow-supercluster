import {
  CompositeLayer,
  type UpdateParameters,
  type GetPickingInfoParams,
  type DefaultProps,
} from "@deck.gl/core";
import { ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { ArrowClusterEngine } from "arrow-supercluster";
import type { Table } from "apache-arrow";
import {
  computeFillColors,
  computeRadii,
  computeTextColors,
  computeTexts,
} from "./style-helpers";
import { resolvePickingInfo } from "./picking";
import type {
  ArrowClusterLayerProps,
  ArrowClusterLayerState,
  ArrowClusterPickingInfo,
  ColorRGBA,
} from "./types";

const DEFAULT_PRIMARY_COLOR: ColorRGBA = [26, 26, 64, 200];
const DEFAULT_SECONDARY_COLOR: ColorRGBA = [100, 100, 200, 200];
const DEFAULT_SELECTED_COLOR: ColorRGBA = [255, 140, 0, 230];

const defaultProps: DefaultProps<ArrowClusterLayerProps> = {
  geometryColumn: "geometry",
  idColumn: "id",
  clusterRadius: { type: "number", value: 75 },
  clusterMaxZoom: { type: "number", value: 20 },
  clusterMinZoom: { type: "number", value: 2 },
  clusterMinPoints: { type: "number", value: 2 },
  primaryColor: { type: "color", value: DEFAULT_PRIMARY_COLOR },
  secondaryColor: { type: "color", value: DEFAULT_SECONDARY_COLOR },
  selectedColor: { type: "color", value: DEFAULT_SELECTED_COLOR },
  textOpacity: { type: "number", value: 255 },
  pointRadiusMinPixels: { type: "number", value: 10 },
  pointRadiusMaxPixels: { type: "number", value: 100 },
  selectedClusterId: null,
  focusedClusterId: null,
  filterMask: null,
  viewType: "map",
  // Prevent engine rebuild when the same Arrow Table reference is passed.
  // deck.gl's default shallow comparison of `data` fires `dataChanged` on every
  // setProps call because a new layer instance is created. This comparator tells
  // deck.gl to treat the data as unchanged when the reference is identical.
  // Ref: https://deck.gl/docs/api-reference/core/layer#datacomparator
  dataComparator: {
    type: "function",
    value: (newData: unknown, oldData: unknown) => newData === oldData,
  },
};

export class ArrowClusterLayer extends CompositeLayer<ArrowClusterLayerProps> {
  static layerName = "ArrowClusterLayer";
  static defaultProps = defaultProps;

  state!: ArrowClusterLayerState;

  /**
   * Override default shouldUpdateState to also respond to viewport changes.
   * The default CompositeLayer implementation ignores viewport changes, but we
   * need to re-query clusters when the integer zoom level changes.
   * Ref: https://deck.gl/docs/developer-guide/custom-layers/layer-lifecycle
   */
  shouldUpdateState({
    changeFlags,
  }: UpdateParameters<ArrowClusterLayer>): boolean {
    return changeFlags.somethingChanged;
  }

  initializeState(): void {
    this.state = {
      engine: null,
      clusterOutput: null,
      focusedChildrenIds: null,
      lastQueriedZoom: -Infinity,
    };
  }

  updateState(params: UpdateParameters<ArrowClusterLayer>): void {
    const { props, oldProps, changeFlags } = params;

    let engineChanged = false;

    // Rebuild engine only when the actual table reference changes or clustering
    // config props change. The dataComparator default prop prevents spurious
    // dataChanged flags, but we add a belt-and-suspenders reference check here
    // so that even if dataChanged fires, we skip the expensive engine.load()
    // when the underlying Arrow Table hasn't actually been replaced.
    const dataActuallyChanged =
      changeFlags.dataChanged && props.data !== oldProps.data;
    if (
      dataActuallyChanged ||
      props.filterMask !== oldProps.filterMask ||
      props.clusterRadius !== oldProps.clusterRadius ||
      props.clusterMaxZoom !== oldProps.clusterMaxZoom ||
      props.clusterMinZoom !== oldProps.clusterMinZoom ||
      props.clusterMinPoints !== oldProps.clusterMinPoints
    ) {
      this._rebuildEngine(props);
      engineChanged = true;
    }

    // Only re-query clusters when the integer zoom actually changes
    const zoom = Math.floor(this.context.viewport.zoom ?? 0);
    if (engineChanged || zoom !== this.state.lastQueriedZoom) {
      this._queryClusters(zoom);
    }

    // Update focused children set when focusedClusterId changes
    if (props.focusedClusterId !== oldProps.focusedClusterId) {
      this._updateFocusedChildren(props.focusedClusterId);
    }
  }

  renderLayers() {
    const { clusterOutput, engine, focusedChildrenIds } = this.state;
    if (!clusterOutput || clusterOutput.length === 0 || !engine) return [];

    const {
      primaryColor,
      secondaryColor,
      selectedColor,
      textOpacity,
      pointRadiusMinPixels,
      pointRadiusMaxPixels,
      selectedClusterId,
      focusedClusterId,
      viewType,
    } = this.props;

    const totalPoints = engine.indexedPointCount;

    // Compute style arrays
    const fillColors = computeFillColors(
      clusterOutput,
      primaryColor!,
      secondaryColor!,
      selectedColor!,
      focusedClusterId,
      focusedChildrenIds,
      selectedClusterId,
    );
    const radii = computeRadii(clusterOutput, totalPoints);
    const textColors = computeTextColors(fillColors, textOpacity!);
    const texts = computeTexts(clusterOutput);

    // Snapshot positions for TextLayer accessors (subarray may be reused)
    const positions = clusterOutput.positions;

    const zoom = this.context.viewport.zoom ?? 0;
    const textAngle = viewType === "globe" && zoom <= 12 ? 180 : 0;

    const scatterLayer = new ScatterplotLayer(
      this.getSubLayerProps({
        id: "clusters-circle",
        updateTriggers: {
          getFillColor: [
            primaryColor,
            secondaryColor,
            selectedColor,
            selectedClusterId,
            focusedClusterId,
          ],
          getRadius: [totalPoints],
        },
      }),
      {
        data: {
          length: clusterOutput.length,
          attributes: {
            getPosition: { value: positions, size: 2 },
            getRadius: { value: radii, size: 1 },
            getFillColor: { value: fillColors, size: 4 },
          },
        },
        radiusUnits: "pixels",
        radiusMinPixels: pointRadiusMinPixels,
        radiusMaxPixels: pointRadiusMaxPixels,
        stroked: true,
        filled: true,
        lineWidthMinPixels: 1,
        getLineColor: [0, 0, 0, 255],
        pickable: true,
        parameters: {
          cullMode: "back",
        },
      },
    );

    // TextLayer — only render for clusters (pointCount > 1)
    // Filter to cluster-only entries for text rendering
    const clusterIndices: number[] = [];
    for (let i = 0; i < clusterOutput.length; i++) {
      if (clusterOutput.isCluster[i] === 1) {
        clusterIndices.push(i);
      }
    }

    const textLayer = new TextLayer(
      this.getSubLayerProps({
        id: "clusters-text",
        updateTriggers: {
          getColor: [
            primaryColor,
            secondaryColor,
            selectedColor,
            selectedClusterId,
            focusedClusterId,
            textOpacity,
          ],
          getAngle: [viewType, zoom],
        },
      }),
      {
        data: clusterIndices,
        getPosition: (idx: number) => [
          positions[idx * 2],
          positions[idx * 2 + 1],
        ],
        getText: (idx: number) => texts[idx]!,
        getColor: (idx: number) => [
          textColors[idx * 4],
          textColors[idx * 4 + 1],
          textColors[idx * 4 + 2],
          textColors[idx * 4 + 3],
        ],
        getSize: 18,
        getAngle: textAngle,
        getTextAnchor: "middle",
        getAlignmentBaseline: "center",
        billboard: false,
        fontSettings: { sdf: true },
        pickable: false,
        parameters: {
          cullMode: "front",
        },
      },
    );

    return [scatterLayer, textLayer];
  }

  getPickingInfo(params: GetPickingInfoParams): ArrowClusterPickingInfo {
    const { clusterOutput, engine } = this.state;
    const table = this.props.data as Table;
    return resolvePickingInfo(params.info, clusterOutput, engine, table);
  }

  /**
   * Get the zoom level at which a cluster expands into its children.
   * Public method consumed by the host app (e.g. for zoom-on-click).
   */
  getClusterExpansionZoom(clusterId: number): number {
    const { engine } = this.state;
    if (!engine) return 0;
    return engine.getClusterExpansionZoom(clusterId);
  }

  // --- Private helpers ---

  private _rebuildEngine(props: ArrowClusterLayerProps): void {
    const table = props.data as Table;
    if (!table || table.numRows === 0) {
      this.setState({ engine: null, clusterOutput: null });
      return;
    }

    const engine = new ArrowClusterEngine({
      radius: props.clusterRadius,
      maxZoom: props.clusterMaxZoom,
      minZoom: props.clusterMinZoom,
      minPoints: props.clusterMinPoints,
    });

    engine.load(
      table,
      props.geometryColumn ?? "geometry",
      props.idColumn ?? "id",
      props.filterMask ?? null,
    );
    this.setState({ engine });
  }

  private _queryClusters(zoom: number): void {
    const { engine } = this.state;
    if (!engine) {
      this.setState({ clusterOutput: null, lastQueriedZoom: zoom });
      return;
    }

    const clusterOutput = engine.getClusters([-180, -85, 180, 85], zoom);
    this.setState({ clusterOutput, lastQueriedZoom: zoom });
  }

  private _updateFocusedChildren(
    focusedClusterId: number | null | undefined,
  ): void {
    const { engine } = this.state;
    if (!engine || focusedClusterId == null) {
      this.setState({ focusedChildrenIds: null });
      return;
    }

    // Get all leaf indices for the focused cluster
    const leafIndices = engine.getLeaves(focusedClusterId);
    this.setState({ focusedChildrenIds: new Set(leafIndices) });
  }
}
