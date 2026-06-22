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
 * Official PennDOT RCRS Event Data API (liveEvents / plannedEvents) — the clean,
 * structured path and the only source with reliable *planned* future closures
 * (a bridge announced to close before it's active). Needs a provisioned
 * data-feed credential:
 *   RCRS_EVENTS_URL    base url of the RCRS_Event_Data service (no trailing /)
 *   RCRS_USERNAME / RCRS_PASSWORD    HTTP Basic Auth
 *   RCRS_EVENTS_METHODS   optional CSV (default "liveEvents,plannedEvents")
 *
 * IMPORTANT: PennDOT does not publish the JSON field names, so the normalizer
 * below (normalizeRcrsEvent) is intentionally tolerant — it tries several key
 * spellings (case-insensitive) for each field. It MUST be verified against a
 * real response once credentials land; on a parse miss it logs the first
 * record's keys to make that a one-line adjustment. Until the url/creds exist,
 * and on any hard request failure, we fall back to the open 511PA path so the
 * layer still renders.
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
    : json?.events ?? json?.Events ?? json?.data ?? json?.result ?? [];

  const planned = /planned/i.test(method);
  const out: Feature[] = [];
  for (const r of records) {
    const f = normalizeRcrsEvent(r, planned);
    if (f) out.push(f);
  }
  if (out.length === 0 && records.length > 0) {
    console.warn(
      `PennDOT events: ${method} returned ${records.length} record(s) but none parsed/placed; ` +
        `first record keys: ${Object.keys(records[0] ?? {}).join(", ")}`
    );
  }
  return out;
}

/**
 * Map one RCRS event to a GeoJSON feature, restricted to Allegheny County.
 * Defensive about field names (see fetchFromRcrs note). Returns null if it has
 * no usable geometry or falls outside the county/bbox.
 */
function normalizeRcrsEvent(r: any, planned: boolean): Feature | null {
  if (!r || typeof r !== "object") return null;

  const geometry = rcrsGeometry(r);
  if (!geometry) return null;

  // Keep to Allegheny: trust an explicit county field; otherwise bbox-filter the
  // representative point (first coordinate).
  const county = String(pick(r, ["county", "countyName", "countyname"]) ?? "").trim();
  const rep = geometry.type === "Point" ? geometry.coordinates : geometry.coordinates[0];
  const [lng, lat] = rep as number[];
  if (county) {
    if (county.toUpperCase() !== "ALLEGHENY") return null;
  } else if (!inBBox(lat, lng)) {
    return null;
  }

  const start = toISO(pick(r, ["startDate", "startTime", "beginTime", "startDateTime", "start"]));
  const end = toISO(
    pick(r, ["endDate", "endTime", "anticipatedEndTime", "endDateTime", "estimatedEndTime", "end"])
  );
  const route = String(
    pick(r, ["roadwayName", "roadway", "route", "routeName", "facilityName"]) ?? ""
  ).trim();
  const location = String(pick(r, ["locationDescription", "location", "crossStreet"]) ?? "").trim();
  const street = route || location || "Road event";

  const type = String(pick(r, ["eventType", "type", "category"]) ?? "").trim();
  const description = String(pick(r, ["description", "eventDescription", "message"]) ?? "").trim();
  const direction = String(pick(r, ["direction", "directionOfTravel"]) ?? "").trim();
  const lanes = String(pick(r, ["laneDescription", "lanesAffected"]) ?? "").trim();

  const detailParts = [type, description, direction, lanes].map((s) => s.trim()).filter(Boolean);
  const detail = (planned ? "Planned — " : "") + (detailParts.join(" · ") || (planned ? "planned closure" : "active closure"));
  const weekday = start ? WEEKDAYS[new Date(start + "T00:00:00Z").getUTCDay()] ?? "" : "";

  const props: PavingFeatureProps = {
    category: "closures511",
    date: start || "",
    weekday,
    street,
    label: location && location !== street ? `${street} — ${location}` : street,
    approx: false,
    endDate: end || undefined,
    detail,
  };
  return { type: "Feature", geometry: geometry as any, properties: props };
}

/** Build geometry from whatever shape RCRS provides: a path, begin/end pair, or a point. */
function rcrsGeometry(r: any): { type: "Point"; coordinates: number[] } | { type: "LineString"; coordinates: number[][] } | null {
  const path = coordList(pick(r, ["geometry", "geom", "coordinates", "points", "path", "shape"]));
  if (path && path.length >= 2) return { type: "LineString", coordinates: path };

  const bLat = num(pick(r, ["beginLatitude", "startLatitude", "fromLatitude"]));
  const bLng = num(pick(r, ["beginLongitude", "startLongitude", "fromLongitude"]));
  const eLat = num(pick(r, ["endLatitude", "toLatitude"]));
  const eLng = num(pick(r, ["endLongitude", "toLongitude"]));
  if ([bLat, bLng, eLat, eLng].every(Number.isFinite)) {
    return { type: "LineString", coordinates: [[bLng, bLat], [eLng, eLat]] };
  }

  const lat = num(pick(r, ["latitude", "lat", "y"]));
  const lng = num(pick(r, ["longitude", "lng", "lon", "x"]));
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { type: "Point", coordinates: [lng, lat] };
  return null;
}

/**
 * Normalize a coordinate list to GeoJSON [lng, lat] pairs. Accepts arrays of
 * [lat, lng] or {lat, lng}. RCRS (like the other PennDOT/WPRDC feeds) is assumed
 * lat-first — verify when wiring against the live response.
 */
function coordList(raw: unknown): number[][] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[][] = [];
  for (const pt of raw) {
    let lat: number, lng: number;
    if (Array.isArray(pt) && pt.length >= 2) {
      lat = Number(pt[0]);
      lng = Number(pt[1]);
    } else if (pt && typeof pt === "object") {
      lat = num(pick(pt, ["lat", "latitude", "y"]));
      lng = num(pick(pt, ["lng", "lon", "longitude", "x"]));
    } else {
      continue;
    }
    if (Number.isFinite(lat) && Number.isFinite(lng)) out.push([lng, lat]);
  }
  return out.length ? out : null;
}

function inBBox(lat: number, lng: number): boolean {
  const [south, west, north, east] = BBOX;
  return lat >= south && lat <= north && lng >= west && lng <= east;
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

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
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
