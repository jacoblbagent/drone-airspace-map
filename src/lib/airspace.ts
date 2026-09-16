// ============================================================================
// Airspace rules engine for sUAS / Part 107 drone operation.
//
// This encodes FAA-style airspace structure (Class B/C/D/E/G) and the
// Part 107 altitude rules at a planning level. It is NOT an official FAA
// data product — controlled-airspace footprints are approximated from
// airport size/type so the map works without a subscription LAANC feed.
// For definitive guidance use the FAA B4UFLY app and LAANC UAS Facility Maps.
// ============================================================================

// Units
const NM = 1852; // meters per nautical mile

/** Altitude ceiling values (ft AGL) used across the map. */
export const ALT: Record<string, number> = {
  NO_FLY: 0,
  DEFAULT_G: 400, // standard Part 107 ceiling in Class G (uncontrolled)
  SURFACE_E: 1200,
  CLASS_D: 2500,
  CLASS_C: 4000,
  CLASS_B: 10000,
  SPECIAL: 700,
};

export type AirspaceClass = "B" | "C" | "D" | "E" | "G";
export type FlyStatus = "fly" | "authorization" | "no_fly";

export interface AirportModel {
  name: string;
  lat: number;
  lng: number;
  /** ICAO / IATA / FAA identifier if available. */
  code?: string;
  /** Inferred FAA airspace class controlling the airport environs. */
  airspaceClass: AirspaceClass;
  /** Approx radius (m) of the controlled-airspace footprint. */
  controlRadius: number;
  /** Ceiling (ft AGL) of the controlled airspace. */
  ceiling: number;
  /** True for special-use / military-style fields. */
  restricted: boolean;
  /** Source tags (for transparency in popups). */
  tags: Record<string, string | undefined>;
}

/** Infer an airspace model for an OSM `aeroway=aerodrome`. */
export function modelAirport(
  name: string,
  lat: number,
  lng: number,
  tags: Record<string, string | undefined>,
): AirportModel {
  const type = (tags["aerodrome:type"] || "").toLowerCase();
  const iata = tags["iata"] || "";
  const icao = tags["icao"] || "";
  const mil = tags["military"] || "";

  let airspaceClass: AirspaceClass = "G";
  let controlRadiusNm = 0;
  let ceiling = ALT.DEFAULT_G;
  let restricted = false;

  if (mil === "airfield" || mil === "airport" || type === "military") {
    // Military / special-use joint fields — treat as restricted beyond a
    // minimal buffer; you generally need specific permission to operate.
    airspaceClass = "B";
    controlRadiusNm = 3;
    ceiling = ALT.CLASS_B;
    restricted = true;
  } else if (type === "international") {
    airspaceClass = "B";
    controlRadiusNm = 5;
    ceiling = ALT.CLASS_B;
  } else if (type === "regional") {
    airspaceClass = "C";
    controlRadiusNm = 4;
    ceiling = ALT.CLASS_C;
  } else if (icao && icao.length === 4 && iata) {
    // Commercial/public field with IATA → controlled, usually towered.
    airspaceClass = "C";
    controlRadiusNm = 4;
    ceiling = ALT.CLASS_C;
  } else if (icao) {
    airspaceClass = "D";
    controlRadiusNm = 2.5;
    ceiling = ALT.CLASS_D;
  } else if (type === "heliport" || type === "private") {
    // Surface elevation not normally in controlled airspace.
    airspaceClass = "G";
    controlRadiusNm = 0;
    ceiling = ALT.DEFAULT_G;
  } else {
    // Small municipal / public field: assume at least a Class E transition
    // surface or a small D. Keep a modest footprint + 1200 AGL ceiling.
    airspaceClass = "E";
    controlRadiusNm = 1.5;
    ceiling = ALT.SURFACE_E;
  }

  return {
    name,
    lat,
    lng,
    code: icao || iata || undefined,
    airspaceClass,
    controlRadius: controlRadiusNm * NM,
    ceiling,
    restricted,
    tags,
  };
}

