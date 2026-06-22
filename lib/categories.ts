import type { Category } from "./types";

/**
 * Layers whose features span a [date, endDate] range (construction permits,
 * PennDOT projects, road closures) rather than the schedule's single work date.
 * They're filtered by range-overlap and kept off the day slider.
 */
export const RANGE_CATEGORIES = new Set<Category>(["construction", "paprojects", "closures511"]);

export function isRangeCategory(category: unknown): boolean {
  return typeof category === "string" && RANGE_CATEGORIES.has(category as Category);
}
