// ============================================================================
// Overpass (OpenStreetMap) data integration.
// Pulls real, live airport positions and no-fly polygons (national parks,
// nature reserves, restricted areas) for the visible map bounds.
// ============================================================================

import { modelAirport, type AirportModel } from "./airspace";

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];
const TIMEOUT = 35_000; // ms until we abort a request

function bboxStr(south: number, west: number, north: number, east: number) {
  return `${south.toFixed(4)},${west.toFixed(4)},${north.toFixed(4)},${east.toFixed(4)}`;
}

async function query(program: string, signal: AbortSignal) {
  // Try each mirror in turn; within a mirror, retry transient failures
  // (429 / 5xx / network) with backoff. Public instances rate-limit, so a
  // fallback chain keeps the app alive when one instance blocks us.
  let lastErr: unknown;
  for (const ENDPOINT of MIRRORS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw lastErr ?? new Error("aborted");
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: program }),
          signal,
        });
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`Overpass HTTP ${res.status} (${ENDPOINT})`);
        }
        if (!res.ok) throw new Error(`Overpass HTTP ${res.status} (${ENDPOINT})`);
        const json = await res.json();
        return json.elements || [];
      } catch (e) {
        lastErr = e;
        if (signal.aborted) throw e;
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  properties?: Record<string, string>;
  members?: Array<{ role?: string; ref: number; geometry?: Array<{ lat: number; lon: number }> }>;
  geometry?: Array<{ lat: number; lon: number }>;
}

/** Fetch aerodromes in the bbox and return modeled airports. */
export async function fetchAirports(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<AirportModel[]> {
  const program = `[out:json][timeout:25];
  (
    node["aeroway"="aerodrome"](${bboxStr(south, west, north, east)});
    way["aeroway"="aerodrome"](${bboxStr(south, west, north, east)});
    relation["aeroway"="aerodrome"](${bboxStr(south, west, north, east)});
  );
  out center tags;`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const elements = await query(program, ac.signal);
    const seen = new Set<number>();
    const airports: AirportModel[] = [];
    for (const el of elements as OsmElement[]) {
      if (seen.has(el.id)) continue;
      seen.add(el.id);
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      const tags = el.tags || {};
      if (lat == null || lng == null) continue;
      const name = tags.name || tags["ref"] || tags.iata || `Aerodrome ${el.id}`;
      airports.push(modelAirport(name, lat, lng, tags));
    }
    return airports;
  } finally {
    clearTimeout(timer);
  }
}

export interface NoFlyZone {
  type: string;
  id: number;
  name: string;
  kind: string; // 'national_park' | 'reserve' | 'military' | 'restricted'
  geometry: Array<Array<[number, number]>>; // rings of [lat, lng]
}

/** Fetch no-fly polygons in the bbox (parks + restricted areas). */
export async function fetchNoFlyZones(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<NoFlyZone[]> {
  const bb = bboxStr(south, west, north, east);
  const program = `[out:json][timeout:25];
  (
    way["boundary"="national_park"](${bb});
    relation["boundary"="national_park"](${bb});
    way["landuse"="military"](${bb});
    relation["landuse"="military"](${bb});
  );
  out geom tags;`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const elements = await query(program, ac.signal);
    const zones: NoFlyZone[] = [];
    for (const el of elements as OsmElement[]) {
      const tags = el.tags || {};
      const typeName = tags["boundary"] || tags["leisure"] || tags["landuse"] || "";
      const kind =
        typeName === "military" ? "military" : isRestrictedType(tags) ? "restricted" : "park";
      const name =
        tags.name ||
        tags["protection_title"] ||
        (el.type === "relation" && el.properties?.name) ||
        `${kind === "park" ? "Protected area" : "Restricted area"} ${el.id}`;
      const geom = ringGeometry(el);
      if (!geom) continue;
      zones.push({ type: el.type, id: el.id, name, kind, geometry: geom });
    }
    return zones;
  } finally {
    clearTimeout(timer);
  }
}

function isRestrictedType(tags: Record<string, string>): boolean {
  const t = tags["boundary"] || tags["leisure"] || tags["landuse"] || "";
  return /military|danger|restricted|no.?fly/i.test(t);
}

/** Convert an OSM element to polygon rings (outer + holes), decimated. */
function ringGeometry(el: OsmElement): Array<Array<[number, number]>> | null {
  const rings: Array<Array<[number, number]>> = [];
  if (el.type === "way") {
    const c = el.geometry;
    if (c && c.length >= 4) {
      rings.push(c.map((p) => [p.lat, p.lon]));
    }
  } else if (el.type === "relation") {
    // `out geom` attaches each way member's geometry under members[].
    const outers = (el.members || [])
      .filter((m) => m.role === "outer" && m.geometry && m.geometry.length >= 4);
    for (const m of outers) {
      rings.push(m.geometry!.map((p) => [p.lat, p.lon]));
    }
  }
  if (!rings.length) return null;
  return rings.map((r) => decimate(r));
}

/** Douglas-Peucker-lite decimation so huge park outlines stay light. */
function decimate(pts: Array<[number, number]>, tol = 0.0015): Array<[number, number]> {
  if (pts.length <= 30) return pts;
  const keep: boolean[] = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(pts[i], pts[a], pts[b]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function perpDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const [x, y] = p;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(x - a[0], y - a[1]);
  const t = ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy);
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return Math.hypot(x - cx, y - cy);
}