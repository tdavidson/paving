import type { Feature } from "geojson";
import type { PavingFeatureProps } from "./types";
import { workGroupForPermitType } from "./workTypes";

/**
 * Live "construction" layer: the City of Pittsburgh's DOMI street-closure
 * permits, published by the Western Pennsylvania Regional Data Center (WPRDC).
 *
 * Unlike the paving/milling/ADA schedule (a human-typed Google Sheet we have to
 * geocode), this feed already ships geometry, so it bypasses lib/geocode.ts
 * entirely. We pull only currently-active closures — the ~1.8k things actually
 * obstructing a street right now — out of the ~69k all-time rows.
 *
 * Source: https://data.wprdc.org/dataset/street-closures
 * API:    CKAN datastore SQL endpoint (no key required).
 */

const RESOURCE_ID =
  process.env.DOMI_CLOSURES_RESOURCE_ID || "a9a1d93a-9d3b-4c18-bd80-82ed6f86404a";

const SQL_URL = "https://data.wprdc.org/api/3/action/datastore_search_sql";

/** Safety cap; active closures sit around ~1.8k, so this is plenty of headroom. */
const MAX_ROWS = 6000;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface ClosureRow {
  closure_id?: string;
  permit_id?: string;
  permit_type?: string;
  work_description?: string;
  work_type?: string;
  contractor_name?: string;
  applicant_name?: string;
  special_instructions?: string;
  weekday_hours?: string;
  weekend_hours?: string;
  primary_street?: string;
  from_street?: string;
  to_street?: string;
  from_date?: string;
  to_date?: string;
  active?: boolean | string;
  full_closure?: boolean | string;
  travel_lane?: boolean | string;
  parking_lane?: boolean | string;
  metered_parking?: boolean | string;
  sidewalk?: boolean | string;
  segment_num?: number | string;
  total_segments?: number | string;
  geometry?: string;
}

/**
 * Fetch currently-active DOMI street closures as GeoJSON LineString features.
 * Never throws: on any network/API problem it logs and returns [] so the rest
 * of the map (the schedule) still renders.
 */
export async function fetchConstructionFeatures(): Promise<Feature[]> {
  const cols =
    "closure_id, permit_id, permit_type, work_description, work_type, " +
    "contractor_name, applicant_name, special_instructions, weekday_hours, " +
    "weekend_hours, primary_street, from_street, to_street, from_date, to_date, " +
    "active, full_closure, travel_lane, parking_lane, metered_parking, sidewalk, " +
    "segment_num, total_segments, geometry";
  const sql =
    `SELECT ${cols} FROM "${RESOURCE_ID}" ` +
    `WHERE active = true AND geometry IS NOT NULL LIMIT ${MAX_ROWS}`;
  const url = `${SQL_URL}?sql=${encodeURIComponent(sql)}`;

  let json: any;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "pgh-paving-map/1.0" },
      // Revalidate like the sheet (hourly) — closures update ~hourly upstream.
      next: { revalidate: 3600 },
    } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch (err) {
    console.warn("Construction (DOMI closures) fetch failed:", (err as Error).message);
    return [];
  }

  if (!json?.success) {
    console.warn("Construction (DOMI closures) API error:", json?.error);
    return [];
  }

  const records: ClosureRow[] = json.result?.records ?? [];
  const features: Feature[] = [];
  for (const r of records) {
    const coordinates = parseGeometry(r.geometry);
    if (!coordinates) continue;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties: toProps(r),
    });
  }
  return features;
}

/**
 * The feed stores geometry as a JSON string of [lat, lng] pairs. GeoJSON wants
 * [lng, lat], so we swap. Returns null for anything we can't read as a usable
 * (2+ point) line.
 */
