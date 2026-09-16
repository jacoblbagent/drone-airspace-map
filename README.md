# 🛸 DroneAirspace

**Where you can fly a drone — and how high you can legally go before you enter restricted airspace.**

An interactive Leaflet map that classifies any point on Earth by its sUAS (drone) flight
eligibility under Part 107-style rules. Click anywhere to get an instant "can I fly, and up to
what altitude" verdict.

---

## What it does

- **Live airport data** — loads real aerodromes from OpenStreetMap (via Overpass) for the region
  you've zoomed into (zoom ≥ 8).
- **Controlled-airspace rings** — each airport gets an approximate controlled-airspace footprint
  and a ceiling, inferred from its type/size (Class B/C/D/E). Click an airport for its popup.
- **No-fly zones** — national parks and military/restricted areas are shaded red.
- **Click-to-query** — click any spot for a legal verdict:
  - 🟢 **Fly OK** — operating in Class G, no authorization needed, max **400 ft AGL**.
  - 🟡 **LAANC required** — inside controlled airspace (Class B/C/D); get FAA authorization.
  - 🔴 **No Fly** — inside a national park or restricted area.
- **Layers panel** — toggle airports, rings, and no-fly zones independently (with live counts).
- **Search** — geocode a city/park/airport via Nominatim and jump to it.

## Live demo

🖥 http://localhost:5177 (dev) — general production build: `npm run build && npm run preview`.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5177
```

## Stack

- **React 19 + TypeScript + Vite + SCSS**
- **Leaflet** (OpenStreetMap tiles, `referrerPolicy: 'origin'`)
- **Overpass API** for live OSM airport & park/military data
- **Nominatim** for search geocoding

## How the rules work / data provenance

Airspace footprints are **approximations for planning**, not an official FAA product:

- Airports come from OpenStreetMap `aeroway=aerodrome` (real positions, names, codes).
- Airspace class is inferred: `international` → Class B, IATA commercial → Class C,
  ICAO non-commercial → Class D, small/heliport → E/G. Ceiling = the class's typical ceiling
  (10,000 / 4,000 / 2,500 / 1,200 / 400 ft AGL).
- No-fly zones = OSM national-park / nature-reserve / protected-area and military polygons.
  OSM tagging of park boundaries is inconsistent, so not every park is captured — treat
  conservation/restricted land with care and always confirm with B4UFLY.

**Always verify with the official FAA tools (B4UFLY, FAADroneZone / LAANC) before flight.**

## Notes

- Zoom into a region to fetch data — the map loads airports & parks for the area around the
  viewport center once you're at zoom 8+.
- Overpass is a free public instance; under heavy use it may rate-limit (the app retries and
  degrades gracefully — it never crashes without data).
- A small DEV-only introspection hook (`window.__airports` / `window.__zones`) exists for
  automated testing and is tree-shaken from production builds.

## Deployment

Vite static build (no server needed). Deploy the `dist/` output to any static host (GitHub
Pages, Netlify, etc.).