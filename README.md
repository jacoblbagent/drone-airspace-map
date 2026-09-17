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
- **Map layers**, each toggled independently with live counts:
  - Airport & heliport markers (FAA ADHP)
  - **Real** controlled-airspace polygons — Class B/C/D and Class E surface (FAA Class Airspace),
    not a circular approximation
  - Parks & restricted areas — NPS boundaries plus prohibited/restricted/NSA airspace
- **Search** — geocode a city/park/airport via Nominatim and jump to it.
- **Refresh** — re-runs the airspace lookup for the pinned point.

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
  prohibited/restricted/national-security airspace, inside a national-security UAS restriction,
  or in a UAS Facility Map cell with a 0 ft ceiling (LAANC cannot authorize there).
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
