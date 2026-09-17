// ============================================================================
// FAA / NPS live data layer (ArcGIS FeatureServer REST).
//
// All data here is authoritative and queried live per map click:
//   • FAA UAS Facility Map  — LAANC grid ceilings (ft AGL)
//   • FAA Class Airspace    — real Class A/B/C/D/E polygons + vertical limits
//   • FAA Special Use Airspace (MOA / Restricted / Prohibited / Alert / NSA)
//   • FAA Part-Time National Security UAS Flight Restrictions
//   • FAA ADHP              — airports & heliports (ident, ICAO, type, city)
//   • FAA Recreational Flyer Fixed Sites
//   • NPS Land Resources    — park unit boundaries (parks, parkways, trails)
//
// Both hosts send `access-control-allow-origin: *`, so these are called
// directly from the browser. No API key required.
// ============================================================================

const FAA = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services";
const NPS_ROOT = "https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services";
/** NPS unit boundaries live on layer 2 of this service. */
const NPS_SVC = "NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service";
const NPS_LAYER = 2;

const TIMEOUT = 20_000;
/** Attempts per layer. A click fans out to 7 layers at once, and the ArcGIS
 *  hosts drop or throttle the odd request under that burst — one retry proved
 *  too few, so allow two. */
const ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Transient failures are worth another try; a rejected query is not. */
class QueryRejected extends Error {}

/** Rate limiting, surfaced separately so the UI can say so plainly. */
class Throttled extends Error {}

/** True when a failure was the service asking us to slow down. */
export function isRateLimited(e: unknown): boolean {
  return e instanceof Throttled;
}

/**
 * ArcGIS rate limiting does NOT come back as a 429 — it is a 200 whose body is
 * `{"error":{"message":"Unable to perform query. Too many requests."}}`. Treat
 * that as a throttle, never as a rejected query, or the app gives up instantly
 * and reports "data did not load" while the API is merely asking us to slow
 * down.
 */
const THROTTLE_RE = /too many requests|rate limit|throttl|exceeded/i;

function isThrottleMessage(msg: string): boolean {
  return THROTTLE_RE.test(msg);
}

/**
 * Shared cooldown: the rate limit is per client, so when one layer is told to
 * slow down every other layer must wait too — otherwise the remaining six
 * requests of the same burst walk straight into the same wall.
 */
let cooldownUntil = 0;

/**
 * Wall-clock budget for the current click, set by the caller. Once it is spent
 * there is no point queuing behind the cooldown — the answer is already late,
 * so fail fast and let the UI report honestly instead of grinding.
 */
let budgetUntil = 0;
export function setQueryBudget(ms: number): void {
  budgetUntil = Date.now() + ms;
}
/** A budget of 0 means "no click in flight" — viewport loads wait normally. */
const budgetLeft = () => budgetUntil === 0 || Date.now() < budgetUntil;

async function awaitCooldown(): Promise<void> {
  const wait = cooldownUntil - Date.now();
  if (wait <= 0) return;
  if (!budgetLeft()) throw new Throttled("rate limited — cooling down");
  // Never sleep past the click's budget; stop here instead.
  const allowed = budgetUntil === 0 ? wait : Math.min(wait, budgetUntil - Date.now());
  if (allowed > 0) await sleep(allowed);
  if (!budgetLeft()) throw new Throttled("rate limited — cooling down");
}
function startCooldown(ms: number): void {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
}

/**
 * Short-lived response cache, keyed by full query URL, plus in-flight
 * de-duplication. Panning, re-clicking the same spot and the ↻ refresh all
 * re-issue identical queries; serving those from memory is the difference
 * between staying under the rate limit and tripping it.
 */
const CACHE_TTL = 60_000;
const CACHE_MAX = 300;
const cache = new Map<string, { at: number; data: ArcFeature[] }>();
const inFlight = new Map<string, Promise<ArcFeature[]>>();

function cacheGet(url: string): ArcFeature[] | null {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(url);
    return null;
  }
  return hit.data;
}

