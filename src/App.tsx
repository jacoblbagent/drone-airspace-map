import { useState } from "react";
import DroneMap, { type Toggles } from "./components/DroneMap";
import StatusCard from "./components/StatusCard";
import type { AirportModel, QueryResult } from "./lib/airspace";
import type { NoFlyZone } from "./lib/overpass";

export type QueryState = QueryResult & { lat: number; lng: number };

export default function App() {
  const [airports, setAirports] = useState<AirportModel[]>([]);
  const [zones, setZones] = useState<NoFlyZone[]>([]);
  const [loadState, setLoadState] = useState({ airports: false, zones: false });
  const [query, setQuery] = useState<QueryState | null>(null);
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
        toggles={toggles}
        loadState={loadState}
        onAirports={setAirports}
        onZones={setZones}
        onQuery={setQuery}
        onLoadState={(s) => setLoadState((l) => ({ ...l, ...s }))}
      />

      <aside className="layers-panel">
        <h3>Layers</h3>
        <ToggleRow label="Airport markers" k="airports" checked={toggles.airports} onChange={toggle} count={airports.length} />
        <ToggleRow label="Controlled airspace" k="rings" checked={toggles.rings} onChange={toggle} count={airports.length} />
        <ToggleRow label="No-fly zones" k="zones" checked={toggles.zones} onChange={toggle} count={zones.length} />
        <div className="panel-hint">
          <p>
            Zoom into a region (≥ zoom 6) to load <strong>live airport &amp; protected-area data</strong>{" "}
            from OpenStreetMap.
          </p>
          <button className="ghost" onClick={clearQuery}>
            Clear pin
          </button>
        </div>
      </aside>

      {query && <StatusCard query={query} onClose={() => setQuery(null)} />}

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