function parseGeometry(raw: unknown): number[][] | null {
  if (typeof raw !== "string") return null;
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const out: number[][] = [];
  for (const pt of arr) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const lat = Number(pt[0]);
    const lng = Number(pt[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push([lng, lat]);
  }
  return out.length >= 2 ? out : null;
}

function toProps(r: ClosureRow): PavingFeatureProps {
  const date = isoDate(r.from_date);
  const endDate = isoDate(r.to_date) || undefined;
  const weekday = date ? WEEKDAYS[new Date(date + "T00:00:00Z").getUTCDay()] ?? "" : "";
  const street = (r.primary_street || "").trim() || "Street closure";
  const limits = [r.from_street, r.to_street]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(" to ");

  return {
    category: "construction",
    date: date || endDate || "",
    weekday,
    street,
    label: limits ? `${street} (${limits})` : street,
    approx: false,
    endDate,
    detail: buildDetail(r),
    active: bool(r.active),
    permitId: (r.permit_id || "").trim() || undefined,
    contractor: buildContractor(r),
    hours: buildHours(r),
    segment: buildSegment(r),
    notes: buildNotes(r),
    workGroup: workGroupForPermitType(r.permit_type),
  };
}

/** "People's Gas", falling back to the applicant when no contractor is listed. */
function buildContractor(r: ClosureRow): string | undefined {
  const contractor = (r.contractor_name || "").trim();
  if (contractor) return titleCase(contractor);
  const applicant = (r.applicant_name || "").trim();
  return applicant ? titleCase(applicant) : undefined;
}

/** Combine the separate weekday/weekend hour fields into one popup line. */
function buildHours(r: ClosureRow): string | undefined {
  const weekday = (r.weekday_hours || "").trim();
  const weekend = (r.weekend_hours || "").trim();
  if (weekday && weekend) {
    return weekday === weekend
      ? weekday
      : `${weekday} (weekdays), ${weekend} (weekends)`;
  }
  if (weekday) return weekday;
  if (weekend) return `${weekend} (weekends)`;
  return undefined;
}

/** "1 of 3" for a multi-segment permit; nothing for single-segment closures. */
function buildSegment(r: ClosureRow): string | undefined {
  const num = Number(r.segment_num);
  const total = Number(r.total_segments);
  if (!Number.isFinite(num) || !Number.isFinite(total) || total <= 1) return undefined;
  return `${num} of ${total}`;
}

/** Trimmed special-instructions text for the popup, if present. */
function buildNotes(r: ClosureRow): string | undefined {
  const notes = (r.special_instructions || "").trim();
  return notes ? sentenceCase(notes) : undefined;
}

/** Human-readable popup blurb: work type · closure scope · work description. */
function buildDetail(r: ClosureRow): string {
  const parts: string[] = [];
  // Prefer the structured `work_type` ("Utility opening") over `permit_type`
  // ("General permit"), which is rarely informative; fall back to it.
  const type = (r.work_type || r.permit_type || "").trim();
  if (type) parts.push(titleCase(type));

  const scope: string[] = [];
  if (bool(r.full_closure)) scope.push("full closure");
  else {
    if (bool(r.travel_lane)) scope.push("travel lane");
    if (bool(r.parking_lane)) scope.push("parking lane");
    if (bool(r.metered_parking)) scope.push("metered parking");
    if (bool(r.sidewalk)) scope.push("sidewalk");
  }
  if (scope.length) parts.push(scope.join(" + "));

  const desc = (r.work_description || "").trim();
  if (desc) parts.push(sentenceCase(desc));

  return parts.join(" · ");
}

/** The canonical work-type label for a row, used for filtering/grouping. */
export function workTypeLabel(r: ClosureRow): string {
  const type = (r.work_type || r.permit_type || "").trim();
  return type ? titleCase(type) : "Other";
}

function isoDate(s?: string): string {
  return (s || "").slice(0, 10);
}

function bool(v: unknown): boolean {
  return v === true || v === "true" || v === "t";
}

/** "UTILITY OPENING" -> "Utility Opening". Source text is all-caps. */
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** First letter up, rest lower, trimmed to a reasonable popup length. */
function sentenceCase(s: string): string {
  const trimmed = s.length > 160 ? s.slice(0, 157).trimEnd() + "…" : s;
  const lower = trimmed.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
