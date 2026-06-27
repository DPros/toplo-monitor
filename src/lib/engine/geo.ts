/**
 * GeoJSON parsing + point-in-polygon containment. Ported from the Python
 * geometry helpers. Rings are lists of [lng, lat] (GeoJSON coordinate order).
 */

/** Parse a GeoJSON string into exterior rings of [lng, lat] vertices. */
export function ringsFromGeojson(serialized?: string | null): Array<Array<[number, number]>> {
  if (!serialized) return [];
  let data: unknown;
  try {
    data = JSON.parse(serialized);
  } catch {
    return [];
  }

  const features = Array.isArray(data) ? data : [data];
  const rings: Array<Array<[number, number]>> = [];
  for (const feat of features) {
    if (typeof feat !== "object" || feat === null) continue;
    const geom = (feat as { geometry?: unknown }).geometry ?? feat;
    if (typeof geom !== "object" || geom === null) continue;
    const { type, coordinates } = geom as { type?: string; coordinates?: unknown };
    if (!coordinates) continue;

    if (type === "Polygon") {
      rings.push(toRing((coordinates as number[][][])[0]));
    } else if (type === "MultiPolygon") {
      for (const poly of coordinates as number[][][][]) {
        if (poly && poly.length) rings.push(toRing(poly[0]));
      }
    }
  }
  return rings;
}

function toRing(coords: number[][]): Array<[number, number]> {
  return coords.map(([x, y]) => [Number(x), Number(y)] as [number, number]);
}

/** Ray-casting containment test. `ring` is a list of [lng, lat] vertices. */
export function pointInPolygon(lng: number, lat: number, ring: Array<[number, number]>): boolean {
  const n = ring.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat) {
      const xCross = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (lng < xCross) inside = !inside;
    }
  }
  return inside;
}