export interface QueryInput {
  lat: number;
  lng: number;
  airports: AirportModel[];
  /** Distance (m) to nearest airport, precomputed. */
  nearestDistance: number;
  /** Nearest airport model, precomputed. */
  nearest: AirportModel | null;
  /** True if the point is inside a no-fly polygon (national park, etc). */
  inNoFlyZone: boolean;
  /** Name of the no-fly zone, if any. */
  noFlyZoneName?: string;
}

export interface QueryResult {
  status: FlyStatus;
  /** Legal flat ceiling for a typical Part 107 flight (ft AGL). */
  ceiling: number;
  airspaceClass: AirspaceClass;
  /** The controlling airport, if inside its footprint. */
  controllingAirport?: AirportModel | null;
  /** Distance to nearest airport (m). */
  nearestDistance: number;
  nearest?: AirportModel | null;
  reasons: string[];
}

/**
 * Evaluate the legal situation at a point.
 * Returns the flat altitude you may lawfully operate a typical sUAS at
 * (Part 107), plus human-readable reasons.
 */
export function evaluateAirspace(input: QueryInput): QueryResult {
  const reasons: string[] = [];

  // 1. No-fly zone (national parks, NPS land, restricted areas) → 0 AGL.
  if (input.inNoFlyZone) {
    return {
      status: "no_fly",
      ceiling: ALT.NO_FLY,
      airspaceClass: "G",
      nearestDistance: input.nearestDistance,
      nearest: input.nearest,
      reasons: [
        `Within ${input.noFlyZoneName || "a no-fly zone"} — operating drones is not permitted here.`,
        "This includes national parks and many restricted/ special-use areas.",
      ],
    };
  }

  // 2. Inside a restricted (military) airport footprint → treat as no-fly.
  const controlling = input.airports.find(
    (a) =>
      dist(a.lat, a.lng, input.lat, input.lng) <= a.controlRadius &&
      a.controlRadius > 0,
  );
  const nearestAltitudeAirport = controlling || input.nearest;

  if (controlling) {
    if (controlling.restricted) {
      return {
        status: "no_fly",
        ceiling: ALT.NO_FLY,
        airspaceClass: controlling.airspaceClass,
        controllingAirport: controlling,
        nearestDistance: input.nearestDistance,
        nearest: input.nearest,
        reasons: [
          `Within ${controlling.name} (military / special-use airspace) — no sUAS operation without explicit authorization.`,
        ],
      };
    }

    // 3. Controlled airspace → authorization (LAANC / WAAS) required.
    reasons.push(
      `Inside controlled airspace (Class ${controlling.airspaceClass}) for ${controlling.name} ` +
        `(${controlling.code || "no code"}).`,
      `You must obtain LAANC or FAA airspace authorization before flying.`,
    );
    return {
      status: "authorization",
      ceiling: Math.min(ALT.DEFAULT_G, controlling.ceiling), // typically still 400 AGL
      airspaceClass: controlling.airspaceClass,
      controllingAirport: controlling,
      nearestDistance: input.nearestDistance,
      nearest: input.nearest,
      reasons,
    };
  }

  // 4. Class G (uncontrolled) — no authorization, 400 ft AGL.
  if (nearestAltitudeAirport && nearestAltitudeAirport.airspaceClass === "E") {
    reasons.push(
      `Outside a known controlled footprint — operating in Class G (uncontrolled) airspace.`,
    );
  } else {
    reasons.push(`No controlled airspace within the derived footprints — operating in Class G.`);
  }
  if (input.nearest) {
    reasons.push(
      `${Math.round(input.nearestDistance / NM * 10) / 10} nm from ${input.nearest.name} — keep clear, ` +
        `do not enter restricted areas.`,
    );
  }
  return {
    status: "fly",
    ceiling: ALT.DEFAULT_G,
    airspaceClass: "G",
    nearestDistance: input.nearestDistance,
    nearest: input.nearest,
    reasons,
  };
}

/** Great-circle distance in meters. */
export function dist(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
const toRad = (d: number) => (d * Math.PI) / 180;

export function nm(meters: number): number {
  return Math.round((meters / NM) * 10) / 10;
}