import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { evaluateAirspace, dist, nm, type AirportModel } from "../lib/airspace";
import {
  fetchAirports,
  fetchControlledAirspace,
  fetchNoFlyZones,
  type AirspaceZone,
  type NoFlyZone,
} from "../lib/areas";
import { pointInZone } from "../lib/geo";
import { analyzePoint, type NearbyResult } from "../lib/nearby";

// DEV-only introspection so automated tests can assert real loaded data.
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>;
  w.__evaluate = evaluateAirspace;
  w.__dist = dist;
  w.__pip = pointInZone;
  w.__fetchAirports = fetchAirports;
  w.__fetchNoFlyZones = fetchNoFlyZones;
  w.__fetchControlledAirspace = fetchControlledAirspace;
  w.__analyzePoint = analyzePoint;
}

export interface Toggles {
  airports: boolean;
  /** Approximate per-airport control-radius circle. */
  radius: boolean;
  /** Published FAA Class B/C/D/E-surface polygons. */
  rings: boolean;
  zones: boolean;
}

export interface LoadState {
  airports: boolean;
  zones: boolean;
}

interface Props {
  airports: AirportModel[];
  zones: NoFlyZone[];
  airspace: AirspaceZone[];
  toggles: Toggles;
  loadState: LoadState;
  onAirports: (a: AirportModel[]) => void;
  onZones: (z: NoFlyZone[]) => void;
  onAirspace: (a: AirspaceZone[]) => void;
  onQuery: (q: NearbyResult | null) => void;
  onQueryLoading: (loading: boolean) => void;
  onLoadState: (s: Partial<LoadState>) => void;
}

const CLASS_COLOR: Record<string, string> = {
  B: "#ef4444",
  C: "#f97316",
  D: "#facc15",
  E: "#94a3b8",
  G: "#22c55e",
};

const RING_COLOR: Record<string, string> = {
  B: "#dc2626",
  C: "#ea580c",
  D: "#ca8a04",
  E: "#64748b",
};

const MIN_LOAD_ZOOM = 8;