function cachePut(url: string, data: ArcFeature[]): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, { at: Date.now(), data });
}

/** Jittered exponential backoff, so retries of the same burst don't collide. */
function backoffMs(attempt: number): number {
  return 400 * 2 ** attempt + Math.random() * 250;
}

export interface ArcFeature {
  attributes: Record<string, unknown>;
  geometry?: { x: number; y: number; rings?: number[][][] };
  distance?: number;
}

interface PointQuery {
  lat: number;
  lng: number;
  /** Search radius in metres. Omit for a pure containment query. */
  distanceM?: number;
  /** Generalise polygon geometry (degrees) so big boundaries stay light. */
  simplify?: number;
}

/**
 * Query a FeatureServer layer around a point. `returnGeometry` is on so the
 * caller can compute real distances / representative points client-side
 * (arcgis `returnDistance` gives 0 for point layers, so we do it ourselves).
 */
async function arcQuery(
  base: string,
  svc: string,
  layer: number,
  outFields: string,
  p: PointQuery,
  opts: { order?: string; limit?: number; onlyInside?: boolean } = {},
): Promise<ArcFeature[]> {
  const params: Record<string, string> = {
    f: "json",
    where: "1=1",
    outFields,
    returnGeometry: "true",
    outSR: "4326",
    geometry: JSON.stringify({
      x: p.lng,
      y: p.lat,
      spatialReference: { wkid: 4326 },
    }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  };
  // containment-only unless a radius is given
  if (!opts.onlyInside && p.distanceM != null) {
    params.distance = String(Math.round(p.distanceM));
    params.units = "esriSRUnit_Meter";
  }
  if (p.simplify != null) params.maxAllowableOffset = String(p.simplify);
  if (opts.order) params.orderByFields = opts.order;
  if (opts.limit) params.resultRecordCount = String(opts.limit);

  const url = `${base}/${svc}/FeatureServer/${layer}/query?${new URLSearchParams(params)}`;

  const cached = cacheGet(url);
  if (cached) return cached;
  const pending = inFlight.get(url);
  if (pending) return pending;

  const run = async (): Promise<ArcFeature[]> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      await awaitCooldown();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT);
      try {
        const res = await fetch(url, { signal: ac.signal });
        // 408/425/429 and 5xx are throttling or a hiccup — retry. Any other
        // non-OK status is our query being wrong, which no retry will fix.
        if (res.status >= 500 || res.status === 408 || res.status === 425 || res.status === 429) {
          throw new Error(`FAA layer HTTP ${res.status}`);
        }
        if (!res.ok) throw new QueryRejected(`FAA layer HTTP ${res.status}`);
        const json = (await res.json()) as {
          features?: ArcFeature[];
          error?: { message: string };
        };
        if (json.error) {
          const msg = json.error.message || "query failed";
          // Rate limiting arrives as an error body on a 200. Retry once, and
          // hold the whole fan-out back — hammering a limiter just deepens the
          // hole, so a throttled layer does not burn the full attempt budget.
          if (isThrottleMessage(msg)) {
            // One paced retry per call (the top of the loop waits the shared
            // cooldown), plus the caller's second pass — enough to ride out a
            // short window without ever hammering the limiter.
            startCooldown(2500);
            throw new Throttled(msg);
          }
          // Otherwise the service answered and refused the query (bad field,
          // bad geometry). Retrying returns the same error.
          throw new QueryRejected(msg);
        }
        const data = json.features || [];
        cachePut(url, data);
        return data;
      } catch (e) {
        lastErr = e;
        const done = attempt === ATTEMPTS - 1;
        // A rejected query fails identically however often we ask. A throttled
        // layer gets exactly one paced retry here (the loop waits the shared
        // cooldown first), then the caller's second pass has another go.
        const retryable =
          !(e instanceof QueryRejected) && !(e instanceof Throttled && attempt >= 1);
        if (!retryable || done) throw e;
        await sleep(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  };

  const pendingReq = run().finally(() => inFlight.delete(url));
  inFlight.set(url, pendingReq);
  return pendingReq;
}

/** Great-circle distance in metres. */
export function distM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
const toRad = (d: number) => (d * Math.PI) / 180;

export const M_PER_MI = 1609.344;

/** Distance (m) from a point to a polygon: 0 if inside, else nearest vertex. */
function distToRings(
  lat: number,
  lng: number,
  rings: number[][][] | undefined,
): { inside: boolean; meters: number; center: [number, number] | null } {
  if (!rings || !rings.length) return { inside: false, meters: Infinity, center: null };
  let min = Infinity;
  let sx = 0;
  let sy = 0;
  let n = 0;
  let inside = false;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
      n++;
      const d = distM(lat, lng, y, x);
      if (d < min) min = d;
    }
    if (ring.length >= 3 && pointInRing(lat, lng, ring)) inside = true;
  }
  const center: [number, number] | null = n ? [sy / n, sx / n] : null;
  return { inside, meters: inside ? 0 : min, center };
}

