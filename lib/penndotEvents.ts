import type { Feature } from "geojson";
import type { PavingFeatureProps } from "./types";

/**
 * Live "511PA closures" layer: PennDOT RCRS road events — active roadwork,
 * closed bridges, and route closures — in/around Allegheny County, from the
 * public 511PA site.
 *
 * This is the complement to the capital-projects layer (lib/paprojects.ts):
 * those records say a project *exists* but carry no closure dates, while these
 * carry the real start/end dates and lane detail — the "when".
 *
 * The access path is env-selectable so it can later swap to PennDOT's official
 * RCRS Event Data API (liveEvents/plannedEvents) once a free data-feed
 * credential is provisioned:
 *   PENNDOT_EVENTS_SOURCE=511  (default) — open, no key; implemented here.
 *   PENNDOT_EVENTS_SOURCE=rcrs            — official JSON API (needs creds).
 *
 * On the open 511PA path, geometry and dates live in two places: the map
 * endpoint (`/map/mapIcons/{layer}`) gives marker coordinates + an item id,
 * and a per-item tooltip (`/tooltip/{layer}/{id}`) gives the dates and
 * description. We join them, restricting to an Allegheny bounding box since the
 * map endpoint has no county field. Best-effort: never throws — on any problem
 * it logs and returns [] (or skips the item) so the rest of the map renders.
 *
 * Source: https://www.511pa.com/
 */

const BASE = process.env.PENNDOT_511_URL || "https://www.511pa.com";

/** Map layers to pull. Each contributes point markers we enrich via tooltip. */
const LAYERS = ["ActiveRoadwork", "ClosedBridges", "Closures"];

/** Human label + headline prefix to strip, per layer. */
const LAYER_META: Record<string, { label: string; prefix: string }> = {
  ActiveRoadwork: { label: "Active roadwork", prefix: "Active Roadwork" },
  ClosedBridges: { label: "Closed bridge", prefix: "Closed Bridge" },
  Closures: { label: "Closure", prefix: "Closure" },
};

/** Allegheny County bounding box "south,west,north,east"; overridable. */
const BBOX = (process.env.PENNDOT_EVENTS_BBOX || "40.18,-80.36,40.68,-79.69")
  .split(",")
  .map(Number);

/** Cap tooltip fan-out, and how many to fetch at once. */
const MAX_ITEMS = 120;
const CONCURRENCY = 8;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Marker {
  layer: string;
  itemId: string;
  location: [number, number]; // [lat, lng]
}

/** Entry point: dispatches to the configured source. */
export async function fetchPennDotEvents(): Promise<Feature[]> {
  const source = (process.env.PENNDOT_EVENTS_SOURCE || "511").toLowerCase();
  return source === "rcrs" ? fetchFromRcrs() : fetchFrom511();
}

/**
 * Official PennDOT RCRS Event Data API (liveEvents/plannedEvents) — the clean,
 * structured path and the only one with reliable *planned* future closures.
 * It needs a provisioned data-feed credential (RCRS_EVENTS_URL / RCRS_USERNAME
 * / RCRS_PASSWORD). Until those exist we fall back to the open 511PA path so
 * the layer still works; wiring the real request is a follow-up.
 */
async function fetchFromRcrs(): Promise<Feature[]> {
  if (!process.env.RCRS_USERNAME || !process.env.RCRS_PASSWORD) {
    console.warn("PennDOT events: RCRS source selected but no creds set; using open 511PA.");
  } else {
    console.warn("PennDOT events: RCRS source not yet implemented; using open 511PA.");
  }
  return fetchFrom511();
}

async function fetchFrom511(): Promise<Feature[]> {
  const markers = await collectMarkers();
  const features: Feature[] = [];
  // Bounded concurrency so ~40 tooltip fetches don't all fire at once.
  for (let i = 0; i < markers.length; i += CONCURRENCY) {
    const batch = await Promise.all(markers.slice(i, i + CONCURRENCY).map(toFeature));
    for (const f of batch) if (f) features.push(f);
  }
  return features;
}

