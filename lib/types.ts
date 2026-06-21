export type Category = "milling" | "paving" | "ada" | "construction" | "paprojects";

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
   * street closure) and paprojects (a PennDOT project) this is the start date
   * of a range; see `endDate` for the other end.
   */
  date: string;
  weekday: string;
  street: string;
  label: string;
  approx: boolean;
  /** Construction/paprojects: end date (closure `to_date` / project completion), if known. */
  endDate?: string;
  /** Construction/paprojects: type + scope + work blurb for the popup. */
  detail?: string;
  /** Construction only: whether the city currently flags the closure active. */
  active?: boolean;
  /** Construction only: the DOMI permit id, e.g. "DOMI-GEN-2022-09644". */
  permitId?: string;
  /** Construction: the business/entity performing the work. Paprojects: the PennDOT project manager. */
  contractor?: string;
  /** Construction only: hours the closure is in effect (weekday/weekend). */
  hours?: string;
  /** Construction only: which segment of a multi-segment permit, e.g. "1 of 3". */
  segment?: string;
  /** Construction only: free-text special instructions for this closure. */
  notes?: string;
  /** Construction only: work-type bucket key (see lib/workTypes.ts) for filtering. */
  workGroup?: string;
}

export type GeocodeCache = Record<
  string,
  { coordinates: number[] | number[][]; type: ResolvedGeometry["type"]; approx: boolean } | null
>;