function pointInRing(lat: number, lng: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const hit = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function ringsOf(g: ArcFeature["geometry"]): number[][][] | undefined {
  return g?.rings;
}

/**
 * Centroid of a polygon layer's rings. Polygon FeatureServer responses carry
 * `rings`, NOT x/y — reading `.x`/`.y` off them yields undefined lat/lng.
 */
function ringCenter(rings?: number[][][]): [number, number] | null {
  if (!rings || !rings.length) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const r of rings) {
    for (const [x, y] of r) {
      sx += x;
      sy += y;
      n++;
    }
  }
  return n ? [sy / n, sx / n] : null;
}

// ---------------------------------------------------------------------------
// 1. UAS Facility Map (LAANC grid)
// ---------------------------------------------------------------------------

export interface FacilityGrid {
  ceiling: number;
  unit: string;
  aptName?: string;
  aptIcao?: string;
  airspace?: string;
  /** Distance from the click to the grid cell (0 = you are inside it). */
  distanceM: number;
  inside: boolean;
  point: [number, number];
}

const FM_FIELDS = "CEILING,UNIT,APT1_NAME,APT1_ICAO,AIRSPACE_1,ARPT_COUNT,LATITUDE,LONGITUDE";

/** Grid cell containing the point, else the nearest cell within ~12 mi. */
export async function getFacilityGrid(lat: number, lng: number): Promise<FacilityGrid | null> {
  const pick = (f: ArcFeature, inside: boolean, d: number): FacilityGrid => {
    const a = f.attributes;
    const point =
      ringCenter(ringsOf(f.geometry)) ?? [
        Number(a.LATITUDE),
        Number(a.LONGITUDE),
      ];
    return {
      ceiling: Number(a.CEILING ?? -1),
      unit: String(a.UNIT || "Feet"),
      aptName: a.APT1_NAME ? String(a.APT1_NAME) : undefined,
      aptIcao: a.APT1_ICAO ? String(a.APT1_ICAO) : undefined,
      airspace: a.AIRSPACE_1 ? String(a.AIRSPACE_1) : undefined,
      distanceM: d,
      inside,
      point,
    };
  };

  // Exact containment first.
  const inside = await arcQuery(FAA, "FAA_UAS_FacilityMap_Data_V5", 0, FM_FIELDS, {
    lat,
    lng,
  });
  if (inside.length) return pick(inside[0], true, 0);

  // Otherwise the nearest grid cell, so the user still sees the local ceiling.
  const near = await arcQuery(
    FAA,
    "FAA_UAS_FacilityMap_Data_V5",
    0,
    FM_FIELDS,
    { lat, lng, distanceM: 20000 },
    { limit: 40 },
  );
  let best: { f: ArcFeature; d: number } | null = null;
  for (const f of near) {
    const info = distToRings(lat, lng, ringsOf(f.geometry));
    if (!best || info.meters < best.d) best = { f, d: info.meters };
  }
  return best ? pick(best.f, false, best.d) : null;
}

