import {
  lineIntersect,
  lineString,
  point,
  nearestPointOnLine,
  lineSlice,
  length as turfLength,
  distance as turfDistance,
  featureCollection,
} from "@turf/turf";
import type { Feature, LineString } from "geojson";
import type { ResolvedGeometry } from "./types";

const CENTERLINE =
  "https://services1.arcgis.com/YZCmUqbcsUpOKfj7/arcgis/rest/services/PavementPublic/FeatureServer/0/query";

/** In-process cache of street name -> centerline LineString features. */
const streetCache = new Map<string, Feature<LineString>[]>();

// The GIS centerline stores abbreviated suffixes (ST, AVE, RD…). The sheet
// mixes spelled-out and abbreviated forms, so standardize to the abbreviations.
const SUFFIX_ABBR: Record<string, string> = {
  STREET: "ST",
  AVENUE: "AVE",
  ROAD: "RD",
  DRIVE: "DR",
  BOULEVARD: "BLVD",
  LANE: "LN",
  PLACE: "PL",
  COURT: "CT",
  TERRACE: "TER",
  SQUARE: "SQ",
  PARKWAY: "PKWY",
  HIGHWAY: "HWY",
  EXTENSION: "EXT",
};

/** Normalize a street name for matching against the GIS centerline. */
export function normalizeStreet(name: string): string {
  return name
    .toUpperCase()
    .replace(/\./g, "")
    .replace(/\bDEAD\s*END\b/g, "")
    .replace(/\(.*?\)/g, "") // drop parentheticals like "(DE)"
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => SUFFIX_ABBR[w] ?? w)
    .join(" ")
    .trim();
}

const SUFFIX = /\b(ST|STREET|AVE|AVENUE|RD|ROAD|WAY|DR|DRIVE|BLVD|LN|LANE|PL|PLACE|CT|COURT|TER|TERRACE|SQ|SQUARE|PKWY|HWY|EXT)\b/g;

/**
 * Fetch the centerline segments for a street, matching from most to least
 * specific so we don't pull in unrelated streets:
 *   1. exact name               (MERO WAY = MERO WAY)
 *   2. name as a prefix         (MERO WAY%)  — catches directional variants
 *   3. contains, only if long   (%CALIFORNIA AVE%)
 * The loose "contains the bare root" match is avoided because it grabs
 * unrelated streets (e.g. MERO -> CAMERON) and produced bad geometry.
 */
