/**
 * Grouping for DOMI construction permits. The feed's `permit_type` has 11 raw
 * values (always populated, unlike the half-empty `work_type`), which collapse
 * into a handful of friendly buckets for the map's "Work type" filter.
 *
 * Order here is the order shown in the filter popover.
 */
export const WORK_GROUPS = [
  { key: "openings", label: "Road openings" },
  { key: "restoration", label: "Restoration & repair" },
  { key: "staging", label: "Staging" },
  { key: "poles", label: "Poles & wireless" },
  { key: "moving", label: "Moving" },
  { key: "other", label: "Other" },
] as const;

export type WorkGroupKey = (typeof WORK_GROUPS)[number]["key"];

export const WORK_GROUP_LABELS: Record<WorkGroupKey, string> = Object.fromEntries(
  WORK_GROUPS.map((g) => [g.key, g.label]),
) as Record<WorkGroupKey, string>;

/** Map a raw `permit_type` to its bucket. Unknown/blank types fall to "other". */
export function workGroupForPermitType(permitType?: string): WorkGroupKey {
  switch ((permitType || "").trim().toUpperCase()) {
    case "OPENING":
    case "UTILITY OPENING":
      return "openings";
    case "FINAL RESTORATION":
    case "BASE REPAIR":
    case "SIDEWALK REPAIR":
      return "restoration";
    case "CONSTRUCTION STAGING":
      return "staging";
    case "POLE":
    case "SMALL CELL WIRELESS FACILITY":
      return "poles";
    case "MOVING":
      return "moving";
    default:
      return "other";
  }
}
