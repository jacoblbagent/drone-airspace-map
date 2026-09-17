import { useState } from "react";
import { fmtMi, type NearbyItem, type NearbyResult } from "../lib/nearby";
import type { FlyStatus } from "../lib/airspace";

const STATUS_META: Record<FlyStatus, { label: string; icon: string; cls: string; title: string }> = {
  fly: {
    label: "Fly OK",
    icon: "🟢",
    cls: "status-fly",
    title: "Class G — no authorization required",
  },
  authorization: {
    label: "LAANC Required",
    icon: "🟡",
    cls: "status-authorization",
    title: "Controlled airspace — authorization required",
  },
  no_fly: {
    label: "No Fly",
    icon: "🔴",
    cls: "status-nofly",
    title: "Operation not permitted here",
  },
  unknown: {
    label: "Couldn't Determine",
    icon: "⚪",
    cls: "status-unknown",
    title: "Live FAA data did not load — retry before relying on this",
  },
};

interface Props {
  result: NearbyResult | null;
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onFlyTo: (lat: number, lng: number, zoom?: number) => void;
}

export default function NearbyList({ result, loading, onClose, onRefresh, onFlyTo }: Props) {
  if (!result) return null;
  const meta = STATUS_META[result.status];
  const label = result.statusLabel || meta.label;
  const title = result.statusTitle || meta.title;
  const dangerous = result.items.filter((i) => i.severity === "danger").length;

  return (
    <aside className={`nearby-panel ${meta.cls}`} onClick={(e) => e.stopPropagation()}>
      <div className="nv-grab" aria-hidden="true" />
      <header className="nv-top">
        <div className="nv-coords">
          <span>{result.lat.toFixed(4)}, {result.lng.toFixed(4)}</span>
          {loading && <span className="nv-loading">updating…</span>}
        </div>
        <div className="nv-actions">
          <button className="nv-icon-btn" onClick={onRefresh} title="Re-run airspace query" aria-label="Refresh">
            ↻
          </button>
          <button className="nv-icon-btn" onClick={onClose} title="Close" aria-label="Close">
            ×
          </button>
        </div>
      </header>

      <div className="nv-verdict">
        <span className="nv-verdict-icon">{meta.icon}</span>
        <div className="nv-verdict-text">
          <div className="nv-verdict-label">{label}</div>
          <div className="nv-verdict-title">{title}</div>
        </div>
        <div className="nv-verdict-alt">
          {result.status === "unknown" ? (
            <>
              <span className="nv-alt-big">—</span>
              <span className="nv-alt-sub">altitude unknown · retry</span>
            </>
          ) : (
            <>
              <span className="nv-alt-big">{result.ceiling.toLocaleString()} ft</span>
              <span className="nv-alt-sub">max AGL · Part 107</span>
            </>
          )}
        </div>
      </div>

      <div className="nv-list-head">
        <h3>Relevant at this location</h3>
        <span className="nv-count">
          {result.items.length} item{result.items.length === 1 ? "" : "s"}
          {dangerous > 0 ? ` · ${dangerous} advisory` : ""}
        </span>
      </div>

      <ul className="nv-list">
        {result.items.map((it) => (
          <Item
            key={it.id}
            item={it}
            onFlyTo={onFlyTo}
          />
        ))}
      </ul>

      {result.errors.length > 0 && (
        <p className="nv-errors">
          {result.rateLimited ? (
            <>
              <strong>The FAA data service is rate-limiting this browser.</strong>{" "}
              {result.errors.join(", ")} didn&apos;t load — it asks clients to slow down
              when a lot of lookups land at once. Wait a few seconds, then retry with ↻.
            </>
          ) : (
            <>
              <strong>
                {result.errors.length === 1
                  ? "One live data source didn't load:"
                  : `${result.errors.length} live data sources didn't load:`}
              </strong>{" "}
              {result.errors.join(", ")}. The list above may be incomplete — these services
              occasionally drop a request, so try the ↻ refresh button.
            </>
          )}
        </p>
      )}

      <footer className="nv-foot">
        <span className="nv-disclaimer">
          Live FAA UAS Facility Map, Class &amp; Special Use Airspace, ADHP airports, fixed
          flyer sites and NPS boundaries. Planning aid only — verify with B4UFLY / DroneZone
          before flight.
        </span>
        <span className="nv-credit">
          Basemap © OpenStreetMap contributors · Leaflet
        </span>
      </footer>
    </aside>
  );
}

function Item({
  item,
  onFlyTo,
}: {
  item: NearbyItem;
  onFlyTo: (lat: number, lng: number, zoom?: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const mi = fmtMi(item.distanceM);
  const hasDetail = item.detail.length > 0 || item.link || item.flyTo;

  return (
    <li className={`nv-item sev-${item.severity}${open ? " is-open" : ""}`}>
      <button
        className="nv-row"
        onClick={() => hasDetail && setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="nv-row-main">
          <span className="nv-title-line">
            <span className="nv-title">{item.title}</span>
            {item.badge && <span className="nv-badge">{item.badge}</span>}
          </span>
          {item.subtitle && <span className="nv-sub">{item.subtitle}</span>}
        </span>
        <span className="nv-row-side">
          {mi && <span className="nv-dist">{mi}</span>}
          {hasDetail && <span className="nv-more">{open ? "less" : "more"}</span>}
        </span>
      </button>

      {open && (
        <div className="nv-detail">
          {item.detail.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          <div className="nv-detail-actions">
            {item.flyTo && (
              <button
                className="nv-ghost"
                onClick={() => onFlyTo(item.flyTo!.lat, item.flyTo!.lng, item.flyTo!.zoom)}
              >
                Center on map
              </button>
            )}
            {item.link && (
              <a className="nv-link" href={item.link.href} target="_blank" rel="noopener noreferrer">
                {item.link.label}
              </a>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