// ---------------------------------------------------------------------------
// 2. Class airspace
// ---------------------------------------------------------------------------

export interface AirspaceRec {
  name: string;
  cls: string;
  ident?: string;
  floor?: string;
  ceiling?: string;
  distanceM: number;
  inside: boolean;
  point: [number, number] | null;
}

const CLASS_FIELDS =
  "NAME,CLASS,TYPE_CODE,LOCAL_TYPE,UPPER_DESC,UPPER_VAL,UPPER_UOM,UPPER_CODE,LOWER_DESC,LOWER_VAL,LOWER_UOM,LOWER_CODE,ICAO_ID";

/** Human text for an FAA vertical limit value. */
function fmtLimit(
  val: unknown,
  uom: unknown,
  code: unknown,
  desc: unknown,
): string | undefined {
  const v = Number(val);
  if (!isFinite(v)) return undefined;
  if (v === -9998) return "unlimited";
  const u = String(uom || "");
  const c = String(code || "");
  if (u === "FL") return `FL${v}`;
  if (v === 0 && c === "SFC") return "surface";
  if (u === "FT") {
    if (c === "MSL") return `${v.toLocaleString()} ft MSL`;
    if (c === "SFC") return c === "SFC" && v > 0 ? `${v.toLocaleString()} ft AGL` : "surface";
    return `${v.toLocaleString()} ft${String(desc || "") === "AA" ? " AGL" : ""}`;
  }
  return `${v.toLocaleString()} ${u}`.trim();
}

function toAirspace(
  f: ArcFeature,
  distanceM: number,
  inside: boolean,
): AirspaceRec {
  const a = f.attributes;
  return {
    name: String(a.NAME || "Airspace"),
    cls: String(a.CLASS || "-"),
    ident: a.ICAO_ID ? String(a.ICAO_ID) : undefined,
    floor: fmtLimit(a.LOWER_VAL, a.LOWER_UOM, a.LOWER_CODE, a.LOWER_DESC),
    ceiling: fmtLimit(a.UPPER_VAL, a.UPPER_UOM, a.UPPER_CODE, a.UPPER_DESC),
    distanceM,
    inside,
    point: ringCenter(ringsOf(f.geometry)),
  };
}

