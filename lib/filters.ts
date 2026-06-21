import type { Category } from "./types";

const VALID: Category[] = ["milling", "paving", "ada", "construction", "paprojects"];

/** Parse ?category=milling,paving (repeatable) and ?date=YYYY-MM-DD from a URL. */
export function parseFilters(url: string): { categories?: Category[]; date?: string } {
  const sp = new URL(url).searchParams;
  const raw = [...sp.getAll("category"), ...(sp.get("categories")?.split(",") ?? [])]
    .flatMap((v) => v.split(","))
    .map((v) => v.trim().toLowerCase())
    .filter((v): v is Category => (VALID as string[]).includes(v));
  const date = sp.get("date") || undefined;
  return { categories: raw.length ? Array.from(new Set(raw)) : undefined, date };
}
