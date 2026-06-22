import type { Feature } from "geojson";
import { isRangeCategory } from "./categories";

/**
 * Schedule work-days (milling/paving/ada) — one date per item. These drive the
 * calendar's "has work" bolding and anchor the default "this week" view.
 */
export function scheduleDays(features: Feature[]): string[] {
  const set = new Set<string>();
  for (const f of features) {
    const p = f.properties as any;
    if (isRangeCategory(p?.category)) continue;
    if (p?.date) set.add(p.date);
  }
  return Array.from(set).sort();
}

/**
 * The selectable date domain for the slider and presets: the schedule days,
 * plus any *future* start dates from the range layers (closures/projects).
 *
 * Past/ongoing range items are deliberately left out — they're handled by
 * range-overlap (see inWindow) and would just clutter the slider. But an
 * upcoming closure that starts *after* the schedule's last day needs a
 * reachable stop here, otherwise the date window could never extend far enough
 * to overlap it and the item would be permanently hidden (the schedule's
 * rolling "this week" window stops well before such closures begin).
 */
export function selectableDays(features: Feature[], todayISO: string): string[] {
  const sched = scheduleDays(features);
  const horizon = sched.length ? sched[sched.length - 1] : todayISO;
  const set = new Set<string>(sched);
  for (const f of features) {
    const p = f.properties as any;
    if (!isRangeCategory(p?.category)) continue;
    if (p?.date && p.date > horizon) set.add(p.date);
  }
  return Array.from(set).sort();
}