/** Class airspace containing the point (else the nearest within ~15 mi). */
export async function getClassAirspace(lat: number, lng: number): Promise<AirspaceRec[]> {
  const inside = await arcQuery(FAA, "Class_Airspace", 0, CLASS_FIELDS, { lat, lng });
  if (inside.length) {
    // De-dupe identical records (the same volume can be split into sectors).
    const seen = new Set<string>();
    const out: AirspaceRec[] = [];
    for (const f of inside) {
      const key = `${f.attributes.NAME}|${f.attributes.LOWER_VAL}|${f.attributes.UPPER_VAL}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(toAirspace(f, 0, true));
    }
    return out;
  }
  const near = await arcQuery(
    FAA,
    "Class_Airspace",
    0,
    CLASS_FIELDS,
    { lat, lng, distanceM: 24000 },
    { limit: 60 },
  );
  const scored = near
    .map((f) => ({
      f,
      d: distToRings(lat, lng, ringsOf(f.geometry)).meters,
    }))
    .filter((x) => isFinite(x.d))
    .sort((a, b) => a.d - b.d);
  const seen = new Set<string>();
  const out: AirspaceRec[] = [];
  for (const s of scored) {
    const key = `${s.f.attributes.NAME}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toAirspace(s.f, s.d, false));
    if (out.length >= 2) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Special use airspace
// ---------------------------------------------------------------------------

export interface SuaRec {
  name: string;
  type: string;
  floor?: string;
  ceiling?: string;
  city?: string;
  state?: string;
  distanceM: number;
  inside: boolean;
  point: [number, number] | null;
}

const SUA_FIELDS =
  "NAME,TYPE_CODE,CLASS,UPPER_DESC,UPPER_VAL,UPPER_UOM,UPPER_CODE,LOWER_DESC,LOWER_VAL,LOWER_UOM,LOWER_CODE,CITY,STATE";

export async function getSpecialUseAirspace(lat: number, lng: number): Promise<SuaRec[]> {
  const toRec = (f: ArcFeature, d: number, inside: boolean): SuaRec => {
    const a = f.attributes;
    return {
      name: String(a.NAME || "Special use airspace"),
      type: String(a.TYPE_CODE || ""),
      floor: fmtLimit(a.LOWER_VAL, a.LOWER_UOM, a.LOWER_CODE, a.LOWER_DESC),
      ceiling: fmtLimit(a.UPPER_VAL, a.UPPER_UOM, a.UPPER_CODE, a.UPPER_DESC),
      city: a.CITY ? String(a.CITY) : undefined,
      state: a.STATE ? String(a.STATE) : undefined,
      distanceM: d,
      inside,
      point: ringCenter(ringsOf(f.geometry)),
    };
  };

  const inside = await arcQuery(FAA, "Special_Use_Airspace", 0, SUA_FIELDS, { lat, lng });
  if (inside.length) return inside.map((f) => toRec(f, 0, true));

  const near = await arcQuery(
    FAA,
    "Special_Use_Airspace",
    0,
    SUA_FIELDS,
    { lat, lng, distanceM: 50000 },
    { limit: 40 },
  );
  const scored = near
    .map((f) => ({ f, d: distToRings(lat, lng, ringsOf(f.geometry)).meters }))
    .filter((x) => isFinite(x.d))
    .sort((a, b) => a.d - b.d);
  const seen = new Set<string>();
  const out: SuaRec[] = [];
  for (const s of scored) {
    const key = String(s.f.attributes.NAME);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toRec(s.f, s.d, false));
    if (out.length >= 2) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Part-time national security UAS flight restrictions
// ---------------------------------------------------------------------------

export async function getSecurityRestrictions(lat: number, lng: number): Promise<string[]> {
  try {
    const f = await arcQuery(
      FAA,
      "Part_Time_National_Security_UAS_Flight_Restrictions",
      0,
      "NAME,TYPE_CODE,LOWER_VAL,UPPER_VAL,STATE,CITY",
      { lat, lng },
    );
    return f.map((x) => String(x.attributes.NAME || "National security UAS restriction"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 5. Airports & heliports (FAA ADHP)
// ---------------------------------------------------------------------------

export interface AirportRec {
  ident: string;
  icao?: string;
  name: string;
  type: string;
  city?: string;
  elevation?: number;
  military: boolean;
  privateUse: boolean;
  distanceM: number;
  lat: number;
  lng: number;
}

export async function getNearbyAirports(
  lat: number,
  lng: number,
  radiusM = 40000,
  limit = 6,
): Promise<AirportRec[]> {
  const fs = await arcQuery(
    FAA,
    "ADHP",
    0,
    "IDENT_TXT,NAME_TXT,ICAO_TXT,TYPE_CODE,SERVICINGCITY_TXT,ELEV_VAL,MILITARY_CODE,PRIVATEUSE_CODE",
    { lat, lng, distanceM: radiusM },
    { limit: 200 },
  );
  const rows: AirportRec[] = [];
  for (const f of fs) {
    const a = f.attributes;
    if (!f.geometry) continue;
    rows.push({
      ident: String(a.IDENT_TXT || a.ICAO_TXT || "—"),
      icao: a.ICAO_TXT ? String(a.ICAO_TXT) : undefined,
      name: String(a.NAME_TXT || a.IDENT_TXT || "Airport"),
      type: String(a.TYPE_CODE || ""),
      city: a.SERVICINGCITY_TXT ? String(a.SERVICINGCITY_TXT) : undefined,
      elevation: a.ELEV_VAL != null ? Number(a.ELEV_VAL) : undefined,
      military: !!a.MILITARY_CODE && String(a.MILITARY_CODE) !== "N",
      privateUse: !!a.PRIVATEUSE_CODE && String(a.PRIVATEUSE_CODE) !== "N",
      distanceM: distM(lat, lng, f.geometry.y, f.geometry.x),
      lat: f.geometry.y,
      lng: f.geometry.x,
    });
  }
  rows.sort((a, b) => a.distanceM - b.distanceM);
  return rows.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 6. Recreational flyer fixed sites
// ---------------------------------------------------------------------------

export interface FixedSiteRec {
  siteId: string;
  name: string;
  city?: string;
  state?: string;
  ceiling?: number;
  boundary?: number;
  poc?: string;
  distanceM: number;
  lat: number;
  lng: number;
}

export async function getNearbyFixedSites(
  lat: number,
  lng: number,
  radiusM = 40000,
  limit = 3,
): Promise<FixedSiteRec[]> {
  const fs = await arcQuery(
    FAA,
    "Recreational_Flyer_Fixed_Sites",
    0,
    "SITE_NAME,SITE_ID,LATITUDE,LONGITUDE,CITY,STATE,CEILING,BOUNDARY,UNIT,POC",
    { lat, lng, distanceM: radiusM },
    { limit: 100 },
  );
  const rows: FixedSiteRec[] = [];
  for (const f of fs) {
    const a = f.attributes;
    const la = Number(a.LATITUDE);
    const lo = Number(a.LONGITUDE);
    if (!isFinite(la) || !isFinite(lo)) continue;
    rows.push({
      siteId: String(a.SITE_ID || ""),
      name: String(a.SITE_NAME || "Fixed site"),
      city: a.CITY ? String(a.CITY) : undefined,
      state: a.STATE ? String(a.STATE) : undefined,
      ceiling: a.CEILING != null ? Number(a.CEILING) : undefined,
      boundary: a.BOUNDARY != null ? Number(a.BOUNDARY) : undefined,
      poc: a.POC ? String(a.POC) : undefined,
      distanceM: distM(lat, lng, la, lo),
      lat: la,
      lng: lo,
    });
  }
  rows.sort((a, b) => a.distanceM - b.distanceM);
  return rows.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 7. National Park Service units (parks, parkways, scenic trails)
// ---------------------------------------------------------------------------

export interface NpsRec {
  code: string;
  name: string;
  unitType: string;
  state?: string;
  inside: boolean;
  distanceM: number;
  point: [number, number] | null;
}

export async function getNearbyNpsUnits(
  lat: number,
  lng: number,
  radiusM = 40000,
  limit = 4,
): Promise<NpsRec[]> {
  const fs = await arcQuery(
    NPS_ROOT,
    NPS_SVC,
    NPS_LAYER,
    "UNIT_CODE,UNIT_NAME,UNIT_TYPE,PARKNAME,STATE",
    { lat, lng, distanceM: radiusM, simplify: 0.0008 },
    { limit: 60 },
  );
  const rows: NpsRec[] = [];
  for (const f of fs) {
    const a = f.attributes;
    const info = distToRings(lat, lng, ringsOf(f.geometry));
    rows.push({
      code: String(a.UNIT_CODE || ""),
      name: String(a.UNIT_NAME || a.PARKNAME || "NPS unit"),
      unitType: String(a.UNIT_TYPE || "National Park Service"),
      state: a.STATE ? String(a.STATE) : undefined,
      inside: info.inside,
      distanceM: info.meters,
      point: info.center,
    });
  }
  rows.sort((a, b) => a.distanceM - b.distanceM);
  return rows.slice(0, limit);
}

/** Field order helper: ArcGIS rejects unknown outFields for the NPS layer. */
export const NPS_QUERY_FIELDS = "UNIT_CODE,UNIT_NAME,UNIT_TYPE,PARKNAME,STATE";
