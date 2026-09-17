// ============================================================================
// "What's here?" aggregator.
//
// Given a clicked point, fans out to the live FAA/NPS layers, scores the
// airspace, and returns an ordered list of relevant items — the same shape as
// the FAA/B4UFLY airspace listing (UAS Facility Map → airspace → fixed site →
// airport → parkway …), each with its distance and an expandable detail.
// ============================================================================

import {
  M_PER_MI,
  distM,
  getClassAirspace,
  getFacilityGrid,
  getNearbyAirports,
  getNearbyFixedSites,
  getNearbyNpsUnits,
  getSecurityRestrictions,
  getSpecialUseAirspace,
  isRateLimited,
  setQueryBudget,
  type AirspaceRec,
} from "./faa";
import type { NoFlyZone } from "./areas";
import { pointInZone } from "./geo";
import { ALT, modelAirport, type FlyStatus } from "./airspace";

export type Severity = "ok" | "info" | "caution" | "danger";

export type ItemKind =
  | "facility_map"
  | "airspace"
  | "sua"
  | "security"
  | "fixed_site"
  | "airport"
  | "nps"
  | "zone";

export interface NearbyItem {
  id: string;
  kind: ItemKind;
  /** Bold headline, e.g. "ASHEVILLE CLASS C", "Recreational Fixed Flyer Site: NC-805". */
  title: string;
  /** Small chip after the title, e.g. "Class: C", "KAVL", "Parkways". */
  badge?: string;
  /** Always-visible one-liner. */
  subtitle?: string;
  /** Distance from the clicked point, in metres. */
  distanceM?: number;
  severity: Severity;
  /** Paragraphs revealed by the "more" toggle. */
  detail: string[];
  link?: { href: string; label: string };
  flyTo?: { lat: number; lng: number; zoom: number };
}

export interface NearbyResult {
  lat: number;
  lng: number;
  status: FlyStatus;
  /** Overrides the default verdict label / sub-line (used for 0 ft grid cells). */
  statusLabel?: string;
  statusTitle?: string;
  /** Highest altitude may lawfully be flown / requested, ft AGL. */
  ceiling: number;
  /** Effective airspace class at the point. */
  airspaceClass: string;
  items: NearbyItem[];
  /** Layer names that failed to load (verdict-relevant ones only). */
  errors: string[];
  /** True when the FAA services rate-limited this browser. */
  rateLimited: boolean;
}

const LAANC =
  "https://faadronezone-access.faa.gov/#/";
const FM_DOC =
  "https://www.faa.gov/uas/getting_started/laanc";
const NPS_DRONES = "https://www.nps.gov/subjects/drones/index.htm";
const FIXED_SITES =
  "https://www.faa.gov/uas/recreational_flyers/where_can_i_fly";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const FIXED_SITE_BOILERPLATE =
  "Flight operations at a Recreational Flyer Fixed Site within controlled airspace must " +
  "adhere to the site's operating limitations and safety guidelines, which are available " +
  "from the fixed site sponsor.";

/** Format a distance for display, FAA-listing style ("2.59mi"). */
export function fmtMi(meters?: number): string | undefined {
  if (meters == null) return undefined;
  const mi = meters / M_PER_MI;
  if (mi < 0.01) return "here";
  return `${mi < 10 ? mi.toFixed(2) : mi.toFixed(1)}mi`;
}

/**
 * Build a "center on map" target, or undefined when the coordinates are not
 * usable. Polygon layers return rings rather than x/y, so an unguarded
 * flyTo can carry undefined lat/lng and blow up Leaflet downstream.
 */
function flyTo(lat?: number | null, lng?: number | null, zoom = 12) {
  if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return undefined;
  return { lat, lng, zoom };
}

function fmtFt(n?: number): string {
  return n == null ? "—" : `${n.toLocaleString()} ft`;
}

interface AnalyzeInput {
  lat: number;
  lng: number;
  /** OSM protected / restricted polygons already loaded for the viewport. */
  zones: NoFlyZone[];
}

