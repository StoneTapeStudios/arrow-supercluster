import type { ClusterOutput } from "arrow-supercluster";
import type { ColorRGBA } from "./types";

/**
 * Compute fill colors for each cluster/point.
 *
 * - Focused cluster + its descendants → secondaryColor
 * - Selected cluster → selectedColor
 * - Everything else → primaryColor
 */
export function computeFillColors(
  output: ClusterOutput,
  primaryColor: ColorRGBA,
  secondaryColor: ColorRGBA,
  selectedColor: ColorRGBA,
  focusedClusterId: number | null | undefined,
  focusedChildrenIds: Set<number> | null | undefined,
  selectedClusterId: number | null | undefined,
): Uint8Array {
  const { length, ids, isCluster } = output;
  const colors = new Uint8Array(length * 4);

  for (let i = 0; i < length; i++) {
    const id = ids[i];
    const offset = i * 4;

    let color: ColorRGBA;
    if (selectedClusterId != null && id === selectedClusterId) {
      color = selectedColor;
    } else if (
      focusedClusterId != null &&
      (id === focusedClusterId ||
        (focusedChildrenIds != null && focusedChildrenIds.has(id)))
    ) {
      color = secondaryColor;
    } else {
      color = primaryColor;
    }

    colors[offset] = color[0];
    colors[offset + 1] = color[1];
    colors[offset + 2] = color[2];
    colors[offset + 3] = color[3];
  }

  return colors;
}

/**
 * Compute radii for each cluster/point using log-scaled formula.
 * Matches the existing EventsClusterLayer radius calculation.
 */
export function computeRadii(
  output: ClusterOutput,
  totalPoints: number,
): Float32Array {
  const BASE_SIZE = 4;
  const SCALE_FACTOR = 50;
  const { length, pointCounts } = output;
  const radii = new Float32Array(length);

  const logTotal = Math.log(totalPoints + 1);

  for (let i = 0; i < length; i++) {
    const count = pointCounts[i];
    radii[i] = BASE_SIZE + (Math.log(count + 1) / logTotal) * SCALE_FACTOR;
  }

  return radii;
}

/**
 * Linearize an sRGB channel value for luminance calculation.
 */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Compute text colors (black or white) based on fill color luminance.
 * Uses relative luminance with sRGB linearization.
 */
export function computeTextColors(
  fillColors: Uint8Array,
  textOpacity: number,
): Uint8Array {
  const length = fillColors.length / 4;
  const textColors = new Uint8Array(length * 4);

  for (let i = 0; i < length; i++) {
    const offset = i * 4;
    const r = fillColors[offset];
    const g = fillColors[offset + 1];
    const b = fillColors[offset + 2];

    const luminance =
      0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);

    const textValue = luminance > 0.179 ? 0 : 255;
    textColors[offset] = textValue;
    textColors[offset + 1] = textValue;
    textColors[offset + 2] = textValue;
    textColors[offset + 3] = textOpacity;
  }

  return textColors;
}

/**
 * Compute text labels for clusters. Individual points get null.
 */
export function computeTexts(output: ClusterOutput): (string | null)[] {
  const { length, pointCounts, isCluster } = output;
  const texts: (string | null)[] = new Array(length);

  for (let i = 0; i < length; i++) {
    texts[i] = isCluster[i] ? String(pointCounts[i]) : null;
  }

  return texts;
}
