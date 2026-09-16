/** Point-in-polygon (ray casting) for [lat, lng] points and ring arrays. */
export function pointInRing(
  lat: number,
  lng: number,
  ring: Array<[number, number]>,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** True if the point is inside ANY ring of a zone (outer only, holes ignored). */
export function pointInZone(
  lat: number,
  lng: number,
  ring: Array<Array<[number, number]>>,
): boolean {
  if (!ring.length) return false;
  return pointInRing(lat, lng, ring[0]);
}