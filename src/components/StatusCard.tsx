import type { QueryState } from "../App";

const STATUS_META: Record<string, { label: string; icon: string; cls: string; title: string }> = {
  fly: {
    label: "Fly OK",
    icon: "🟢",
    cls: "status-fly",
    title: "No authorization required",
  },
  authorization: {
    label: "LAANC Required",
    icon: "🟡",
    cls: "status-authorization",
    title: "Authorization required",
  },
  no_fly: {
    label: "No Fly",
    icon: "🔴",
    cls: "status-nofly",
    title: "Operation not permitted",
  },
};

function fmtFt(n: number) {
  return n === 0 ? "0 ft" : `${n.toLocaleString()} ft`;
}

export default function StatusCard({
  query,
  onClose,
}: {
  query: QueryState;
  onClose: () => void;
}) {
  const meta = STATUS_META[query.status];
  const gtLabel = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

  return (
    <div className={`status-card ${meta.cls}`} onClick={(e) => e.stopPropagation()}>
      <button className="close" onClick={onClose} aria-label="Close">
        ×
      </button>

      <p className="sc-loc">
        {query.lat.toFixed(4)}, {query.lng.toFixed(4)}
      </p>

      <div className="sc-status">
        <span className="sc-icon">{meta.icon}</span>
        <div>
          <div className="sc-label">{meta.label}</div>
          <div className="sc-title">{meta.title}</div>
        </div>
      </div>

      <div className="sc-ceiling">
        <span className="sc-big">{fmtFt(query.ceiling)}</span>
        <span className="sc-sub">max AGL · Part 107</span>
      </div>

      <ul className="sc-reasons">
        {query.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
        {query.nearest && query.nearest !== query.controllingAirport && (
          <li>
            Nearest airport: <strong>{query.nearest.name}</strong> ({gtLabel(query.nearestDistance)})
          </li>
        )}
      </ul>

      <div className="sc-footer">
        <span>Class {query.airspaceClass} · shown as elevation ceiling</span>
      </div>
    </div>
  );
}