/** Pull each layer's markers and keep those inside the configured bbox. */
async function collectMarkers(): Promise<Marker[]> {
  const [south, west, north, east] = BBOX;
  const out: Marker[] = [];
  for (const layer of LAYERS) {
    let json: any;
    try {
      const res = await fetch(`${BASE}/map/mapIcons/${layer}`, {
        headers: { "User-Agent": "pgh-paving-map/1.0" },
        next: { revalidate: 3600 },
      } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } catch (err) {
      console.warn(`PennDOT events: ${layer} markers failed:`, (err as Error).message);
      continue;
    }
    for (const it of json?.item2 ?? []) {
      const loc = it?.location;
      if (!Array.isArray(loc) || loc.length < 2) continue;
      const lat = Number(loc[0]);
      const lng = Number(loc[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (lat < south || lat > north || lng < west || lng > east) continue;
      out.push({ layer, itemId: String(it.itemId), location: [lat, lng] });
      if (out.length >= MAX_ITEMS) return out;
    }
  }
  return out;
}

/** Fetch + parse one marker's tooltip into a GeoJSON Point feature. */
async function toFeature(m: Marker): Promise<Feature | null> {
  let html: string;
  try {
    const res = await fetch(`${BASE}/tooltip/${m.layer}/${m.itemId}?noCss=true`, {
      headers: { "User-Agent": "pgh-paving-map/1.0" },
      next: { revalidate: 3600 },
    } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.warn(`PennDOT events: tooltip ${m.layer}/${m.itemId} failed:`, (err as Error).message);
    return null;
  }
  const [lat, lng] = m.location;
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: parseTooltip(m.layer, stripHtml(html)),
  };
}

/**
 * Tooltips are flat, label-delimited text, e.g.:
 *   "Active Roadwork Road work on PA 576 West. The left lane is closed.
 *    Location EXIT 16 - Westport Road  Start Time Apr 27 2026, 7:00 AM
 *    Anticipated End Time Aug 28 2026, 6:00 PM  ... Last Updated ..."
 * or for a bridge (no dates):
 *   "Closed Bridge COUNTRY CLUB RD OVER SR19 Location ... Status Closed"
 */
function parseTooltip(layer: string, text: string): PavingFeatureProps {
  const meta = LAYER_META[layer] ?? { label: "Closure", prefix: "" };

  let head = before(text, "Location").trim();
  if (meta.prefix && head.toLowerCase().startsWith(meta.prefix.toLowerCase())) {
    head = head.slice(meta.prefix.length).trim();
  }
  const location = between(text, "Location", [
    "Intersects",
    "Start Time",
    "Status",
    "Recurrence",
    "Last Updated",
  ]);
  const startISO = parseDate(
    between(text, "Start Time", ["Anticipated End Time", "End Time", "Recurrence", "Last Updated"])
  );
  const endISO = parseDate(
    between(text, "Anticipated End Time", ["Recurrence", "Last Updated"]) ||
      between(text, "End Time", ["Recurrence", "Last Updated"])
  );

  // Split the headline into a short title + the rest of the description.
  const dot = head.indexOf(". ");
  const street = (dot > 0 ? head.slice(0, dot) : head).trim() || meta.label;
  const rest = dot > 0 ? head.slice(dot + 1).trim() : "";

  const detailParts: string[] = [meta.label];
  if (rest) detailParts.push(rest);
  if (location) detailParts.push(location);

  const weekday = startISO ? WEEKDAYS[new Date(startISO + "T00:00:00Z").getUTCDay()] ?? "" : "";

  return {
    category: "closures511",
    date: startISO || "",
    weekday,
    street,
    label: location ? `${street} — ${location}` : street,
    approx: false,
    endDate: endISO || undefined,
    detail: detailParts.join(" · "),
  };
}

/** Everything before the first occurrence of `marker` (or the whole string). */
function before(text: string, marker: string): string {
  const i = text.indexOf(marker);
  return i < 0 ? text : text.slice(0, i);
}

/** Text after `start`, up to whichever of `ends` comes first. */
function between(text: string, start: string, ends: string[]): string {
  const i = text.indexOf(start);
  if (i < 0) return "";
  const rest = text.slice(i + start.length);
  let cut = rest.length;
  for (const e of ends) {
    const j = rest.indexOf(e);
    if (j >= 0 && j < cut) cut = j;
  }
  return rest.slice(0, cut).trim();
}

/** "Apr 27 2026, 7:00 AM" -> "2026-04-27"; "" if absent/unparseable. */
function parseDate(s: string): string {
  const t = s.trim();
  if (!t) return "";
  const d = new Date(t.replace(",", ""));
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Strip tags, decode the few entities the tooltips use, collapse whitespace. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
