import fs from "node:fs";
import path from "node:path";
import type { Feature, FeatureCollection } from "geojson";
import { fetchSchedule } from "./sheet";
import { resolveSegment, resolveIntersections, normalizeStreet } from "./geocode";
import { idFor, loadArchiveItems } from "./archive";
import type { Category, GeocodeCache, PavingFeatureProps, ScheduleItem } from "./types";

const CACHE_PATH = path.join(process.cwd(), "data", "geocode-cache.json");
const OVERRIDES_PATH = path.join(process.cwd(), "data", "overrides.json");

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface BuildResult {
  collection: FeatureCollection;
  unresolved: ScheduleItem[];
}

/** Signature used to cache a resolved geometry across runs. */
export function signatureFor(item: ScheduleItem): string {
  const s = normalizeStreet(item.street);
  if (item.category === "ada")
    return `ada|${s}|${(item.intersections || []).map(normalizeStreet).join(",")}`;
  return `${item.category}|${s}|${normalizeStreet(item.from || "")}|${normalizeStreet(item.to || "")}`;
}

function loadCache(): GeocodeCache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Hand-maintained corrections, keyed by the same signature as the cache (see
 * signatureFor). Use this to fix a mislocated segment or place one the
 * geocoder couldn't (e.g. misspelled streets). Overrides always win.
 * Example value: { "type": "LineString", "coordinates": [[lng,lat],[lng,lat]], "approx": false }
 */
function loadOverrides(): GeocodeCache {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"));
  } catch {
    return {};
  }
}

/**
 * The map's source of truth: every dated row we've ever archived, unioned with
 * whatever is in the live sheet right now. The archive carries history the
 * rolling sheet has dropped; the live fetch keeps the current week fresh even
 * before the next scheduled ingest has committed it. Deduped by stable id.
 */
export async function loadAllItems(): Promise<ScheduleItem[]> {
  const live = await fetchSchedule();
  const archived = loadArchiveItems();
  const byId = new Map<string, ScheduleItem>();
  for (const it of archived) byId.set(idFor(it), it);
  for (const it of live) byId.set(idFor(it), it); // live wins on conflict
  return [...byId.values()];
}

/**
 * Build a GeoJSON FeatureCollection from the archive + live sheet.
 * @param items override the source items (defaults to archive ∪ live sheet).
 * @param allowLive when true, resolve geometry from the GIS service for cache
 *   misses (used by the prebuild/ingest scripts). At runtime we default to
 *   cache-only plus a bounded number of live lookups so requests stay fast.
 */
export async function buildCollection(
  opts: { allowLive?: boolean; cache?: GeocodeCache; maxLive?: number; items?: ScheduleItem[] } = {}
): Promise<BuildResult & { cache: GeocodeCache }> {
  const cache: GeocodeCache = opts.cache ?? loadCache();
  const overrides = loadOverrides();
  const allowLive = opts.allowLive ?? false;
  let liveBudget = opts.maxLive ?? (allowLive ? Infinity : 25);

  const items = opts.items ?? (await loadAllItems());
  const features: Feature[] = [];
  const unresolved: ScheduleItem[] = [];

  for (const item of items) {
    const sig = signatureFor(item);
    let geom = overrides[sig] ?? cache[sig];

    if (geom === undefined && (allowLive || liveBudget > 0)) {
      if (!allowLive) liveBudget--;
      const resolved =
        item.category === "ada"
          ? await resolveIntersections(item.street, item.intersections || [])
          : await resolveSegment(item.street, item.from, item.to);
      geom = resolved
        ? { type: resolved.type, coordinates: resolved.coordinates, approx: resolved.approx }
        : null;
      cache[sig] = geom;
    }

    if (!geom) {
      unresolved.push(item);
      continue;
    }

    const props = featureProps(item, geom.approx);
    if (geom.type === "MultiPoint") {
      for (const c of geom.coordinates as number[][]) {
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: props });
      }
    } else {
      features.push({
        type: "Feature",
        geometry: { type: geom.type, coordinates: geom.coordinates } as any,
        properties: props,
      });
    }
  }

  return { collection: { type: "FeatureCollection", features }, unresolved, cache };
}

function featureProps(item: ScheduleItem, approx: boolean): PavingFeatureProps {
  const d = new Date(item.date + "T00:00:00");
  const weekday = WEEKDAYS[d.getUTCDay()];
  const limits =
    item.category === "ada"
      ? (item.intersections || []).join(", ")
      : [item.from, item.to].filter(Boolean).join(" to ");
  return {
    category: item.category,
    date: item.date,
    weekday,
    street: item.street,
    label: limits ? `${item.street} (${limits})` : item.street,
    approx,
  };
}

/** Filter a collection by category set and/or a specific date. */
export function filterCollection(
  fc: FeatureCollection,
  opts: { categories?: Category[]; date?: string }
): FeatureCollection {
  const cats = opts.categories ? new Set(opts.categories) : null;
  return {
    type: "FeatureCollection",
    features: fc.features.filter((f) => {
      const p = f.properties as PavingFeatureProps;
      if (cats && !cats.has(p.category)) return false;
      if (opts.date && p.date !== opts.date) return false;
      return true;
    }),
  };
}
