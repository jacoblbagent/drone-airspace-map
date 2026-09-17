// ============================================================================
// Map-layer data for the current viewport — all authoritative sources.
//
// These used to come from OpenStreetMap via Overpass. The public Overpass
// mirrors proved unusable here (dead hosts, plus one that answers HTTP 200
// with an empty database), so the layers now come from the same FAA/NPS
// ArcGIS services the click-through lookup uses:
//
//   • Airports & heliports  → FAA ADHP (real FAA idents / ICAO codes)
//   • Controlled airspace   → FAA Class Airspace (real Class B/C/D/E-surface
//                             polygons, replacing the old circle guesses)
//   • Protected / restricted→ NPS unit boundaries + FAA Special Use Airspace
//                             (Prohibited / Restricted / National Security)
// ============================================================================

import { type AirportModel, modelAirport } from "./airspace";

const FAA = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services";
const NPS_ROOT = "https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services";
const NPS_SVC = "NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service";
const NPS_LAYER = 2;

const TIMEOUT = 30_000;

interface ArcFeature {
  attributes: Record<string, unknown>;
  /** Polygons carry `rings`; point layers carry `x`/`y`. */
  geometry?: { x?: number; y?: number; rings?: number[][][] };
}

async function bboxQuery(
  base: string,
  svc: string,
  layer: number,
  outFields: string,
  b: { south: number; west: number; north: number; east: number },
  opts: { where?: string; limit?: number; simplify?: number } = {},
): Promise<ArcFeature[]> {
  const params: Record<string, string> = {
    f: "json",
    where: opts.where || "1=1",
    outFields,
    returnGeometry: "true",
    outSR: "4326",
    geometry: JSON.stringify({
      xmin: b.west,
      ymin: b.south,
      xmax: b.east,
      ymax: b.north,
      spatialReference: { wkid: 4326 },
    }),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    resultRecordCount: String(opts.limit ?? 300),
  };
  if (opts.simplify != null) params.maxAllowableOffset = String(opts.simplify);

  const url = `${base}/${svc}/FeatureServer/${layer}/query?${new URLSearchParams(params)}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) throw new Error(`FAA layer HTTP ${res.status}`);
      const json = (await res.json()) as {
        features?: ArcFeature[];
        error?: { message: string };
      };
      if (json.error) throw new Error(json.error.message);
      return json.features || [];
    } catch (e) {
      lastErr = e;
      if (attempt === 1) throw e;
      await new Promise((r) => setTimeout(r, 700));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** ArcGIS rings ([lng,lat]) → decimated [lat,lng] rings. */
function toRings(
  rings: number[][][] | undefined,
  maxPoints = 500,
): Array<Array<[number, number]>> {
  if (!rings?.length) return [];
  const out: Array<Array<[number, number]>> = [];
  for (const ring of rings) {
    if (ring.length < 4) continue;
    const step = Math.max(1, Math.ceil(ring.length / maxPoints));
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < ring.length; i += step) {
      const [x, y] = ring[i];
      pts.push([y, x]);
    }
    if (pts.length >= 4) out.push(pts);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Airports & heliports
// ---------------------------------------------------------------------------

/** Fetch FAA airports/heliports within the viewport. */
export async function fetchAirports(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<AirportModel[]> {
  const fs = await bboxQuery(
    FAA,
    "ADHP",
    0,
    "IDENT_TXT,NAME_TXT,ICAO_TXT,TYPE_CODE,SERVICINGCITY_TXT,MILITARY_CODE,PRIVATEUSE_CODE",
    { south, west, north, east },
    { limit: 900 },
  );
  const airports: AirportModel[] = [];
  for (const f of fs) {
    const a = f.attributes;
    // ADHP is a point layer, so the position arrives as x/y, not rings.
    const lat = f.geometry?.y;
    const lng = f.geometry?.x;
    if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) continue;
    const icao = a.ICAO_TXT ? String(a.ICAO_TXT) : "";
    const mil = String(a.MILITARY_CODE || "");
    const type = String(a.TYPE_CODE || "");
    // Reuse the shared classifier with synthesized tags so downstream code
    // (marker colouring, popups) keeps working.
    const tags: Record<string, string | undefined> = {
      icao: icao || undefined,
      military: /MIL/i.test(mil) && !/CIVIL/i.test(mil) ? "airport" : undefined,
      "aerodrome:type": type === "HP" ? "heliport" : undefined,
      type: type || undefined,
      city: a.SERVICINGCITY_TXT ? String(a.SERVICINGCITY_TXT) : undefined,
      private: String(a.PRIVATEUSE_CODE || "").toUpperCase().startsWith("P")
        ? "yes"
        : undefined,
    };
    airports.push(
      modelAirport(String(a.NAME_TXT || a.IDENT_TXT || "Airport"), lat, lng, tags),
    );
  }
  return airports;
}

// ---------------------------------------------------------------------------
// Controlled airspace polygons (replaces the old circular approximation)
// ---------------------------------------------------------------------------

export interface AirspaceZone {
  id: string;
  name: string;
  cls: string;
  ident?: string;
  floor?: string;
  ceiling?: string;
  geometry: Array<Array<[number, number]>>;
}

function fmtLimit(val: unknown, code?: unknown): string | undefined {
  const v = Number(val);
  if (!isFinite(v)) return undefined;
  if (v === -9998) return "unlimited";
  const c = String(code || "");
  if (v === 0) return "surface";
  return c === "MSL" ? `${v.toLocaleString()} ft MSL` : `${v.toLocaleString()} ft AGL`;
}

/**
 * Surface-level controlled airspace: Class B, C, D, and Class E surface
 * areas. Class E transition areas (700/1200 ft AGL) and Class A are excluded
 * — they cannot constrain a 400 ft AGL Part 107 flight.
 */
export async function fetchControlledAirspace(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<AirspaceZone[]> {
  const fs = await bboxQuery(
    FAA,
    "Class_Airspace",
    0,
    "NAME,CLASS,UPPER_VAL,UPPER_CODE,LOWER_VAL,LOWER_CODE,ICAO_ID",
    { south, west, north, east },
    {
      where: "CLASS IN ('B','C','D') OR (CLASS = 'E' AND LOWER_VAL = 0)",
      limit: 200,
      simplify: 0.0015,
    },
  );
  const zones: AirspaceZone[] = [];
  for (const f of fs) {
    const a = f.attributes;
    const geometry = toRings(f.geometry?.rings);
    if (!geometry.length) continue;
    zones.push({
      id: `${f.attributes.OBJECTID ?? ""}-${a.NAME}-${a.LOWER_VAL}`,
      name: String(a.NAME || "Controlled airspace"),
      cls: String(a.CLASS || "-"),
      ident: a.ICAO_ID ? String(a.ICAO_ID) : undefined,
      floor: fmtLimit(a.LOWER_VAL, a.LOWER_CODE),
      ceiling: fmtLimit(a.UPPER_VAL, a.UPPER_CODE),
      geometry,
    });
  }
  return zones;
}

// ---------------------------------------------------------------------------
// Protected / restricted areas
// ---------------------------------------------------------------------------

export interface NoFlyZone {
  type: string;
  id: number;
  name: string;
  kind: string; // 'park' | 'military' | 'restricted'
  geometry: Array<Array<[number, number]>>; // rings of [lat, lng]
}

/** NPS unit boundaries + Prohibited/Restricted/National-Security airspace. */
export async function fetchNoFlyZones(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<NoFlyZone[]> {
  const b = { south, west, north, east };
  const [nps, sua] = await Promise.all([
    bboxQuery(
      NPS_ROOT,
      NPS_SVC,
      NPS_LAYER,
      "OBJECTID,UNIT_CODE,UNIT_NAME,UNIT_TYPE",
      b,
      { limit: 80, simplify: 0.002 },
    ).catch(() => [] as ArcFeature[]),
    bboxQuery(
      FAA,
      "Special_Use_Airspace",
      0,
      "OBJECTID,NAME,TYPE_CODE,CITY,STATE",
      b,
      { where: "TYPE_CODE IN ('P','R','NSA')", limit: 80, simplify: 0.002 },
    ).catch(() => [] as ArcFeature[]),
  ]);

  const zones: NoFlyZone[] = [];
  for (const f of nps) {
    const a = f.attributes;
    const geometry = toRings(f.geometry?.rings);
    if (!geometry.length) continue;
    zones.push({
      type: "nps",
      id: Number(a.OBJECTID ?? 0),
      name: String(a.UNIT_NAME || "National Park Service area"),
      kind: "park",
      geometry,
    });
  }
  for (const f of sua) {
    const a = f.attributes;
    const geometry = toRings(f.geometry?.rings);
    if (!geometry.length) continue;
    zones.push({
      type: "sua",
      id: Number(a.OBJECTID ?? 0),
      name: String(a.NAME || "Restricted area"),
      kind: "military",
      geometry,
    });
  }
  return zones;
}
