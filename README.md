# Pittsburgh Paving Schedule Map

An unofficial, auto-updating map of the City of Pittsburgh's milling, paving, and
ADA curb-ramp schedule, plus active street-closure **construction** permits. It
reads the city's own published Google Sheet live, so the map reflects whatever
the city last published, and lets you filter by day and by work type (milling /
paving / ADA / construction).

The schedule covers only planned resurfacing. Most of the construction you see on
the street — utility cuts, road openings, contractor work — is permitted
separately by the Department of Mobility & Infrastructure (DOMI) and published as
the [DOMI Street Closures](https://data.wprdc.org/dataset/street-closures)
dataset on the Western Pennsylvania Regional Data Center (WPRDC). That feed
already carries geometry, so the "construction" layer is fetched live and drawn
directly (no geocoding). We show only the ~1.8k closures the city currently flags
`active`, out of ~69k all-time rows.

The city's sheet only shows a rolling "this week / past week" window and drops
older weeks. A scheduled ingest stamps every row with its real calendar date and
appends it to `data/archive.json`, so the map accumulates a full season of dated
history instead of resetting every Monday.

Built with Next.js + Tailwind + shadcn/ui + Google Maps, deployable to Vercel. No
database — history lives in a committed JSON file (see "Storing the history").

## How it works

```
City's published Google Sheet (5 tabs)        WPRDC DOMI Street Closures
        │  CSV export (no key)                         │  CKAN datastore SQL
        ▼                                              │  (no key); active rows
  lib/sheet.ts    parse the irregular per-day          │  only, geometry included
                  layout into clean records            ▼
        ▼                                       lib/closures.ts  swap [lat,lng]→
  lib/archive.ts  append each dated row to             │  [lng,lat]; build
                  data/archive.json (history the       │  GeoJSON directly —
                  rolling sheet drops); `npm run       │  NO geocoding step
                  ingest`, daily via Actions           │
        ▼                                              │
  lib/geocode.ts  resolve each street/limit to         │
                  geometry via City GIS centerline     │
        ▼                                              ▼
  /api/paving     GeoJSON for the map: archive ∪ live sheet ∪ live closures
  /api/geojson    GeoJSON overlay feed (filterable) for Google My Maps
  /api/kml        KML overlay feed (filterable) for Google My Maps
        ▼
  app/ + components/PavingMap.tsx   Google Map with day picker + 4 toggles
```

The construction layer is best-effort and additive: if the WPRDC feed is down,
`lib/closures.ts` logs and returns nothing, and the schedule map still renders.
It's only pulled by the API routes (`includeConstruction: true`); the
geocode/ingest scripts stay schedule-only, so it never touches the geocode cache
or archive.

The source sheet is the one embedded on
<https://www.pittsburghpa.gov/Resident-Services/Road-Maintenance/Paving-Schedule>.
It is a rolling window — "this week" and "past week" for milling and paving, plus
"this week" for ADA — so the map shows everything currently in the sheet and stays
current automatically. Its published id lives in `.env` as `PAVING_SHEET_PUB_ID`.

## Local setup

```bash
npm install
cp .env.example .env        # then add your Google Maps key (see below)
npm run dev                 # http://localhost:3000
```

### Google Maps key

The map canvas uses the Google Maps JavaScript API, which needs a billing-enabled
key:

1. In the [Google Cloud Console](https://console.cloud.google.com), create a
   project and enable **Maps JavaScript API**.
2. Create an API key under **APIs & Services → Credentials**.
3. Restrict it to your domains (`localhost`, `*.vercel.app`, your real domain).
4. Put it in `.env` as `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=...`

Geocoding does **not** use Google — it uses Pittsburgh's public GIS centerline,
and the construction layer ships its own geometry — so the only Google cost is
map loads.

## Shareable overlay (Google My Maps)

Two endpoints expose the same data as importable layers:

- `GET /api/geojson` — GeoJSON
- `GET /api/kml` — KML

Both accept filters: `?category=milling,paving,ada,construction` and
`?date=YYYY-MM-DD`. Examples:

```
/api/kml                              # everything
/api/kml?category=paving              # paving only
/api/kml?category=construction        # active street closures only
/api/geojson?category=ada&date=2026-06-23
```

To overlay in **Google My Maps**: create/open a map → **Add layer → Import** →
paste the deployed URL (e.g. `https://your-domain/api/kml`). Re-importing picks up
the city's latest changes. (Google My Maps imports a snapshot at import time; for a
continuously-live layer, embed this app instead.)

The app also has an **"Add to Google Maps"** button in the header that opens a
modal with copy-ready feed links (everything or construction-only) and these
steps, so users can drop the overlay onto Google's base map — with its live
Traffic layer — without leaving the page.

## Geocoding accuracy

The schedule is human-typed street names with cross-street limits and no
coordinates, so geometry is inferred. In practice:

- Distinctively-named streets resolve to the correct block.
- Streets that are misspelled in the sheet (e.g. `Spring Gargen`, `Vetern`,
  `Perrsville`) can't be matched and are reported via the map's "couldn't be
  placed" note and in `GET /api/paving` under `meta.unresolved`.
- Short/numbered cross streets (`12th St`) exist in many neighborhoods and can
  occasionally place a segment on the wrong block. These render at reduced
  opacity when flagged `approx`.

### Fixing or adding a segment by hand

`data/overrides.json` lets you pin geometry for any item without touching code.
Keys use the same signature the cache uses:

- milling/paving: `"<category>|<STREET>|<FROM>|<TO>"` (uppercased, suffixes
  abbreviated — see `signatureFor` / `normalizeStreet`)
- ADA: `"ada|<STREET>|<INTERSECTION1>,<INTERSECTION2>,..."`

```json
{
  "paving|DAISY WAY|SHERLOCK ST|VETERAN ST": {
    "type": "LineString",
    "coordinates": [[-79.95, 40.46], [-79.951, 40.461]],
    "approx": false
  }
}
```

Overrides always win over the geocoder. The exact key for any unresolved item is
easy to read off the `npm run geocode` output.

## Storing the history

The city's sheet is a rolling window, so anything older than "past week" is gone
once they roll it forward. To keep it, run the ingest:

```bash
npm run ingest       # pull the sheet → append new dated rows to data/archive.json
                     # → refresh data/geocode-cache.json for the whole archive
```

`data/archive.json` is the durable store: one record per item, keyed by
`category|date|street|limits`, with `firstSeen` / `lastSeen` timestamps. New rows
are appended and re-seen rows just bump `lastSeen`; nothing is ever removed. The
map (`/api/paving`) reads the archive unioned with the live sheet, so it shows the
full dated history while still picking up the current week immediately.

This runs automatically: **`.github/workflows/ingest.yml`** executes `npm run
ingest` daily and commits `data/archive.json` + `data/geocode-cache.json` when
they change (needs Actions write permission, which is on by default for the repo).
Trigger it by hand anytime from the Actions tab ("Run workflow"). Because history
lives in git, the commit log doubles as an audit trail of what the city scheduled
and when.

### Just the geocode cache

If you only want to refresh geometry without touching the archive:

```bash
npm run geocode      # re-resolves geometry for archive ∪ live sheet, rewrites the cache
```

The app also revalidates the upstream sheet hourly on its own.

## Disclaimer

Unofficial. Schedules change and are weather-dependent; always follow posted "No
Parking" signs. Data © City of Pittsburgh; paving/milling/ADA geometry derived
from the city's public GIS centerline, and construction closures from the WPRDC
DOMI Street Closures dataset.
