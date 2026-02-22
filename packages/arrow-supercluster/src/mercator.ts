/**
 * Mercator projection utilities — same math as Supercluster.
 * Converts between lng/lat (WGS84) and Mercator x/y (0..1 range).
 */

const { fround } = Math;

/** Longitude to Mercator x (0..1) */
export function lngX(lng: number): number {
  return lng / 360 + 0.5;
}

/** Latitude to Mercator y (0..1) */
export function latY(lat: number): number {
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI;
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/** Mercator x (0..1) to longitude */
export function xLng(x: number): number {
  return (x - 0.5) * 360;
}

/** Mercator y (0..1) to latitude */
export function yLat(y: number): number {
  const y2 = ((180 - y * 360) * Math.PI) / 180;
  return (360 * Math.atan(Math.exp(y2))) / Math.PI - 90;
}

export { fround };
