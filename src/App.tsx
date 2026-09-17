import { useState } from "react";
import DroneMap, { type Toggles } from "./components/DroneMap";
import NearbyList from "./components/NearbyList";
import type { AirportModel } from "./lib/airspace";
import type { NearbyResult } from "./lib/nearby";
import type { AirspaceZone, NoFlyZone } from "./lib/areas";

export default function App() {
  const [airports, setAirports] = useState<AirportModel[]>([]);
  const [zones, setZones] = useState<NoFlyZone[]>([]);
  const [airspace, setAirspace] = useState<AirspaceZone[]>([]);
  const [loadState, setLoadState] = useState({ airports: false, zones: false });
  const [query, setQuery] = useState<NearbyResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  /** Point being queried right now — labels the in-flight indicator. */
  const [pending, setPending] = useState<{ lat: number; lng: number } | null>(null);
  const [toggles, setToggles] = useState<Toggles>({
    airports: true,
    radius: true,
    rings: true,
    zones: true,
  });
  const [geocoding, setGeocoding] = useState(false);
  /** On-map "click the map for info" prompt, shown whenever no result is open. */
  const [hintOpen, setHintOpen] = useState(() => {
    try {
      const stored = localStorage.getItem("droneairspace.hint.open");
      if (stored !== null) return stored !== "0";
    } catch {
      /* storage unavailable */
    }
    return true;
  });

  function setHint(next: boolean) {
    setHintOpen(next);
    try {
      localStorage.setItem("droneairspace.hint.open", next ? "1" : "0");
    } catch {
      /* non-fatal */
    }
  }
  const [layersOpen, setLayersOpen] = useState(() => {
    try {
      const stored = localStorage.getItem("droneairspace.layers.open");
      if (stored !== null) return stored !== "0";
    } catch {
      /* storage unavailable */
    }
    // No stored preference: start collapsed on compact screens (phones, and
    // phones on their side) so the panel doesn't cover the map or sit behind
    // the results sheet; expanded on anything with room for it.
    if (typeof window === "undefined") return true;
    return window.innerWidth > 700 && window.innerHeight > 560;
  });

  const toggle = (k: keyof Toggles) => setToggles((t) => ({ ...t, [k]: !t[k] }));

  /**
   * Collapse/expand the layers panel.
   *
   * On sheet layouts (≤900px) the two panels would occupy the same space, and
   * the results sheet sits above the layers panel — which made the lower layer
   * rows untappable. So on those widths the two are mutually exclusive:
   * opening Layers dismisses the results (the pin stays on the map).
   */
  function toggleLayers() {
    const next = !layersOpen;
    if (next && typeof window !== "undefined" && window.innerWidth <= 900) {
      setQuery(null);
    }
    setLayersOpen(next);
    try {
      localStorage.setItem("droneairspace.layers.open", next ? "1" : "0");
    } catch {
      /* non-fatal */
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">🛸</span>
          <div>
            <h1>DroneAirspace</h1>
            <p className="tagline">Where you can fly · how high you can go</p>
          </div>
        </div>

        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            const v = (e.currentTarget.elements.namedItem("q") as HTMLInputElement).value;
            handleSearch(v);
          }}
        >
          <input name="q" placeholder="Search a city, park, or airport…" />
          <button disabled={geocoding}>{geocoding ? "…" : "Go"}</button>
        </form>
      </header>

      <DroneMap
        airports={airports}
        zones={zones}
        airspace={airspace}
        toggles={toggles}
        loadState={loadState}
        onAirports={setAirports}
        onZones={setZones}
        onAirspace={setAirspace}
        onQuery={(r) => {
          setQuery(r);
          // On sheet layouts (≤900px) the results panel and the layers panel
          // would fight for the same space, so new results tuck the layers
          // panel away. Not persisted — it's a layout response, not a
          // preference.
          if (r && window.innerWidth <= 900) setLayersOpen(false);
        }}
        onQueryLoading={(l, at) => {
          setQueryLoading(l);
          setPending(l ? (at ?? null) : null);
        }}
        onLoadState={(s) => setLoadState((l) => ({ ...l, ...s }))}
      />

      <aside className={`layers-panel${layersOpen ? "" : " is-collapsed"}`}>
        <button
          className="lp-head"
          onClick={toggleLayers}
          aria-expanded={layersOpen}
          title={layersOpen ? "Collapse layers" : "Expand layers"}
        >
          <span className="lp-title">Layers</span>
          <span className="lp-chevron" aria-hidden="true">
            {layersOpen ? "▾" : "▸"}
          </span>
        </button>
        {layersOpen && (
          <div className="lp-body">
            <ToggleRow label="Airport markers" k="airports" checked={toggles.airports} onChange={toggle} count={airports.length} />
            <ToggleRow label="Control radius" k="radius" checked={toggles.radius} onChange={toggle} count={airports.length} />
            <ToggleRow label="Class airspace" k="rings" checked={toggles.rings} onChange={toggle} count={airspace.length} />
            <ToggleRow label="Parks / restricted" k="zones" checked={toggles.zones} onChange={toggle} count={zones.length} />
            <div className="panel-hint">
              <p>
                <strong>Click anywhere</strong> on the map to list the airspace, UAS Facility
                Map ceiling, fixed flyer sites, airports and parks that apply to that spot.
              </p>
              <p>
                Zoom in (≥ zoom 8) to load <strong>live FAA &amp; NPS data</strong> for the
                visible area — airports, airspace polygons and protected or restricted areas.
              </p>
              <p>
                <em>Control radius</em> is an approximation from the field's type;{" "}
                <em>Class airspace</em> is the published FAA boundary.
              </p>
              <button className="ghost" onClick={clearQuery}>
                Clear pin
              </button>
            </div>
          </div>
        )}
      </aside>

      {/*
        A click is in flight and nothing is open yet: show the wait in the same
        slot the results will land in, so the click feels answered immediately.
      */}
      {!query && queryLoading && (
        <aside className="map-hint is-loading" role="status" aria-live="polite">
          <div className="mh-head">
            <span className="mh-spinner" aria-hidden="true" />
            <span className="mh-title">Checking this spot…</span>
          </div>
          {pending && (
            <div className="mh-coords">
              {pending.lat.toFixed(4)}, {pending.lng.toFixed(4)}
            </div>
          )}
          <p>
            Querying the live FAA UAS Facility Map, Class &amp; Special Use Airspace,
            airports, fixed flyer sites and NPS boundaries.
          </p>
        </aside>
      )}

      {/*
        Empty state: nothing is pinned, or the user closed the last result.
        Tells them what the map can do, and collapses to a small toggle so it
        never becomes permanent clutter.
      */}
      {!query &&
        !queryLoading &&
        (hintOpen ? (
          <aside className="map-hint" role="status">
            <div className="mh-head">
              <span className="mh-title">No spot selected</span>
              <button
                className="mh-icon-btn"
                onClick={() => setHint(false)}
                title="Collapse"
                aria-label="Collapse hint"
              >
                ×
              </button>
            </div>
            <p>
              <strong>Click anywhere on the map</strong> — a colored zone, an airport
              marker, or open ground — to see the fly / no-fly verdict, the maximum legal
              altitude, and every airport, Class airspace and park that applies there.
            </p>
            <p className="mh-sub">
              Zoom in (≥ zoom 8) to load live FAA &amp; NPS data for the visible area.
            </p>
          </aside>
        ) : (
          <button
            className="map-hint-toggle"
            onClick={() => setHint(true)}
            aria-expanded={false}
            title="Show map tips"
          >
            <span aria-hidden="true">❔</span>
            Click the map for airspace info
          </button>
        ))}

      {query && (
        <NearbyList
          result={query}
          loading={queryLoading}
          onClose={() => setQuery(null)}
          onRefresh={() =>
            window.dispatchEvent(
              new CustomEvent("drone-requery", {
                detail: { lat: query.lat, lng: query.lng },
              }),
            )
          }
          onFlyTo={(lat, lng, zoom) =>
            window.dispatchEvent(new CustomEvent("drone-flyto", { detail: { lat, lng, zoom } }))
          }
        />
      )}

      <div className="scale-note">
        Footprints are approximations for planning. Always verify with FAADroneZone / B4UFLY before flight.
      </div>

      <a
        className="footer-link"
        href="https://jacoblbagent.github.io/fpv-buyers-guide/"
        target="_blank"
        rel="noopener noreferrer"
      >
        Gear up → FPV Buyers Guide
      </a>
    </div>
  );

  async function handleSearch(q: string) {
    if (!q.trim()) return;
    setGeocoding(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
      );
      const j = (await res.json()) as Array<{
        lat: string;
        lon: string;
        boundingbox?: string[];
      }>;
      if (j && j.length) {
        const lat = parseFloat(j[0].lat);
        const lng = parseFloat(j[0].lon);
        const box = j[0].boundingbox?.map((x) => parseFloat(x));
        window.dispatchEvent(
          new CustomEvent("drone-pan", {
            detail: box && box.length === 4 ? { lat, lng, box } : { lat, lng },
          }),
        );
      }
    } finally {
      setGeocoding(false);
    }
  }

  function clearQuery() {
    setQuery(null);
    window.dispatchEvent(new CustomEvent("drone-clear-query"));
  }
}

function ToggleRow({
  label,
  checked,
  onChange,
  k,
  count,
}: {
  label: string;
  checked: boolean;
  onChange: (k: keyof Toggles) => void;
  k: keyof Toggles;
  count: number;
}) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={() => onChange(k)} />
      <span>{label}</span>
      {count > 0 && <span className="count">{count}</span>}
    </label>
  );
}