function airportIcon(ap: AirportModel, dim: boolean) {
  const c = CLASS_COLOR[ap.airspaceClass] || "#94a3b8";
  const dot = ap.restricted ? "<span class='air-mark-restricted'>!</span>" : "";
  return L.divIcon({
    className: "",
    html: `<div class="air-marker${dim ? " is-dim" : ""}" style="--c:${c}">${dot}</div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

export default function DroneMap({
  airports,
  zones,
  airspace,
  toggles,
  loadState,
  onAirports,
  onZones,
  onAirspace,
  onQuery,
  onQueryLoading,
  onLoadState,
}: Props) {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const airportsRef = useRef<AirportModel[]>([]);
  const zonesRef = useRef<NoFlyZone[]>([]);
  /** Monotonic id so a slow response can't overwrite a newer click's result. */
  const querySeq = useRef(0);

  /** Set in the init effect; lets overlay clicks run the same query. */
  const runQueryRef = useRef<((lat: number, lng: number) => void) | null>(null);

  /**
   * Overlay click handler. Leaflet paths/markers with a popup swallow the map
   * click, so without this a click on a radius circle, an airspace polygon or
   * an airport marker would open a popup and never open the results list —
   * which is exactly where users click most (near an airport).
   */
  const queryOnClick = (e: L.LeafletMouseEvent) => {
    const t = e.latlng;
    if (t) runQueryRef.current?.(t.lat, t.lng);
  };

  const airportsLayer = useRef<L.LayerGroup>(L.layerGroup());
  const radiusLayer = useRef<L.LayerGroup>(L.layerGroup());
  const ringsLayer = useRef<L.LayerGroup>(L.layerGroup());
  const zonesLayer = useRef<L.LayerGroup>(L.layerGroup());
  const queryLayer = useRef<L.LayerGroup>(L.layerGroup());

  // Latest data available to the map's click handler.
  useEffect(() => {
    airportsRef.current = airports;
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__airports = airports;
    }
  }, [airports]);
  useEffect(() => {
    zonesRef.current = zones;
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__zones = zones;
    }
  }, [zones]);

  // ---- Init map once ------------------------------------------------------
  useEffect(() => {
    if (!mapDiv.current || mapRef.current) return;
    const map = L.map(mapDiv.current, {
      center: [39.5, -98.5],
      zoom: 5,
      scrollWheelZoom: true,
      minZoom: 4,
      maxZoom: 17,
      worldCopyJump: true,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__map = map;
    }
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      subdomains: "abc",
      referrerPolicy: "origin",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors',
    }).addTo(map);

    airportsLayer.current.addTo(map);
    radiusLayer.current.addTo(map);
    ringsLayer.current.addTo(map);
    zonesLayer.current.addTo(map);
    queryLayer.current.addTo(map);

    // Click-to-query: fan out to the live FAA layers and list what's relevant.
    let lastKey = "";
    let lastAt = 0;
    const runQuery = (lat: number, lng: number) => {
      // An overlay click can also reach the map, so drop the echo.
      const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
      const now = Date.now();
      if (key === lastKey && now - lastAt < 600) return;
      lastKey = key;
      lastAt = now;

      const seq = ++querySeq.current;
      queryLayer.current.clearLayers();
      L.marker([lat, lng], {
        icon: L.divIcon({
          className: "",
          html: `<div class="query-dot"></div>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        }),
        interactive: false,
      }).addTo(queryLayer.current);

      onQueryLoading(true);
      analyzePoint({ lat, lng, zones: zonesRef.current })
        .then((res) => {
          if (seq !== querySeq.current) return; // stale click, drop it
          onQuery(res);
          // Drop a small dot on each result that has a location, so the list
          // and the map stay linked. Marker failures must never take down the
          // results panel, so this is isolated + guarded.
          try {
            for (const it of res.items) {
              const t = it.flyTo;
              if (!t || !isFinite(t.lat) || !isFinite(t.lng)) continue;
              L.marker([t.lat, t.lng], {
                icon: L.divIcon({
                  className: "",
                  html: `<div class="rel-dot sev-${it.severity}"></div>`,
                  iconSize: [10, 10],
                  iconAnchor: [5, 5],
                }),
              })
                .bindTooltip(it.title, { direction: "top", offset: [0, -6] })
                .on("click", queryOnClick)
                .addTo(queryLayer.current);
            }
          } catch (err) {
            console.warn("result markers failed", err);
          }
        })
        .catch((e) => {
          if (import.meta.env.DEV) console.warn("airspace query failed", e);
          if (seq === querySeq.current) onQuery(null);
        })
        .finally(() => {
          if (seq === querySeq.current) onQueryLoading(false);
        });
    };

    map.on("click", (e: L.LeafletMouseEvent) => runQuery(e.latlng.lat, e.latlng.lng));
    runQueryRef.current = runQuery;
    // Re-run for the same point (panel "refresh" action).
    const onRequery = (e: Event) => {
      const d = (e as CustomEvent).detail as { lat: number; lng: number };
      runQuery(d.lat, d.lng);
    };
    window.addEventListener("drone-requery", onRequery);

    // Load live data for the area around the viewport center, throttled.
    // The query box is clamped so a single Overpass request stays bounded,
    // and we only fetch once zoomed in to a region (not at country scale).
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loadRegion = () => {
      const size = map.getSize();
      if (size.x === 0 || size.y === 0 || !map.getContainer().isConnected) return;
      const zoom = map.getZoom();
      if (zoom < MIN_LOAD_ZOOM) return;
      // Query the real viewport (padded) so the layers always match what is
      // on screen. The FAA services are cheap, so no artificial window.
      const b = map.getBounds().pad(0.2);
      const south = Math.max(-85, b.getSouth());
      const north = Math.min(85, b.getNorth());
      const west = b.getWest();
      const east = b.getEast();

      onLoadState({ airports: true });
      fetchAirports(south, west, north, east)
        .then((a) => {
          onAirports(a);
          onLoadState({ airports: false });
        })
        .catch(() => onLoadState({ airports: false }));
      onAirspace([]);
      fetchControlledAirspace(south, west, north, east)
        .then(onAirspace)
        .catch(() => onAirspace([]));
      if (toggles.zones) {
        // Staggered so both services aren't hit in the same tick.
        setTimeout(() => {
          onLoadState({ zones: true });
          fetchNoFlyZones(south, west, north, east)
            .then((z) => {
              onZones(z);
              onLoadState({ zones: false });
            })
            .catch(() => onLoadState({ zones: false }));
        }, 600);
      }
    };
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(loadRegion, 600);
    };
    map.on("moveend", debounced);
    map.on("zoomend", debounced);
    setTimeout(loadRegion, 400); // initial load

    const onPan = (e: Event) => {
      const d = (e as CustomEvent).detail as { lat: number; lng: number; box?: number[] };
      if (d.box) {
        map.fitBounds([[d.box[0], d.box[2]], [d.box[1], d.box[3]]], { maxZoom: 13 });
      } else {
        map.setView([d.lat, d.lng], 10);
      }
      setTimeout(loadRegion, 500);
    };
    const onFlyTo = (e: Event) => {
      const d = (e as CustomEvent).detail as { lat: number; lng: number; zoom?: number };
      map.setView([d.lat, d.lng], d.zoom ?? 12);
      setTimeout(loadRegion, 500);
    };
    const onClear = () => {
      queryLayer.current.clearLayers();
      onQuery(null);
    };
    window.addEventListener("drone-pan", onPan);
    window.addEventListener("drone-flyto", onFlyTo);
    window.addEventListener("drone-clear-query", onClear);

    return () => {
      window.removeEventListener("drone-pan", onPan);
      window.removeEventListener("drone-flyto", onFlyTo);
      window.removeEventListener("drone-requery", onRequery);
      window.removeEventListener("drone-clear-query", onClear);
      if (timer) clearTimeout(timer);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Airport markers -----------------------------------------------------
  useEffect(() => {
    const layer = airportsLayer.current;
    layer.clearLayers();
    if (!toggles.airports) return;
    for (const a of airports) {
      const mk = L.marker([a.lat, a.lng], { icon: airportIcon(a, false) });
      mk.bindPopup(
        `<div class="pop">
          <h4>${escapeHtml(a.name)}</h4>
          <div class="pop-meta">
            ${a.code ? `<span>${escapeHtml(a.code)}</span>` : ""}
            <span class="class-chip" style="--c:${CLASS_COLOR[a.airspaceClass]}">Class ${a.airspaceClass}</span>
          </div>
          <p><strong>Ceiling ${a.ceiling} ft AGL</strong> · Approx. control radius ${nm(a.controlRadius)} nm</p>
          <p class="pop-note">${a.restricted ? "Military / special-use — no sUAS without authorization." : "Controlled footprint approximated from airport type for planning."}</p>
        </div>`,
      );
      mk.on("click", queryOnClick);
      mk.addTo(layer);
    }
  }, [airports, toggles.airports]);

  // ---- Control radius (approximate per-airport footprint) -------------------
  // Kept alongside the published Class-airspace polygons: this is the quick
  // "how far does this field's controlled area reach" hint, and unlike the
  // polygons it is still visible in places the FAA publishes no surface area.
  useEffect(() => {
    const layer = radiusLayer.current;
    layer.clearLayers();
    if (!toggles.radius) return;
    for (const a of airports) {
      if (a.controlRadius <= 0) continue;
      const colour = RING_COLOR[a.airspaceClass] || "#64748b";
      // Non-interactive: a radius circle covers a whole airport area, so an
      // interactive one would eat every click near a field. Clicking through
      // runs the airspace query, which reports the field in the results list.
      L.circle([a.lat, a.lng], {
        radius: a.controlRadius,
        color: colour,
        weight: 1.2,
        dashArray: "3 5",
        fillColor: colour,
        fillOpacity: a.restricted ? 0.2 : 0.07,
        interactive: false,
      }).addTo(layer);
    }
  }, [airports, toggles.radius]);

  // ---- Controlled airspace (real FAA Class B/C/D/E-surface polygons) --------
  useEffect(() => {
    const layer = ringsLayer.current;
    layer.clearLayers();
    if (!toggles.rings) return;
    for (const z of airspace) {
      const ringsGeo = z.geometry.map((ring) =>
        ring.map(([lat, lng]) => [lng, lat] as [number, number]),
      );
      L.polygon(ringsGeo, {
        color: RING_COLOR[z.cls] || "#64748b",
        weight: 1.5,
        fillColor: RING_COLOR[z.cls] || "#64748b",
        fillOpacity: 0.12,
        // See the radius layer: never eat clicks over a published boundary.
        interactive: false,
      }).addTo(layer);
    }
  }, [airspace, toggles.rings]);

  // ---- No-fly zones ---------------------------------------------------------
  useEffect(() => {
    const layer = zonesLayer.current;
    layer.clearLayers();
    if (!toggles.zones) return;
    for (const z of zones) {
      const ringsGeo = z.geometry.map((ring) =>
        ring.map(([lat, lng]) => [lng, lat] as [number, number]),
      );
      L.polygon(ringsGeo, {
        color: z.kind === "park" ? "#dc2626" : "#7f1d1d",
        weight: 1.5,
        fillColor: z.kind === "park" ? "#ef4444" : "#b91c1c",
        fillOpacity: 0.2,
        dashArray: "4 4",
      })
        .bindPopup(
          `<h4>${escapeHtml(z.name)}</h4><p>${z.kind === "park" ? "National Park Service land — launching, landing and operating drones is prohibited" : "Prohibited / restricted / national-security airspace — sUAS operations require authorization"}</p>`,
        )
        .on("click", queryOnClick)
        .addTo(layer);
    }
  }, [zones, toggles.zones]);

  return (
    <div className="map-wrap">
      <div ref={mapDiv} className="map" />
      {loadState.airports && (
        <div className="map-badge">
          {toggles.zones ? "Loading airspace…" : "Loading airports…"}
        </div>
      )}
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}