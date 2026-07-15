import type { Feature } from "geojson";
import type { PavingFeatureProps } from "./types";
import boundary from "../data/allegheny-boundary.json";

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

/**
 * Allegheny County boundary, used to keep events inside the county's actual
 * (irregular) border rather than a loose rectangle — a rectangle big enough to
 * cover the county also catches closures just over the line in Washington,
 * Westmoreland, Butler, and Beaver counties. `BBOX` is the polygon's bounding
 * box, kept as a cheap first-pass reject; `inCounty` is the precise gate.
 * `PENNDOT_EVENTS_BBOX` still overrides the box (e.g. to widen coverage), but it
 * does not loosen the polygon test.
 */
const BBOX = process.env.PENNDOT_EVENTS_BBOX
  ? process.env.PENNDOT_EVENTS_BBOX.split(",").map(Number)
  : (boundary.bbox as number[]);

/** County boundary ring as [lng, lat] pairs (see data/allegheny-boundary.json). */
const COUNTY_RING = boundary.ring as [number, number][];

/** Cap tooltip fan-out, and how many to fetch at once. */
const MAX_ITEMS = 120;
const CONCURRENCY = 8;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * liveEvents carries every active incident statewide (crashes, disabled
 * vehicles, debris, downed trees, …). For a paving/closures map we keep only the
 * work- and bridge-closure event types — the equivalent of the old 511 scrape's
 * ActiveRoadwork/ClosedBridges layers. plannedEvents are kept regardless of type
 * (they're all scheduled closures). Values are from the RCRS EventType code
 * table; compared lower-cased.
 */
const LIVE_WORK_TYPES = new Set([
  "roadwork",
  "moving roadwork",
  "utility work",
  "damaged roadway",
  "bridge outage",
]);

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
 * Official PennDOT RCRS Event Data API (liveEvents / plannedEvents) — the clean,
 * structured path and the only source with reliable *planned* future closures
 * (a bridge announced to close before it's active). Needs a provisioned
 * data-feed credential:
 *   RCRS_EVENTS_URL    base url of the RCRS_Event_Data service (no trailing /)
 *   RCRS_USERNAME / RCRS_PASSWORD    HTTP Basic Auth
 *   RCRS_EVENTS_METHODS   optional CSV (default "liveEvents,plannedEvents")
 *
 * The normalizer (normalizeRcrsEvent) maps the documented RCRS_Event_Data
 * properties (https://www.pa.gov/.../developer-resources-documentation-api),
 * verified against the live `Values` payload. `pick` matches keys
 * case-insensitively because the live feed lower-cases the leading letter
 * (e.g. `facility`) vs. the docs (`Facility`). Until the url/creds exist, and on
 * any hard request failure, we fall back to the open 511PA path so the layer
 * still renders.
 */
async function fetchFromRcrs(): Promise<Feature[]> {
  const base = process.env.RCRS_EVENTS_URL;
  const user = process.env.RCRS_USERNAME;
  const pass = process.env.RCRS_PASSWORD;
  if (!base || !user || !pass) {
    console.warn(
      "PennDOT events: RCRS not fully configured (need RCRS_EVENTS_URL/USERNAME/PASSWORD); using open 511PA."
    );
    return fetchFrom511();
  }

  const methods = (process.env.RCRS_EVENTS_METHODS || "liveEvents,plannedEvents")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

  try {
    const batches = await Promise.all(methods.map((m) => fetchRcrsMethod(base, m, auth)));
    return batches.flat();
  } catch (err) {
    console.warn("PennDOT events: RCRS request failed, using open 511PA:", (err as Error).message);
    return fetchFrom511();
  }
}

async function fetchRcrsMethod(base: string, method: string, auth: string): Promise<Feature[]> {
  const res = await fetch(`${base.replace(/\/$/, "")}/${method}`, {
    headers: { Authorization: auth, Accept: "application/json", "User-Agent": "pgh-paving-map/1.0" },
    next: { revalidate: 3600 },
  } as RequestInit);
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const json: any = await res.json();
  const records: any[] = Array.isArray(json)
    ? json
    : json?.Values ?? json?.values ?? json?.events ?? json?.Events ?? json?.data ?? json?.result ?? [];

  const planned = /planned/i.test(method);
  const out: Feature[] = [];
  for (const r of records) {
    const f = normalizeRcrsEvent(r, planned);
    if (f) out.push(f);
  }
  // The feed is statewide; Allegheny is a small slice, so 0 kept out of many is
  // normal (they were filtered by county). Only warn on a genuine shape problem
  // — records present but none yields geometry — which would signal the feed's
  // field names drifted from what normalizeRcrsEvent expects.
  if (out.length === 0 && records.length > 0 && !records.some((r) => rcrsGeometry(r))) {
    console.warn(
      `PennDOT events: ${method} returned ${records.length} record(s) but none had usable ` +
        `geometry; first record keys: ${Object.keys(records[0] ?? {}).join(", ")}`
    );
  }
  return out;
}

/**
 * Map one RCRS event to a GeoJSON feature, restricted to Allegheny County.
 * Field names are the documented RCRS_Event_Data properties (matched
 * case-insensitively via `pick`, since the live feed lower-cases the initial
 * letter vs. the docs). Returns null if it has no usable geometry or falls
 * outside the county.
 */
function normalizeRcrsEvent(r: any, planned: boolean): Feature | null {
  if (!r || typeof r !== "object") return null;

  const geometry = rcrsGeometry(r);
  if (!geometry) return null;

  // Keep to Allegheny. RCRS sends a numeric `County` code ("02") *and* a
  // `CountyName` string ("ALLEGHENY"); gate on the name. Fall back to the
  // point-in-polygon test only if no name is present.
  const county = String(
    pick(r, ["countyName", "countyFromName", "countyToName", "countyIncName"]) ?? ""
  ).trim();
  const rep = geometry.type === "Point" ? geometry.coordinates : geometry.coordinates[0];
  const [lng, lat] = rep as number[];
  if (county) {
    if (county.toUpperCase() !== "ALLEGHENY") return null;
  } else if (!inCounty(lat, lng)) {
    return null;
  }

  // Closure span. For planned events the real range lives in
  // EventRepetitionDetails (StartDate..EndDate, "N/A" when one-time); one-time
  // and live events fall back to DateTimeEventOccurs (scheduled/actual begin).
  // A one-time event has no explicit end, so endDate is left open — inWindow
  // then keeps it visible for any window at/after its start.
  const reps = (r.EventRepetitionDetails ?? r.eventRepetitionDetails ?? null) as any;
  const occurs = naOr(pick(reps, ["occurs"]));
  const start =
    toISO(naOr(pick(reps, ["startDate"]))) ||
    toISO(pick(r, ["dateTimeEventOccurs", "createTime"]));
  const end = toISO(naOr(pick(reps, ["endDate"]))) || undefined;

  const route = String(pick(r, ["facility"]) ?? "").trim();
  const fromLoc = String(pick(r, ["fromLoc"]) ?? "").trim();
  const toLoc = String(pick(r, ["toLoc"]) ?? "").trim();
  const street = route || fromLoc || "Road event";

  const type = String(pick(r, ["eventType"]) ?? "").trim();
  // Live events: keep only roadwork/bridge-closure types (see LIVE_WORK_TYPES),
  // the equivalent of the old 511 ActiveRoadwork/ClosedBridges layers. Planned
  // events are all scheduled closures, so they pass through regardless of type.
  if (!planned && !LIVE_WORK_TYPES.has(type.toLowerCase())) return null;

  const description = String(pick(r, ["description"]) ?? "").trim();
  const laneStatus = String(pick(r, ["laneStatus"]) ?? "").trim();
  const affected = String(pick(r, ["affectedLanes"]) ?? "").trim();

  // RCRS's `description` is a complete sentence that already names the event
  // type, extent, and lane status (e.g. "Special event on PA 31 westbound
  // between … All lanes closed."), so when it's present we lean on it and only
  // add the planned/recurrence context. Without it, assemble from the parts.
  const bits: string[] = [];
  if (planned) bits.push("Planned");
  if (description) {
    bits.push(description);
  } else {
    if (type) bits.push(cap(type));
    if (fromLoc || toLoc) bits.push([fromLoc, toLoc].filter(Boolean).join(" to "));
    const laneBit = [laneStatus, affected].filter(Boolean).join(" — ");
    if (laneBit) bits.push(laneBit);
  }
  if (occurs && occurs.toLowerCase() !== "one time event") bits.push(`Recurs: ${occurs}`);
  const detail = bits.join(" · ") || (planned ? "Planned closure" : "Active closure");

  const weekday = start ? WEEKDAYS[new Date(start + "T00:00:00Z").getUTCDay()] ?? "" : "";

  const props: PavingFeatureProps = {
    category: "closures511",
    date: start || "",
    weekday,
    street,
    label: fromLoc && fromLoc !== street ? `${street} — ${fromLoc}` : street,
    approx: false,
    endDate: end,
    detail,
  };
  return { type: "Feature", geometry: geometry as any, properties: props };
}

/**
 * Geometry from the RCRS location fields. Each is a "lat,lng" *string*
 * (FromLocLatLong / ToLocLatLong / IncidentLocLatLong). A distinct from→to pair
 * makes a LineString; otherwise the incident/from point makes a Point.
 */
function rcrsGeometry(r: any): { type: "Point"; coordinates: number[] } | { type: "LineString"; coordinates: number[][] } | null {
  const from = latLong(pick(r, ["fromLocLatLong"]));
  const to = latLong(pick(r, ["toLocLatLong"]));
  const inc = latLong(pick(r, ["incidentLocLatLong"]));
  if (from && to && (from[0] !== to[0] || from[1] !== to[1])) {
    return { type: "LineString", coordinates: [from, to] };
  }
  const pt = inc || from || to;
  return pt ? { type: "Point", coordinates: pt } : null;
}

/** Parse an RCRS "lat,lng" string to a GeoJSON [lng, lat] pair, or null. */
function latLong(v: unknown): number[] | null {
  if (v == null) return null;
  const parts = String(v).split(",");
  if (parts.length < 2) return null;
  const lat = Number(parts[0].trim());
  const lng = Number(parts[1].trim());
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
}

/** RCRS uses the literal "N/A" for empty repetition fields; treat it as absent. */
function naOr(v: unknown): string {
  const s = v == null ? "" : String(v).trim();
  return !s || s.toUpperCase() === "N/A" ? "" : s;
}

/** Capitalize the first letter (event types arrive lower-cased). */
function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function inBBox(lat: number, lng: number): boolean {
  const [south, west, north, east] = BBOX;
  return lat >= south && lat <= north && lng >= west && lng <= east;
}

/**
 * True if the point falls within Allegheny County. Cheap bbox reject first, then
 * a ray-casting point-in-polygon test against the county boundary ring.
 */
function inCounty(lat: number, lng: number): boolean {
  if (!inBBox(lat, lng)) return false;
  let inside = false;
  for (let i = 0, j = COUNTY_RING.length - 1; i < COUNTY_RING.length; j = i++) {
    const [xi, yi] = COUNTY_RING[i];
    const [xj, yj] = COUNTY_RING[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** First non-empty value among `keys`, matched case-insensitively. */
function pick(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k] as const));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase());
    if (real != null) {
      const v = obj[real];
      if (v != null && v !== "") return v;
    }
  }
  return undefined;
}

/** Flexible date -> "YYYY-MM-DD": handles ISO, epoch ms/s, and "Mon dd yyyy, h:mm AM". */
function toISO(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return fromDate(new Date(v));
  const s = String(v).trim();
  if (!s) return "";
  if (/^\d{13}$/.test(s)) return fromDate(new Date(Number(s)));
  if (/^\d{10}$/.test(s)) return fromDate(new Date(Number(s) * 1000));
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return fromDate(new Date(s.replace(",", "")));
}

function fromDate(d: Date): string {
  if (isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

/** Pull each layer's markers and keep those inside the county boundary. */
async function collectMarkers(): Promise<Marker[]> {
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
      if (!inCounty(lat, lng)) continue;
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
