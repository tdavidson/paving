import fs from "node:fs";
import path from "node:path";
import type { Category, ScheduleItem } from "./types";

const ARCHIVE_PATH = path.join(process.cwd(), "data", "archive.json");

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * One scheduled item, pinned to its real calendar date and kept forever.
 *
 * The published sheet only exposes a rolling "this week / past week" window, so
 * older work disappears once the city rolls it forward. We ingest that window
 * on a schedule and append anything new here, so the archive grows into a full
 * season of dated history instead of resetting every Monday.
 */
export interface ArchiveRecord {
  /** Stable identity: category + date + street + limits (see idFor). */
  id: string;
  category: Category;
  /** Real calendar date, ISO "YYYY-MM-DD" — not a "this week" label. */
  date: string;
  /** Day of week derived from `date`, e.g. "Mon". */
  weekday: string;
  street: string;
  from?: string;
  to?: string;
  intersections?: string[];
  /** Week label from the source tab title, e.g. "2026 6-22 Milling list". */
  weekLabel?: string;
  /** When this row was first ingested (ISO datetime). */
  firstSeen: string;
  /** When this row was last present in the live sheet (ISO datetime). */
  lastSeen: string;
}

const norm = (s?: string) =>
  (s || "").toLowerCase().replace(/\s+/g, " ").replace(/\.+$/, "").trim();

/**
 * Stable identity for a scheduled item. Date is part of the key, so the same
 * street worked on two different days is two records, while the same row seen
 * again on a later ingest updates the existing one (refreshing lastSeen).
 */
export function idFor(item: {
  category: Category;
  date: string;
  street: string;
  from?: string;
  to?: string;
  intersections?: string[];
}): string {
  const limits =
    item.category === "ada"
      ? (item.intersections || []).map(norm).join(",")
      : `${norm(item.from)}|${norm(item.to)}`;
  return `${item.category}|${item.date}|${norm(item.street)}|${limits}`;
}

export function weekdayOf(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  return WEEKDAYS[d.getUTCDay()] ?? "";
}

export function loadArchive(): ArchiveRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as ArchiveRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveArchive(records: ArchiveRecord[]): void {
  const sorted = [...records].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.category.localeCompare(b.category) ||
      a.street.localeCompare(b.street)
  );
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(sorted, null, 2) + "\n");
}

export interface MergeResult {
  records: ArchiveRecord[];
  added: number;
  updated: number;
}

/**
 * Upsert the live sheet items into the archive. New rows are appended with
 * firstSeen=lastSeen=now; rows we've seen before just have lastSeen bumped
 * (and any newly-filled fields backfilled). Nothing is ever removed.
 */
export function mergeIntoArchive(
  existing: ArchiveRecord[],
  items: ScheduleItem[],
  now: string = new Date().toISOString()
): MergeResult {
  const byId = new Map(existing.map((r) => [r.id, r]));
  let added = 0;
  let updated = 0;

  for (const item of items) {
    const id = idFor(item);
    const prev = byId.get(id);
    if (prev) {
      prev.lastSeen = now;
      prev.weekLabel ??= item.weekLabel;
      prev.from ??= item.from;
      prev.to ??= item.to;
      if (!prev.intersections?.length && item.intersections?.length)
        prev.intersections = item.intersections;
      updated++;
    } else {
      byId.set(id, {
        id,
        category: item.category,
        date: item.date,
        weekday: weekdayOf(item.date),
        street: item.street,
        from: item.from,
        to: item.to,
        intersections: item.intersections,
        weekLabel: item.weekLabel,
        firstSeen: now,
        lastSeen: now,
      });
      added++;
    }
  }

  return { records: [...byId.values()], added, updated };
}

/** Convert archived records back into ScheduleItems for the geometry pipeline. */
export function archiveToItems(records: ArchiveRecord[]): ScheduleItem[] {
  return records.map((r) => ({
    category: r.category,
    date: r.date,
    street: r.street,
    from: r.from,
    to: r.to,
    intersections: r.intersections,
    weekLabel: r.weekLabel,
    raw: [],
  }));
}

/** Read the archive as ScheduleItems (empty if no archive exists yet). */
export function loadArchiveItems(): ScheduleItem[] {
  return archiveToItems(loadArchive());
}
