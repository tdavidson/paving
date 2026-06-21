import type { Feature } from "geojson";
import type { PavingFeatureProps } from "./types";

/**
 * Live "PennDOT projects" layer: PennDOT capital road & bridge construction
 * projects in Allegheny County, from the public "PA Projects" ArcGIS service.
 *
 * Like the DOMI closures feed (lib/closures.ts), and unlike the paving/milling
 * schedule we have to geocode, this already ships geometry, so it bypasses
 * lib/geocode.ts entirely. It's the county-wide complement to the City of
 * Pittsburgh layers: the city's sheet and the DOMI permits stop at the city
 * line, while these are projects on state-maintained roads across the whole
 * county. We pull only "Under Construction" projects — work actively being
 * built right now (let, not yet complete).
 *
 * Source: https://gis.penndot.gov/paprojects/construction-map
 * API:    ArcGIS REST query endpoint (no key required).
 */

const SERVICE =
  process.env.PENNDOT_PROJECTS_URL ||
  "https://gis.penndot.gov/arcgis/rest/services/paprojects/paprojects/MapServer";

/** Layer 20 = "Under Construction Lines" (points in layer 5 are the same set). */
const LAYER = 20;

/** The service is statewide; restrict it to one county. */
const COUNTY = process.env.PENNDOT_PROJECTS_COUNTY || "ALLEGHENY";

/** Service maxRecordCount is 2000; Allegheny sits around ~400, so one page covers it. */
const MAX_ROWS = 2000;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const OUT_FIELDS = [
  "PROJECT_TITLE",
  "ST_RT_NO",
  "IMPROVEMENT_CODE_DESC",
  "PROJECT_IMPROVEMENT_DESC",
  "PROJ_STATUS_DESC",
  "LET_DATE",
  "COMPLETION_DATE",
  "CRNT_CNTRCT_AM",
  "PROJECT_MANAGER_CONTACT_NAME",
  "COUNTY_NAME",
].join(",");

interface EsriFeature {
  attributes: Record<string, any>;
  geometry?: { paths?: number[][][] };
}

/**
 * Fetch Allegheny County's under-construction PennDOT projects as GeoJSON
 * LineString features. Never throws: on any network/API problem it logs and
 * returns [] so the rest of the map still renders.
 */
export async function fetchProjectFeatures(): Promise<Feature[]> {
  const params = new URLSearchParams({
    where: `COUNTY_NAME='${COUNTY}'`,
    outFields: OUT_FIELDS,
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: String(MAX_ROWS),
    f: "json",
  });
  const url = `${SERVICE}/${LAYER}/query?${params.toString()}`;

  let json: any;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "pgh-paving-map/1.0" },
      // Projects move slowly; revalidate hourly like the other live layers.
      next: { revalidate: 3600 },
    } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch (err) {
    console.warn("PennDOT projects fetch failed:", (err as Error).message);
    return [];
  }

  // ArcGIS reports query failures in-band with HTTP 200 + an `error` object.
  if (json?.error) {
    console.warn("PennDOT projects API error:", json.error);
    return [];
  }

  const records: EsriFeature[] = json?.features ?? [];
  const features: Feature[] = [];
  for (const r of records) {
    const props = toProps(r.attributes);
    // An Esri polyline can carry several disjoint paths; emit one line each.
    for (const path of r.geometry?.paths ?? []) {
      const coordinates = cleanPath(path);
      if (!coordinates) continue;
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates },
        properties: props,
      });
    }
  }
  return features;
}

/**
 * Drop non-finite points; keep only a path usable as a 2+ point line. With
 * outSR=4326 the service already returns [lng, lat], so no swap is needed
 * (unlike the WPRDC feed in lib/closures.ts).
 */
function cleanPath(path: number[][]): number[][] | null {
  const out: number[][] = [];
  for (const pt of path) {
    const lng = Number(pt[0]);
    const lat = Number(pt[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat)) out.push([lng, lat]);
  }
  return out.length >= 2 ? out : null;
}

function toProps(a: Record<string, any>): PavingFeatureProps {
  const date = isoDate(a.LET_DATE);
  const endDate = isoDate(a.COMPLETION_DATE) || undefined;
  const weekday = date ? WEEKDAYS[new Date(date + "T00:00:00Z").getUTCDay()] ?? "" : "";
  const route = (a.ST_RT_NO || "").trim();
  const street = (a.PROJECT_TITLE || "").trim() || (route ? `SR ${route}` : "PennDOT project");

  return {
    category: "paprojects",
    date: date || endDate || "",
    weekday,
    street,
    label: route ? `${street} (SR ${route})` : street,
    approx: false,
    endDate,
    detail: buildDetail(a),
    // The PennDOT project manager, reusing the construction "contractor" slot.
    contractor: contactName(a.PROJECT_MANAGER_CONTACT_NAME),
  };
}

/** "Resurface · widening, mill and overlay… · $30,116,186 contract". */
function buildDetail(a: Record<string, any>): string {
  const parts: string[] = [];
  const type = (a.IMPROVEMENT_CODE_DESC || "").trim();
  if (type) parts.push(type);

  const desc = (a.PROJECT_IMPROVEMENT_DESC || "").trim();
  if (desc) parts.push(desc.length > 160 ? desc.slice(0, 157).trimEnd() + "…" : desc);

  const amount = Number(a.CRNT_CNTRCT_AM);
  if (Number.isFinite(amount) && amount > 0) {
    parts.push(`$${Math.round(amount).toLocaleString("en-US")} contract`);
  }
  return parts.join(" · ");
}

/** ISO date from the feed's "YYYYMMDD" strings; "" if absent/unparseable. */
function isoDate(s?: string): string {
  const t = (s || "").trim();
  return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : "";
}

/** "Poole, Derreck" -> "Derreck Poole"; passes through anything unexpected. */
function contactName(raw?: string): string | undefined {
  const s = (raw || "").trim();
  if (!s) return undefined;
  const comma = s.indexOf(",");
  if (comma === -1) return s;
  const last = s.slice(0, comma).trim();
  const first = s.slice(comma + 1).trim();
  return first ? `${first} ${last}` : last;
}
