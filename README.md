# Solvio Solar Proposal App

Generate branded, professional solar proposals for Thai buildings from a Google address. The app sizes a rooftop solar system, prices it against approved MEA/PEA inverters, computes savings and payback, and produces a shareable proposal page with an AI-written pitch and an AI render of the panels on the building.

## What it does

1. **Address → building** — geocode a Google address or Maps link (MEA vs PEA utility detected automatically).
2. **Roof outline** — trace the roof on satellite imagery, with an AI-suggested outline you confirm or redraw. Floors can be counted from Street View.
3. **System design** — a deterministic engine packs 450 W panels (paired rows, 1.5 m walkways on flat roofs), orients them toward the best roof edge, and picks an approved inverter for the building's utility and phase.
4. **Economics** — production via NREL PVWatts, with panel degradation and tariff escalation; four optimization modes (max savings, cover daytime load, shortest payback, max roof).
5. **Proposal** — a shareable page with a Claude-written headline/summary, a satellite panel-layout overlay, an OpenAI render of panels on the building photo, a cash-flow chart, and full assumptions/disclaimers.

The calculation engine owns every number; the AI only writes the words and the visualization.

## Tech stack

- **Next.js 16** (App Router, TypeScript, Tailwind)
- **Google Maps Platform** — geocoding, satellite/static maps, Places photos, Street View
- **NREL PVWatts** — solar yield
- **OpenAI** — roof-outline suggestion, floor counting, panel-on-photo render
- **Anthropic Claude** — proposal narrative
- **Vitest** — engine unit tests

## Setup

```bash
npm install
# create .env.local with the keys below, then:
npm run dev
```

`.env.local`:

```
GOOGLE_MAPS_API_KEY=              # Geocoding, Static Maps, Street View, Places API (New)
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=  # same key, exposed to the browser map
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
NREL_API_KEY=DEMO_KEY             # free key: https://developer.nlr.gov/signup/
```

Enable these Google Cloud APIs for the key: Maps JavaScript, Geocoding, Maps Static, Street View Static, Places API (New).

## Tests

```bash
npx vitest run
```

## Notes

- Generated proposals are written to `data/` (git-ignored — they contain customer addresses and photos).
- Prices in `src/config/pricing.ts` are Thai retail as of the `PRICES_LAST_REVIEWED` date; review quarterly.