export async function fetchStreetGeom(name: string): Promise<Feature<LineString>[]> {
  const norm = normalizeStreet(name);
  if (!norm || /^DEAD END$/i.test(name.trim()) || /^BEHIND\b/i.test(name.trim())) return [];
  if (streetCache.has(norm)) return streetCache.get(norm)!;

  const esc = norm.replace(/'/g, "''");
  const clauses = [
    `UPPER(streetname) = '${esc}'`,
    `UPPER(streetname) LIKE '${esc}%'`,
  ];
  // A no-suffix prefix match (e.g. "CALIFORNIA" -> "CALIFORNIA AVE") only when
  // the root is distinctive enough to be unlikely to collide.
  const root = norm.replace(SUFFIX, "").replace(/\s+/g, " ").trim();
  if (root.length >= 6 && root !== norm) clauses.push(`UPPER(streetname) LIKE '${root.replace(/'/g, "''")}%'`);

  let features: Feature<LineString>[] = [];
  for (const where of clauses) {
    features = await queryCenterline(where);
    if (features.length) break;
  }
  streetCache.set(norm, features);
  return features;
}

async function queryCenterline(where: string): Promise<Feature<LineString>[]> {
  const url =
    `${CENTERLINE}?where=${encodeURIComponent(where)}` +
    `&outFields=streetname&returnGeometry=true&outSR=4326&f=geojson&resultRecordCount=200`;
  const res = await fetch(url, { next: { revalidate: 86400 } } as RequestInit);
  if (!res.ok) return [];
  const json: any = await res.json();
  if (!json?.features) return [];
  return json.features.filter(
    (f: any) => f?.geometry?.type === "LineString" && f.geometry.coordinates?.length >= 2
  ) as Feature<LineString>[];
}

/**
 * All points where a street meets a cross street. A street name can match many
 * citywide segments and a cross street can repeat across neighborhoods, so this
 * returns every candidate and lets the caller disambiguate by proximity.
 */
async function intersectionCandidates(
  streetLines: Feature<LineString>[],
  crossName: string
): Promise<number[][]> {
  if (!crossName || /dead\s*end/i.test(crossName) || /^behind\b/i.test(crossName.trim())) return [];
  const crossLines = await fetchStreetGeom(crossName);
  if (!crossLines.length) return [];

  const hits = lineIntersect(featureCollection(streetLines), featureCollection(crossLines));
  if (hits.features.length) return hits.features.map((f) => f.geometry.coordinates);

  // No true crossing: take the single closest approach if the streets nearly meet.
  let best: { d: number; pt: number[] } | null = null;
  for (const s of streetLines) {
    for (const c of crossLines) {
      for (const coord of c.geometry.coordinates) {
        const np = nearestPointOnLine(s, point(coord));
        const d = np.properties.dist ?? Infinity;
        if (!best || d < best.d) best = { d, pt: np.geometry.coordinates };
      }
    }
  }
  return best && best.d < 0.04 ? [best.pt] : [];
}

/** Closest candidate to a reference point. */
function nearestTo(cands: number[][], ref: number[]): number[] {
  let best = cands[0];
  let bd = Infinity;
  for (const c of cands) {
    const d = turfDistance(point(c), point(ref));
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** Resolve a milling/paving segment (street between two cross-street limits). */
export async function resolveSegment(
  street: string,
  from?: string,
  to?: string
): Promise<ResolvedGeometry | null> {
  const streetLines = await fetchStreetGeom(street);
  if (!streetLines.length) return null;

  const A = from ? await intersectionCandidates(streetLines, from) : [];
  const B = to ? await intersectionCandidates(streetLines, to) : [];

  // Pick the from/to intersection pair that is the closest *plausible block*
  // apart (20m–1.5km). Both the street and the cross streets can match many
  // citywide segments, so this rejects coincidental near-zero matches between
  // unrelated neighborhoods and cross-city outliers alike.
  const MIN = 0.02;
  const MAX = 1.5;
  let pair: { a: number[]; b: number[]; d: number } | null = null;
  for (const a of A) {
    for (const b of B) {
      const d = turfDistance(point(a), point(b));
      if (d < MIN || d > MAX) continue;
      if (!pair || d < pair.d) pair = { a, b, d };
    }
  }

  if (pair) {
    const host = pickHostLine(streetLines, pair.a, pair.b);
    if (host) {
      try {
        const sliced = lineSlice(point(pair.a), point(pair.b), host);
        if (sliced.geometry.coordinates.length >= 2)
          return { type: "LineString", coordinates: sliced.geometry.coordinates, approx: false };
      } catch {
        /* fall through to straight line */
      }
    }
    return { type: "LineString", coordinates: [pair.a, pair.b], approx: false };
  }

  const a = A[0] ?? null;
  const b = B[0] ?? null;

  // Fallback: show the street segment nearest a resolved limit (if any),
  // otherwise the longest matched segment, flagged approximate.
  const anchor = a ?? b;
  let chosen: Feature<LineString> | undefined;
  if (anchor) {
    chosen = streetLines
      .map((f) => ({ f, d: nearestPointOnLine(f, point(anchor)).properties.dist ?? Infinity }))
      .sort((x, y) => x.d - y.d)[0]?.f;
  } else {
    chosen = streetLines.map((f) => ({ f, len: turfLength(f) })).sort((x, y) => y.len - x.len)[0]?.f;
  }
  if (chosen)
    return { type: "LineString", coordinates: chosen.geometry.coordinates, approx: true };
  return null;
}

/** Resolve a set of ADA intersections to points along a street. */
export async function resolveIntersections(
  street: string,
  intersections: string[]
): Promise<ResolvedGeometry | null> {
  const streetLines = await fetchStreetGeom(street);
  if (!streetLines.length) return null;
  // Resolve candidates per intersection, then cluster: seed with the single
  // best-determined intersection and pick each remaining one nearest the
  // running centroid, so repeated street names don't scatter the markers.
  const candLists: number[][][] = [];
  for (const x of intersections) {
    const cands = await intersectionCandidates(streetLines, x);
    if (cands.length) candLists.push(cands);
  }
  if (candLists.length) {
    candLists.sort((a, b) => a.length - b.length); // most certain first
    const pts: number[][] = [];
    const seen = new Set<string>();
    let centroid: number[] | null = null;
    for (const cands of candLists) {
      const p = centroid ? nearestTo(cands, centroid) : cands[0];
      const key = `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pts.push(p);
      centroid = [
        pts.reduce((s, q) => s + q[0], 0) / pts.length,
        pts.reduce((s, q) => s + q[1], 0) / pts.length,
      ];
    }
    if (pts.length) return { type: "MultiPoint", coordinates: pts, approx: false };
  }

  // No intersections resolved: drop a single approximate point at the street midpoint.
  const host = streetLines[0];
  const mid = host.geometry.coordinates[Math.floor(host.geometry.coordinates.length / 2)];
  return mid ? { type: "Point", coordinates: mid, approx: true } : null;
}

/** Choose the street line that best contains both endpoints. */
function pickHostLine(
  lines: Feature<LineString>[],
  a: number[],
  b: number[]
): Feature<LineString> | null {
  let best: { score: number; line: Feature<LineString> } | null = null;
  for (const line of lines) {
    const da = nearestPointOnLine(line, point(a)).properties.dist ?? Infinity;
    const db = nearestPointOnLine(line, point(b)).properties.dist ?? Infinity;
    const score = da + db;
    if (!best || score < best.score) best = { score, line };
  }
  // Require both endpoints to be close to the same line (~60m each).
  return best && best.score < 0.12 ? best.line : null;
}

export { lineString };