export async function analyzePoint({ lat, lng, zones }: AnalyzeInput): Promise<NearbyResult> {
  const errors: string[] = [];
  let rateLimited = false;
  /** Wall-clock budget for one click, so a rate-limited query still answers. */
  const deadline = Date.now() + 7000;
  setQueryBudget(deadline - Date.now());
  /** Layers whose failure changes the verdict — worth telling the user about. */
  const CORE = new Set([
    "UAS Facility Map",
    "Class airspace",
    "NPS units",
    // A failed special-use-airspace lookup can hide a prohibited area, so its
    // failure must be reported rather than silently swallowed.
    "Special use airspace",
    "Airports",
  ]);

  const logFailure = (label: string, e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    // Always log the real reason for debugging; only the layer name is shown
    // to the user (a raw service error message means nothing to a pilot).
    console.warn(`${label} lookup failed: ${msg}`);
  };

  /**
   * Stagger the fan-out, then give a failed layer one quiet second pass.
   * Firing all seven queries in the same tick is what makes these hosts drop
   * or throttle a request, so spreading them a few tens of ms apart keeps the
   * burst polite (~0.5s on the whole result, hidden behind the loading card),
   * and the second pass means a one-off drop never reaches the user.
   * Verdict-critical layers fire first.
   */
  const safe = async <T,>(
    label: string,
    i: number,
    fn: () => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    await sleep(i * 90 + Math.random() * 90);
    try {
      return await fn();
    } catch (e) {
      logFailure(label, e);
      // The second pass is what rescues a one-off drop. It is skipped once the
      // click has already spent its time budget, so a hard rate limit reports
      // back in seconds instead of grinding through every layer.
      if (Date.now() > deadline) {
        if (CORE.has(label)) errors.push(label);
        if (isRateLimited(e)) rateLimited = true;
        return fallback;
      }
      await sleep(1200);
      try {
        return await fn();
      } catch (e2) {
        logFailure(label, e2);
        if (CORE.has(label)) errors.push(label);
        if (isRateLimited(e2)) rateLimited = true;
        return fallback;
      }
    }
  };

  const [grid, airspaces, suas, security, fixedSites, airports, nps] = await Promise.all([
    safe("UAS Facility Map", 0, () => getFacilityGrid(lat, lng), null),
    safe("Class airspace", 1, () => getClassAirspace(lat, lng), [] as AirspaceRec[]),
    safe("Special use airspace", 2, () => getSpecialUseAirspace(lat, lng), []),
    safe("Security restrictions", 3, () => getSecurityRestrictions(lat, lng), [] as string[]),
    safe("Fixed flyer sites", 4, () => getNearbyFixedSites(lat, lng), []),
    safe("Airports", 5, () => getNearbyAirports(lat, lng), []),
    safe("NPS units", 6, () => getNearbyNpsUnits(lat, lng), []),
  ]);

  const items: NearbyItem[] = [];

  // ---- 1. UAS Facility Map ------------------------------------------------
  if (grid) {
    const insideGrid = grid.inside;
    const ceilingTxt = `${fmtFt(grid.ceiling)}`;
    items.push({
      id: "fm",
      kind: "facility_map",
      title: "UAS Facility Map",
      badge: grid.aptIcao,
      subtitle: insideGrid
        ? `Permissible altitude for authorization: ${grid.ceiling} ft.`
        : `Nearest grid cell (${fmtMi(grid.distanceM)}): ${ceilingTxt}.`,
      distanceM: insideGrid ? undefined : grid.distanceM,
      // A 0 ft grid cell is the hard constraint at this location, so it reads
      // as an advisory rather than a footnote.
      severity: grid.ceiling > 0 ? "info" : "danger",
      detail: [
        "The FAA UAS Facility Map shows the maximum altitude (in feet above ground level) " +
          "at which a Part 107 remote pilot may be authorized to operate in controlled " +
          "airspace, as depicted on the LAANC grid for the airports below.",
        "This figure is a ceiling for authorization, not a grant of authority. You must " +
          "still submit a LAANC request — or an airspace authorization through the FAA " +
          "DroneZone — and receive a approval before you fly.",
        grid.ceiling === 0
          ? "A grid value of 0 ft means LAANC cannot authorize flight in this cell. " +
            "Operations here require a separate FAA airspace authorization (DroneZone) " +
            "and are frequently denied."
          : "Requesting an altitude above the grid value requires a separate, manually " +
            "reviewed airspace authorization and is often denied.",
        grid.aptName
          ? `Grid cell is associated with ${grid.aptName}${grid.aptIcao ? ` (${grid.aptIcao})` : ""}` +
            `${grid.airspace ? `, Class ${grid.airspace}` : ""}.`
          : "Grid cell airport association unavailable.",
      ],
      link: { href: FM_DOC, label: "About LAANC & UAS Facility Maps" },
      flyTo: insideGrid ? undefined : flyTo(grid.point[0], grid.point[1], 12),
    });
  } else {
    items.push({
      id: "fm",
      kind: "facility_map",
      title: "UAS Facility Map",
      subtitle: "No UAS Facility Map grid covers this location.",
      severity: "ok",
      detail: [
        "There is no LAANC grid cell within 12 miles of this point, which normally means " +
          "you are outside a designated LAANC service volume.",
        "Outside controlled airspace you may operate under Part 107 up to 400 ft AGL " +
          "without any airspace authorization, as long as you comply with all other " +
          "applicable rules and flight restrictions.",
      ],
      link: { href: FM_DOC, label: "About LAANC & UAS Facility Maps" },
    });
  }

  // ---- 2. Class airspace --------------------------------------------------
  // Only surface-and-below-relevant airspace is listed. Class A starts at
  // 18,000 ft MSL and Class E transition areas begin at 700/1200 ft AGL —
  // neither can constrain a Part 107 flight at or below 400 ft AGL, so
  // including them would just be noise.
  const relevantAirspace = airspaces.filter(
    (a) => a.cls !== "A" && (a.cls !== "E" || a.floor === "surface"),
  );
  for (const a of relevantAirspace) {
    const cls = a.cls.toUpperCase();
    const controlled = ["A", "B", "C", "D"].includes(cls);
    const surfaceE = cls === "E" && a.floor === "surface";
    const limits = [a.floor, a.ceiling].filter(Boolean).join(" → ");
    items.push({
      id: `as-${a.name}-${a.floor}-${a.ceiling}`,
      kind: "airspace",
      title: a.name,
      badge: `Class: ${cls}`,
      subtitle: limits ? `${limits}${a.ident ? ` · ${a.ident}` : ""}` : a.ident,
      distanceM: a.inside ? undefined : a.distanceM,
      severity: controlled || surfaceE ? "caution" : "info",
      detail: [
        a.inside
          ? `This point is inside ${a.name}${limits ? ` (${limits})` : ""}.`
          : `${a.name}${limits ? ` (${limits})` : ""} is the nearest controlled airspace, ` +
            `${fmtMi(a.distanceM)} away.`,
        controlled || surfaceE
          ? `Part 107 operations in Class ${cls} airspace require prior FAA airspace ` +
            `authorization. Use LAANC for near-real-time approval in grid cells, or the ` +
            `FAA DroneZone for anything LAANC will not approve.`
          : `Class ${cls} at this level does not by itself require an airspace ` +
            `authorization for a 400 ft AGL Part 107 flight — but any ceiling limits shown ` +
            `above still apply.`,
        a.ident ? `Controlling / associated facility: ${a.ident}.` : "",
      ].filter(Boolean),
      link: { href: LAANC, label: "Request LAANC authorization" },
      flyTo: a.inside ? undefined : flyTo(a.point?.[0], a.point?.[1], 11),
    });
  }

  // ---- 3. Special use airspace -------------------------------------------
  for (const s of suas) {
    const t = s.type.toUpperCase();
    const hard = t === "P" || t === "R" || t === "NSA";
    const limits = [s.floor, s.ceiling].filter(Boolean).join(" → ");
    items.push({
      id: `sua-${s.name}`,
      kind: "sua",
      title: s.name,
      badge: SUA_LABEL[t] || s.type,
      subtitle: limits || undefined,
      distanceM: s.inside ? undefined : s.distanceM,
      severity: s.inside && hard ? "danger" : hard ? "caution" : "info",
      detail: [
        s.inside
          ? `This point is inside ${s.name}${limits ? ` (${limits})` : ""}.`
          : `${s.name} ${limits ? `(${limits}) ` : ""}is ${fmtMi(s.distanceM)} away.`,
        hard
          ? "Prohibited, Restricted and National Security Areas are closed to civil " +
            "aircraft, including sUAS, unless the controlling agency specifically " +
            "authorizes you. Never plan a flight through one."
          : `${SUA_LABEL[t] || s.type} is not permanently closed to civil aircraft, but ` +
            `hazardous military or high-volume activity may be in progress. Check the ` +
            `current status with the controlling agency and maintain extra separation.`,
      ],
      flyTo: s.inside ? undefined : flyTo(s.point?.[0], s.point?.[1], 10),
    });
  }

  // ---- 4. Part-time national security restrictions ------------------------
  for (const name of security) {
    items.push({
      id: `sec-${name}`,
      kind: "security",
      title: name,
      badge: "National security",
      subtitle: "Part-time UAS flight restriction in effect at this location.",
      severity: "danger",
      detail: [
        "The FAA has established a part-time flight restriction for this location in " +
          "consultation with national security partners. It may be active only during " +
          "particular hours or conditions, but when it is active you may not operate " +
          "there without specific approval.",
        "Check the current NOTAM and the FAA's UAS flight restrictions page before " +
          "every flight.",
      ],
      link: {
        href: "https://www.faa.gov/uas/getting_started/where_can_i_fly/airspace_restrictions",
        label: "Current FAA UAS flight restrictions",
      },
    });
  }

  // ---- 5. Recreational flyer fixed sites ---------------------------------
  for (const s of fixedSites) {
    const label = s.siteId || s.name;
    items.push({
      id: `fx-${s.siteId}-${s.name}-${s.distanceM}`,
      kind: "fixed_site",
      title: `Recreational Fixed Flyer Site: ${label}`,
      badge: s.state || undefined,
      subtitle: FIXED_SITE_BOILERPLATE,
      distanceM: s.distanceM,
      severity: "info",
      detail: [
        `${s.name}${s.siteId ? ` (site ${s.siteId})` : ""}` +
          `${s.city || s.state ? ` — ${[s.city, s.state].filter(Boolean).join(", ")}` : ""}.`,
        s.ceiling != null
          ? `Published operating ceiling: ${fmtFt(s.ceiling)} AGL.`
          : "No published operating ceiling for this site.",
        s.boundary != null
          ? `Published site boundary: ${s.boundary.toLocaleString()} ft.`
          : "",
        s.poc ? `Site sponsor / point of contact: ${s.poc}` : "",
        "Recreational flyers operating at an FAA-recognized fixed site must follow the " +
          "site's own operating limitations and safety guidelines, which are available " +
          "from the site sponsor. Sites located inside controlled airspace carry the " +
          "additional conditions shown in the fixed site conditions of use.",
      ].filter(Boolean),
      link: { href: FIXED_SITES, label: "FAA recreational flyer fixed sites" },
      flyTo: flyTo(s.lat, s.lng, 13),
    });
  }

  // ---- 6. Airports & heliports -------------------------------------------
  for (const a of airports) {
    const typeLabel = AIRPORT_TYPE[a.type] || a.type || "Airport";
    // Same planning estimate the control-radius circle on the map uses.
    const est = modelAirport(a.name, a.lat, a.lng, {
      icao: a.icao,
      "aerodrome:type": a.type === "HP" ? "heliport" : undefined,
      military: a.military ? "airport" : undefined,
    });
    items.push({
      id: `ap-${a.ident}-${a.name}`,
      kind: "airport",
      title: a.name,
      badge: a.icao || a.ident,
      subtitle: [typeLabel, a.city].filter(Boolean).join(" · "),
      distanceM: a.distanceM,
      severity: "info",
      detail: [
        `${a.name}${a.icao ? ` — ICAO ${a.icao}` : ""}` +
          `${a.ident && a.ident !== a.icao ? `, FAA ident ${a.ident}` : ""}.`,
        [
          `Facility type: ${typeLabel}.`,
          a.city ? `Serving city: ${a.city}.` : "",
          a.elevation != null && isFinite(a.elevation)
            ? `Field elevation: ${a.elevation.toLocaleString()} ft MSL.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        a.military
          ? "Military airfield — expect military and public-use traffic. Avoid the " +
            "traffic pattern and any published special-use areas."
          : a.privateUse
            ? "Private-use field. Do not expect standard traffic patterns; stay well clear " +
              "and never operate over the field without the operator's consent."
            : "Public-use field. Watch for low-level traffic, and check the airspace entry " +
              "above before flying nearby.",
        est.controlRadius > 0
          ? `Class ${est.airspaceClass} · approx. control radius ${
              Math.round((est.controlRadius / 1852) * 10) / 10
            } nm (planning estimate from the field's type).`
          : "No controlled-airspace footprint is inferred for this field.",
        "Distance is measured from your selected point to the airport reference point.",
      ],
      flyTo: flyTo(a.lat, a.lng, 12),
    });
  }

  // ---- 7. National Park Service units ------------------------------------
  for (const u of nps) {
    items.push({
      id: `nps-${u.code}`,
      kind: "nps",
      title: u.name,
      badge: u.unitType,
      subtitle: u.inside
        ? "Selected point is inside this National Park Service unit."
        : `${fmtMi(u.distanceM)} from this unit's boundary.`,
      distanceM: u.inside ? undefined : u.distanceM,
      severity: u.inside ? "danger" : "caution",
      detail: [
        u.inside
          ? `This point is within ${u.name}${u.state ? ` (${u.state})` : ""}.`
          : `${u.name}${u.state ? ` (${u.state})` : ""} begins ${fmtMi(u.distanceM)} away.`,
        "Launching, landing or operating an unmanned aircraft from or on lands and " +
          "waters administered by the National Park Service is prohibited (36 CFR 1.5, " +
          "NPS Policy Memorandum 14-05).",
        "This applies to the land and water inside park boundaries — including along " +
          "parkways such as the Blue Ridge Parkway. Operating a drone while standing on " +
          "NPS land is a violation even if the aircraft stays outside the boundary.",
        "Overflight of NPS land is not itself prohibited, but pilots are asked to avoid " +
          "wildlife disturbance, historic structures and emergency operations.",
      ],
      link: { href: NPS_DRONES, label: "NPS unmanned aircraft policy" },
      flyTo: flyTo(u.point?.[0], u.point?.[1], 11),
    });
  }

  // ---- 8. Protected / restricted areas loaded for this viewport -----------
  const npsNames = new Set(nps.map((u) => u.name.toLowerCase()));
  const zoneHits = zones
    .map((z) => ({
      z,
      inside: pointInZone(lat, lng, z.geometry),
      distanceM: nearRingDistance(lat, lng, z.geometry),
    }))
    .filter((h) => h.inside || h.distanceM < 8000)
    .sort((a, b) => {
      if (a.inside !== b.inside) return a.inside ? -1 : 1;
      return a.distanceM - b.distanceM;
    })
    .slice(0, 4);

  for (const h of zoneHits) {
    const z = h.z;
    if (npsNames.has(z.name.toLowerCase())) continue;
    const military = z.kind === "military";
    items.push({
      id: `z-${z.type}-${z.id}`,
      kind: "zone",
      title: z.name,
      badge: military ? "Restricted area" : "Protected area",
      subtitle: h.inside
        ? "Selected point is inside this area."
        : `${fmtMi(h.distanceM)} away.`,
      distanceM: h.inside ? undefined : h.distanceM,
      severity: h.inside ? "danger" : "caution",
      detail: [
        military
          ? "Prohibited, restricted or national-security airspace. Civil aircraft, " +
            "including sUAS, may not operate here without specific authorization from " +
            "the controlling agency."
          : "Administratively or congressionally designated protected area. Many such " +
            "areas prohibit drone launch and landing, and some prohibit all sUAS " +
            "operation.",
        "Source: FAA Special Use Airspace and National Park Service boundary data, " +
          "queried live for this location.",
      ],
    });
  }

  // ---- Verdict ------------------------------------------------------------
  const insideNps = nps.some((u) => u.inside);
  const insideZone = zoneHits.some((h) => h.inside);
  const hardSua = suas.filter(
    (s) => s.inside && ["P", "R", "NSA"].includes(s.type.toUpperCase()),
  );
  const softSua = suas.filter(
    (s) => s.inside && !["P", "R", "NSA"].includes(s.type.toUpperCase()),
  );
  const controlling = airspaces.find((a) => a.inside && ["A", "B", "C", "D"].includes(a.cls));
  const surfaceE = airspaces.find((a) => a.inside && a.cls === "E" && a.floor === "surface");

  let status: FlyStatus = "fly";
  let statusLabel: string | undefined;
  let statusTitle: string | undefined;
  if (insideNps || insideZone || hardSua.length || security.length) {
    status = "no_fly";
  } else if (grid && grid.inside && grid.ceiling <= 0) {
    // A 0 ft grid cell means LAANC cannot authorize any altitude here. Flight
    // is not flatly prohibited — it needs a manually reviewed FAA DroneZone
    // airspace authorization — so this is "authorization required", not
    // "no fly", but it must never read as a routine LAANC request.
    status = "authorization";
    statusLabel = "Authorization Required";
    statusTitle = "No LAANC available — FAA DroneZone authorization required";
  } else if (controlling || surfaceE) {
    status = "authorization";
  }

  /**
   * A green "Fly OK" is a claim about airspace we could not read. If a layer
   * that decides the verdict failed, say so instead of reassuring the pilot —
   * the strictest reading of whatever did load is still shown, but a clean
   * "fly" is only reported when the evidence is actually complete.
   */
  const verdictCritical = errors.filter((e) =>
    ["UAS Facility Map", "Class airspace", "NPS units", "Special use airspace"].includes(e),
  );
  if (status === "fly" && verdictCritical.length) {
    status = "unknown";
    statusTitle = `Could not load ${verdictCritical.join(", ")} — this point may be controlled airspace. Retry before flying.`;
  }

  // 400 ft is only claimed when the Facility Map actually loaded: an "unknown"
  // verdict with no grid data must not quietly promise the Class G ceiling.
  const ceiling =
    status === "no_fly"
      ? ALT.NO_FLY
      : grid && grid.inside
        ? Math.max(0, grid.ceiling)
        : status === "unknown"
          ? ALT.NO_FLY
          : ALT.DEFAULT_G;

  const airspaceClass = insideNps || insideZone
    ? "G"
    : controlling?.cls || (surfaceE ? "E" : "G");

  // Ordering: anything that forbids the flight goes straight to the top,
  // then everything else follows the FAA listing order (facility map →
  // airspace → special use → fixed sites → airports → parks).
  const CATEGORY: Record<ItemKind, number> = {
    facility_map: 0,
    airspace: 1,
    sua: 2,
    security: 3,
    fixed_site: 4,
    airport: 5,
    nps: 6,
    zone: 7,
  };
  const head = items.filter((i) => i.kind === "facility_map");
  const rest = items
    .filter((i) => i.kind !== "facility_map")
    .map((i, idx) => ({ i, idx }))
    .sort((a, b) => {
      const da = a.i.severity === "danger" ? 0 : 1;
      const db = b.i.severity === "danger" ? 0 : 1;
      if (da !== db) return da - db;
      const ca = CATEGORY[a.i.kind] - CATEGORY[b.i.kind];
      if (ca !== 0) return ca;
      return a.idx - b.idx;
    })
    .map((x) => x.i);
  void softSua;

  return {
    lat,
    lng,
    status,
    statusLabel,
    statusTitle,
    ceiling,
    airspaceClass,
    items: [...head, ...rest],
    errors,
    rateLimited,
  };
}

const SUA_LABEL: Record<string, string> = {
  P: "Prohibited",
  R: "Restricted",
  W: "Warning area",
  A: "Alert area",
  MOA: "MOA",
  NSA: "National security area",
  TFR: "TFR",
};

const AIRPORT_TYPE: Record<string, string> = {
  AD: "Airport",
  HP: "Heliport",
  SP: "Seaplane base",
  GL: "Gliderport",
  BL: "Balloonport",
  UL: "Ultralight field",
};

/** Nearest-ring distance in metres (approximate; good enough for sorting). */
function nearRingDistance(lat: number, lng: number, rings: number[][][]): number {
  let min = Infinity;
  const ring = rings?.[0];
  if (!ring) return min;
  const step = Math.max(1, Math.floor(ring.length / 400));
  for (let i = 0; i < ring.length; i += step) {
    const [x, y] = ring[i];
    const d = distM(lat, lng, y, x);
    if (d < min) min = d;
  }
  return min;
}
