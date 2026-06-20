import type { Category, ScheduleItem } from "./types";

const PUB_ID =
  process.env.PAVING_SHEET_PUB_ID ||
  "2PACX-1vRf8IJiGqX_ZK1j4YP1sq3YIOvxAvKq3kZpcaqlBVdl_yvfrLjQKCocWIDH5xNIJA";

const PUB_BASE = `https://docs.google.com/spreadsheets/d/e/${PUB_ID}`;

/** Values that mean "no work scheduled" rather than a street name. */
const NON_WORK = /^(off|no\s+(milling|paving|work|pave|mill)|holiday|tbd|n\/a)$/i;
const WEEKDAY = /^(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)\b/i;
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;

export interface SheetTab {
  gid: string;
  name: string;
  category: Category;
}

/** Discover the published tabs (name + gid) and map each to a category. */
export async function discoverTabs(): Promise<SheetTab[]> {
  const html = await fetchText(`${PUB_BASE}/pubhtml`);
  const tabs: SheetTab[] = [];
  const re = /items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)".*?gid:\s*"(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = m[1].replace(/\\x27/g, "'").replace(/\\x3d/g, "=").replace(/\\(.)/g, "$1");
    const gid = m[2];
    const category = categorize(name);
    if (category) tabs.push({ gid, name, category });
  }
  return tabs;
}

function categorize(name: string): Category | null {
  const n = name.toLowerCase();
  if (n.includes("ada") || n.includes("curb")) return "ada";
  if (n.includes("mill")) return "milling";
  if (n.includes("pav")) return "paving";
  return null;
}

/** Fetch + parse every relevant tab into a flat list of schedule items. */
export async function fetchSchedule(): Promise<ScheduleItem[]> {
  const tabs = await discoverTabs();
  const all: ScheduleItem[] = [];
  for (const tab of tabs) {
    try {
      const csv = await fetchText(`${PUB_BASE}/pub?gid=${tab.gid}&single=true&output=csv`);
      all.push(...parseTab(csv, tab));
    } catch (err) {
      console.warn(`Failed to load tab ${tab.name} (${tab.gid}):`, (err as Error).message);
    }
  }
  return dedupe(all);
}

/** Parse one tab's CSV into schedule items. */
export function parseTab(csv: string, tab: SheetTab): ScheduleItem[] {
  const rows = parseCsv(csv);
  const items: ScheduleItem[] = [];
  let currentDate: string | null = null;
  let weekLabel: string | undefined;
  let lastAdaStreet: string | null = null;

  for (const row of rows) {
    const cells = row.map((c) => (c ?? "").trim());
    const colA = cells[0] ?? "";

    // Title row, e.g. ",2026 6-22 Milling list,," — grab the label once.
    if (!weekLabel) {
      const titled = cells.find((c) => /list/i.test(c));
      if (titled) weekLabel = titled;
    }

    // Date row sets the active date for following rows.
    const iso = toIso(colA);
    if (iso) {
      currentDate = iso;
      lastAdaStreet = null;
      continue;
    }

    // Header row (contains "Street" / "Intersections"): skip.
    if (/^street$/i.test(colA) || cells.some((c) => /^intersections?$/i.test(c))) continue;

    const street = (cells[1] ?? "").trim();

    if (tab.category === "ada") {
      const intersections = cells.slice(2).map((c) => c.trim()).filter(Boolean);
      let name = street;
      if (name) {
        name = name.replace(/\s*cont\.?$/i, "").trim();
        lastAdaStreet = name;
      } else if (intersections.length && lastAdaStreet) {
        // Continuation row: more intersections for the previous street.
        name = lastAdaStreet;
      }
      if (!currentDate || !name || NON_WORK.test(name) || !intersections.length) continue;
      items.push({
        category: "ada",
        date: currentDate,
        street: name,
        intersections,
        weekLabel,
        raw: cells,
      });
      continue;
    }

    // milling / paving: street in col B, limits in cols C (to) and D (from).
    if (!currentDate || !street || NON_WORK.test(street) || WEEKDAY.test(street)) continue;
    const to = (cells[2] ?? "").trim();
    const from = (cells[3] ?? "").trim();
    items.push({
      category: tab.category,
      date: currentDate,
      street,
      from: from || undefined,
      to: to || undefined,
      weekLabel,
      raw: cells,
    });
  }

  return items;
}

function dedupe(items: ScheduleItem[]): ScheduleItem[] {
  const seen = new Set<string>();
  const out: ScheduleItem[] = [];
  for (const it of items) {
    const key = `${it.category}|${it.date}|${norm(it.street)}|${norm(it.from)}|${norm(it.to)}|${(it.intersections || []).map(norm).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

const norm = (s?: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

function toIso(s: string): string | null {
  const m = DATE_RE.exec(s.trim());
  if (!m) return null;
  let [, mm, dd, yy] = m;
  let year = parseInt(yy, 10);
  if (year < 100) year += 2000;
  const month = String(parseInt(mm, 10)).padStart(2, "0");
  const day = String(parseInt(dd, 10)).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "pgh-paving-map/1.0" },
    // Revalidate the upstream sheet periodically (Next.js fetch cache).
    next: { revalidate: 3600 },
  } as RequestInit);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Minimal RFC-4180-ish CSV parser (handles quoted fields and embedded commas/quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
