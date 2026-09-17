# 🛸 DroneAirspace

**🔗 Live:** https://jacoblbagent.github.io/drone-airspace-map/

**Related:** [FPV Buyers Guide](https://jacoblbagent.github.io/fpv-buyers-guide/) — hand-picked drone/goggle/radio/etc. gear, filtered by budget.

**Where you can fly a drone — and how high you can legally go before you enter restricted airspace.**

An interactive Leaflet map that classifies any point by its sUAS (drone) flight eligibility
under Part 107-style rules. **Click anywhere** and the app queries live FAA and National Park
Service data for that exact spot, then lists everything relevant to it.

---

## What it does

- **Click anywhere → "Relevant at this location"** — an FAA-listing-style rundown of every airspace
  record that applies to the point you clicked, each with its distance and an expandable
  **more** detail:
  - **UAS Facility Map** — the LAANC grid ceiling: *"Permissible altitude for authorization: 400 ft."*
  - **Class airspace** — e.g. `ASHEVILLE CLASS C · Class: C · surface → 6,200 ft MSL`
  - **Special use airspace** — MOAs, prohibited / restricted / national-security areas
  - **Part-time national security UAS flight restrictions**
  - **Recreational Fixed Flyer Sites** — e.g. `NC-805`, with ceiling, boundary and sponsor contact
  - **Airports & heliports** — real FAA idents/ICAO codes, type, elevation, with distance
  - **National Park Service units** — national parks, parkways (Blue Ridge Parkway), scenic trails
- **Verdict header** — 🟢 Fly OK / 🟡 LAANC Required / 🔴 No Fly, plus the maximum AGL altitude.
- **Map layers**, each toggled independently with live counts, in a collapsible panel:
  - **Airport markers** — FAA ADHP airfields and heliports
  - **Control radius** — dashed circle per airport showing its approximate
    controlled-airspace footprint (kept because it still shows where the FAA publishes no
    surface area)
  - **Class airspace** — the *published* FAA Class B/C/D/E-surface polygons, with their real
    vertical limits
  - **Parks / restricted** — NPS boundaries plus prohibited/restricted/national-security airspace
- **Search** — geocode a city/park/airport via Nominatim and jump to it.
- **Refresh** — re-runs the airspace lookup for the pinned point.
- **Collapsible Layers panel** — collapse it to a small pill so it stops covering the map; the
  open/collapsed state is remembered between visits.

## Mobile

The layout is built for touch on phones and tablets, not just shrunk from desktop:

- **Results arrive as a bottom sheet** (≤900px) — full width, thumb-reachable, grab handle, and
  the list scrolls internally so the page itself never scrolls. The map pans automatically so the
  pin stays visible in the strip above the sheet.
- **The two panels are mutually exclusive** on sheet layouts: new results tuck the Layers panel
  away, and opening Layers dismisses the results. They would otherwise overlap, with the sheet
  covering the lower layer rows so they couldn't be tapped.
- **Touch targets** — rows ≥56px, icon buttons / layer rows / buttons ≥44px, checkboxes 20px inside
  a 44px row, and 38px map zoom buttons moved to the top-right so they clear the layers panel.
- **16px inputs** on every coarse-pointer device, which stops iOS Safari zooming the page when the
  search field is focused.
- **Safe areas** — the topbar, sheet, and layers panel respect `env(safe-area-inset-*)`, and the
  layout uses `100dvh` so mobile browser chrome showing/hiding doesn't clip it.
- **Attribution** — the sheet sits above Leaflet's attribution control, so the basemap credit is
  repeated in the sheet footer to keep it visible.

## Data sources (all live, all authoritative, no API key)

| Data | Source |
| --- | --- |
| UAS Facility Map (LAANC grid ceilings) | FAA `FAA_UAS_FacilityMap_Data_V5` FeatureServer |
| Class airspace + vertical limits | FAA `Class_Airspace` FeatureServer |
| Special use airspace / national-security restrictions | FAA `Special_Use_Airspace`, `Part_Time_National_Security_UAS_Flight_Restrictions` |
| Airports & heliports | FAA `ADHP` (Airport/Heliport data) |
| Recreational flyer fixed sites | FAA `Recreational_Flyer_Fixed_Sites` |
| National park units, parkways, trails | NPS Land Resources Division boundary service |
| Basemap tiles / geocoding | OpenStreetMap tiles (with `referrerPolicy: 'origin'`), Nominatim |

Both ArcGIS hosts send `access-control-allow-origin: *`, so the browser queries them directly.
Everything degrades gracefully: if a layer fails, the items that did load are still shown.

## Verdict logic

- **No Fly** — inside a national park / protected area or restricted land, inside
  prohibited/restricted/national-security airspace, or inside a national-security UAS restriction.
- **Authorization Required** — a UAS Facility Map cell carrying a **0 ft** ceiling. LAANC cannot
  grant any altitude there; flight needs a manually reviewed FAA DroneZone airspace authorization
  and is frequently denied. Shown as `Authorization Required — no LAANC available`.
- **LAANC Required** — inside Class B/C/D or a Class E surface area. Ceiling shown is the
  Facility Map grid value for the cell, otherwise 400 ft AGL.
- **Fly OK** — Class G, no authorization needed, 400 ft AGL.
- Class A and Class E transition areas (700/1200 ft AGL) are deliberately excluded from the
  listing — they cannot constrain a flight at or below 400 ft AGL.

## Live demo

🌐 **Deployed:** https://jacoblbagent.github.io/drone-airspace-map/ (GitHub Pages, `gh-pages` branch)

🖥 Local dev: http://localhost:5177 · local preview: `npm run build && npm run preview`

**Deploy:** `GH_PAGES=true npm run build`, then push `dist/` to the `gh-pages` branch
(temp-dir method; Pages source = `gh-pages` root).

## Quick start

```bash
npm install
npm run dev        # http://localhost:5177
```

## Stack

- **React 19 + TypeScript + Vite + SCSS**
- **Leaflet** (OpenStreetMap tiles, `referrerPolicy: 'origin'`)
- **FAA + NPS ArcGIS FeatureServer REST** for all aviation/land data (no key required)
- **Nominatim** for search geocoding

## Notes

- Layers load once you're zoomed to **zoom 8+**, for the padded visible viewport, so the data
  always matches what's on screen.
- Breakpoints: ≥901px floating desktop card · 701–900px tablet sheet (capped at 620px) ·
  ≤700px phone sheet · short landscape (≤520px tall) keeps the sheet at 62dvh so a usable strip
  of map survives.
- **Control radius** circles come from the field's type (international → 5 nm, regional → 4 nm,
  towered/ICAO → 2.5 nm, small field → 1.5 nm, heliport/uncontrolled → none). They are planning
  approximations, labelled as such — the **Class airspace** layer is the authoritative source.
- DEV-only introspection hooks (`window.__map`, `window.__analyzePoint`, `window.__fetchAirports`,
  `window.__fetchNoFlyZones`, `window.__fetchControlledAirspace`) exist for automated testing and
  are tree-shaken from production builds.

## Caveats

- The Facility Map ceiling and airspace limits are shown for **planning**. They are not a grant of
  authority — you still need a LAANC request or a DroneZone airspace authorization.
- NPS prohibition covers launching, landing and operating from NPS land and water (36 CFR 1.5,
  NPS Policy Memorandum 14-05). Overflight is not itself prohibited, but avoid it where asked.
- **Always verify with the official FAA tools (B4UFLY, FAADroneZone / LAANC) before flight.**

## Deployment

Vite static build (no server needed). Deploy the `dist/` output to any static host (GitHub
Pages, Netlify, etc.).
