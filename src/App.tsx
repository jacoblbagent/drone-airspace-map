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
  const [toggles, setToggles] = useState<Toggles>({
    airports: true,
    rings: true,
    zones: true,
  });
  const [geocoding, setGeocoding] = useState(false);

  const toggle = (k: keyof Toggles) => setToggles((t) => ({ ...t, [k]: !t[k] }));

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

        <div className="legend">
          <LegendItem color="#22c55e" label="Fly — Class G, no auth (400 ft)" />
          <LegendItem color="#facc15" label="Controlled — LAANC auth req'd" />
          <LegendItem color="#ef4444" label="National park / no-fly" />
        </div>
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
        onQuery={setQuery}
        onQueryLoading={setQueryLoading}
        onLoadState={(s) => setLoadState((l) => ({ ...l, ...s }))}
      />

      <aside className="layers-panel">
        <h3>Layers</h3>
        <ToggleRow label="Airport markers" k="airports" checked={toggles.airports} onChange={toggle} count={airports.length} />
        <ToggleRow label="Controlled airspace" k="rings" checked={toggles.rings} onChange={toggle} count={airspace.length} />
        <ToggleRow label="Parks / restricted" k="zones" checked={toggles.zones} onChange={toggle} count={zones.length} />
        <div className="panel-hint">
          <p>
            <strong>Click anywhere</strong> on the map to list the airspace, UAS Facility
            Map ceiling, fixed flyer sites, airports and parks that apply to that spot.
          </p>
          <p>
            Zoom in (≥ zoom 8) to load <strong>live FAA &amp; NPS data</strong> for the
            visible area — airports, controlled-airspace polygons and protected or
            restricted areas.
          </p>
          <button className="ghost" onClick={clearQuery}>
            Clear pin
          </button>
        </div>
      </aside>

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

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="legend-item">
      <i style={{ background: color }} />
      {label}
    </span>
  );
}