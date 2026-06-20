export type Category = "milling" | "paving" | "ada" | "construction";

/** A single scheduled item parsed out of one of the sheet tabs. */
export interface ScheduleItem {
  category: Category;
  /** ISO date, e.g. "2026-06-22". */
  date: string;
  /** Street being worked on, as written in the sheet (may be misspelled). */
  street: string;
  /**
   * For milling/paving: the two cross-street limits of the segment.
   * For ada: the list of intersections getting curb ramps.
   */
  from?: string;
  to?: string;
  intersections?: string[];
  /** The week label from the tab title, e.g. "2026 6-22 Milling list". */
  weekLabel?: string;
  /** Verbatim source cells, for debugging / display. */
  raw: string[];
}

export interface ResolvedGeometry {
  type: "LineString" | "Point" | "MultiPoint";
  /** [lng, lat] or [[lng,lat], ...]. */
  coordinates: number[] | number[][];
  /** True when we could not pin both ends and fell back to an approximation. */
  approx: boolean;
}

export interface PavingFeatureProps {
  category: Category;
  /**
   * For milling/paving/ada: the single work date. For construction (a DOMI
   * street closure that spans a range) this is the start date (`from_date`);
   * see `endDate` for the other end.
   */
  date: string;
  weekday: string;
  street: string;
  label: string;
  approx: boolean;
  /** Construction only: closure end date (`to_date`), if known. */
  endDate?: string;
  /** Construction only: permit type + closure scope + work blurb for the popup. */
  detail?: string;
  /** Construction only: whether the city currently flags the closure active. */
  active?: boolean;
}

export type GeocodeCache = Record<
  string,
  { coordinates: number[] | number[][]; type: ResolvedGeometry["type"]; approx: boolean } | null
>;
