import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { dist, evaluateAirspace, nm, type AirportModel } from "../lib/airspace";
import { fetchAirports, fetchNoFlyZones, type NoFlyZone } from "../lib/overpass";
import { pointInZone } from "../lib/geo";
import type { QueryResult } from "../lib/airspace";

// DEV-only introspection so automated tests can assert real loaded data.
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>;
  w.__evaluate = evaluateAirspace;
  w.__dist = dist;
  w.__pip = pointInZone;
  w.__fetchAirports = fetchAirports;
}

export interface Toggles {
  airports: boolean;
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
  toggles: Toggles;
  loadState: LoadState;
  onAirports: (a: AirportModel[]) => void;
  onZones: (z: NoFlyZone[]) => void;
  onQuery: (q: (QueryResult & { lat: number; lng: number }) | null) => void;
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
  toggles,
  loadState,
  onAirports,
  onZones,
  onQuery,
  onLoadState,
}: Props) {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const airportsRef = useRef<AirportModel[]>([]);
  const zonesRef = useRef<NoFlyZone[]>([]);

  const airportsLayer = useRef<L.LayerGroup>(L.layerGroup());
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
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      subdomains: "abc",
      referrerPolicy: "origin",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors',
    }).addTo(map);

    airportsLayer.current.addTo(map);
    ringsLayer.current.addTo(map);
    zonesLayer.current.addTo(map);
    queryLayer.current.addTo(map);

    // Click-to-query: evaluate airspace at the chosen point.
    map.on("click", (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;
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

      const aps = airportsRef.current;
      let nearest: AirportModel | null = null;
      let nearestDist = Infinity;
      for (const a of aps) {
        const d = dist(a.lat, a.lng, lat, lng);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = a;
        }
      }
      const hit = zonesRef.current.find((z) => pointInZone(lat, lng, z.geometry));
      const result = evaluateAirspace({
        lat,
        lng,
        airports: aps,
        nearestDistance: nearestDist,
        nearest,
        inNoFlyZone: !!hit,
        noFlyZoneName: hit?.name,
      });
      onQuery({ ...result, lat, lng });
    });

    // Load live data for the area around the viewport center, throttled.
    // The query box is clamped so a single Overpass request stays bounded,
    // and we only fetch once zoomed in to a region (not at country scale).
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loadRegion = () => {
      const size = map.getSize();
      if (size.x === 0 || size.y === 0 || !map.getContainer().isConnected) return;
      const zoom = map.getZoom();
      if (zoom < MIN_LOAD_ZOOM) return;
      const c = map.getCenter();
      // Center-stable, bounded window around the map centre.
      const pad = 1.5;
      const south = Math.max(-85, c.lat - pad);
      const north = Math.min(85, c.lat + pad);
      const west = c.lng - pad * 1.5;
      const east = c.lng + pad * 1.5;

      onLoadState({ airports: true });
      fetchAirports(south, west, north, east)
        .then((a) => {
          onAirports(a);
          onLoadState({ airports: false });
        })
        .catch(() => onLoadState({ airports: false }));
      if (toggles.zones) {
        // Stagger the zones request so the two heavy Overpass queries don't
        // collide and trip rate limiting.
        setTimeout(() => {
          onLoadState({ zones: true });
          fetchNoFlyZones(south, west, north, east)
            .then((z) => {
              onZones(z);
              onLoadState({ zones: false });
            })
            .catch(() => onLoadState({ zones: false }));
        }, 900);
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
    const onClear = () => {
      queryLayer.current.clearLayers();
      onQuery(null);
    };
    window.addEventListener("drone-pan", onPan);
    window.addEventListener("drone-clear-query", onClear);

    return () => {
      window.removeEventListener("drone-pan", onPan);
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
      mk.addTo(layer);
    }
  }, [airports, toggles.airports]);

  // ---- Control rings --------------------------------------------------------
  useEffect(() => {
    const layer = ringsLayer.current;
    layer.clearLayers();
    if (!toggles.rings) return;
    for (const a of airports) {
      if (a.controlRadius <= 0) continue;
      const r = L.circle([a.lat, a.lng], {
        radius: a.controlRadius,
        color: RING_COLOR[a.airspaceClass] || "#64748b",
        weight: 1.5,
        fillColor: RING_COLOR[a.airspaceClass] || "#64748b",
        fillOpacity: a.restricted ? 0.28 : 0.12,
      });
      r.bindPopup(
        `<h4>${escapeHtml(a.name)}</h4><p>Class ${a.airspaceClass} zone · ceiling ${a.ceiling} ft · shadow approx.</p>`,
      );
      r.addTo(layer);
    }
  }, [airports, toggles.rings]);

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
          `<h4>${escapeHtml(z.name)}</h4><p>${z.kind === "park" ? "National park / protected area — drones not permitted" : "Restricted area — drones not permitted"}</p>`,
        )
        .addTo(layer);
    }
  }, [zones, toggles.zones]);

  // ---- Search ---------------------------------------------------------------
  // Search box rendered outside map; handled via App. Map stays leaflet here.

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