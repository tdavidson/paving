"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarIcon } from "lucide-react";
import type { Category } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type FC = GeoJSON.FeatureCollection & {
  meta?: { generatedAt: string; unresolved: { category: string; date: string; street: string; limits: string }[] };
};

// Drawn from taylordavidson.com's "Muir" palette (teal / blue / rose).
const COLORS: Record<Category, string> = {
  milling: "#56b58a",
  paving: "#3e63a4",
  ada: "#c95274",
  construction: "#e67c14",
};
const LABELS: Record<Category, string> = {
  milling: "Milling",
  paving: "Paving",
  ada: "ADA curb ramps",
  construction: "Construction",
};
const PITTSBURGH = { lat: 40.4406, lng: -79.9959 };

let mapsPromise: Promise<void> | null = null;
function loadGoogleMaps(key: string): Promise<void> {
  if (typeof window !== "undefined" && (window as any).google?.maps) return Promise.resolve();
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve, reject) => {
    const cbName = "__initPavingGmaps";
    (window as any)[cbName] = () => resolve();
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      key
    )}&loading=async&callback=${cbName}`;
    s.async = true;
    s.onerror = () => reject(new Error("Failed to load Google Maps"));
    document.head.appendChild(s);
  });
  return mapsPromise;
}

function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// --- date helpers for the presets + calendar (all local-time, Monday-based) ---
function isoOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
/** Monday (00:00 local) of the week containing `d`. */
function mondayOf(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return addDays(r, -((r.getDay() + 6) % 7));
}
/** Map an ISO date onto the discrete `days` array for the slider thumbs. */
function isoToIndex(iso: string, days: string[], side: "lo" | "hi"): number {
  if (!days.length) return 0;
  if (side === "lo") {
    for (let i = 0; i < days.length; i++) if (days[i] >= iso) return i;
    return days.length - 1;
  }
  for (let i = days.length - 1; i >= 0; i--) if (days[i] <= iso) return i;
  return 0;
}

// Schedule items have a single `date`; construction closures span [date, endDate]
// and are shown whenever that range overlaps the selected [from, to] window.
function inWindow(p: any, from: string, to: string): boolean {
  if (p.category === "construction") {
    const start = p.date || "0000-00-00";
    const end = p.endDate || "9999-12-31";
    return start <= to && end >= from;
  }
  return p.date >= from && p.date <= to;
}

export default function PavingMap({ apiKey }: { apiKey: string }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const infoRef = useRef<google.maps.InfoWindow | null>(null);
  const overlaysRef = useRef<(google.maps.Polyline | google.maps.Marker)[]>([]);

  const [data, setData] = useState<FC | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cats, setCats] = useState<Record<Category, boolean>>({
    milling: true,
    paving: true,
    ada: true,
    construction: true,
  });
  // Active date window as ISO [from, to] — the single source of truth. The
  // slider, the week presets, and the calendar all just set this.
  const [dateWin, setDateWin] = useState<[string, string] | null>(null);
  const [ready, setReady] = useState(false);
  const [showUnresolved, setShowUnresolved] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [calOpen, setCalOpen] = useState(false);

  // Load data. Prefix with the base path so it works under a sub-path deploy too.
  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    fetch(`${base}/api/paving`)
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  // Load + init map.
  useEffect(() => {
    if (!apiKey) {
      setError("Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.");
      return;
    }
    loadGoogleMaps(apiKey)
      .then(() => {
        if (!mapEl.current) return;
        mapRef.current = new google.maps.Map(mapEl.current, {
          center: PITTSBURGH,
          zoom: 12,
          mapTypeControl: false,
          streetViewControl: false,
          styles: [{ featureType: "poi", stylers: [{ visibility: "off" }] }],
        });
        infoRef.current = new google.maps.InfoWindow();
        setReady(true);
      })
      .catch((e) => setError(e.message));
  }, [apiKey]);

  // The day slider is driven by the schedule (milling/paving/ada), which has one
  // work date per item. Construction closures span ranges that often start months
  // back, so they're excluded here (they'd stretch the slider) and instead
  // filtered by range-overlap below.
  const days = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const f of data.features) {
      const p = f.properties as any;
      if (p.category === "construction") continue;
      if (p.date) set.add(p.date);
    }
    return Array.from(set).sort();
  }, [data]);

  const fullSpan = useMemo<[string, string] | null>(
    () => (days.length ? [days[0], days[days.length - 1]] : null),
    [days]
  );

  // Default to the full span whenever the set of days changes.
  useEffect(() => {
    setDateWin(fullSpan);
  }, [fullSpan]);

  // Week presets, computed from today (Monday-based).
  const presets = useMemo(() => {
    const mon = mondayOf(new Date());
    const list: { label: string; range: [string, string] | null }[] = [
      { label: "Last week", range: [isoOf(addDays(mon, -7)), isoOf(addDays(mon, -1))] },
      { label: "This week", range: [isoOf(mon), isoOf(addDays(mon, 6))] },
      { label: "Next week", range: [isoOf(addDays(mon, 7)), isoOf(addDays(mon, 13))] },
      { label: "All", range: fullSpan },
    ];
    return list;
  }, [fullSpan]);

  const fromDate = dateWin?.[0] ?? fullSpan?.[0];
  const toDate = dateWin?.[1] ?? fullSpan?.[1];

  // Slider thumbs derived from the active window, clamped to the data's days.
  const sliderValue = useMemo<[number, number]>(() => {
    if (!days.length || !fromDate || !toDate) return [0, 0];
    const a = isoToIndex(fromDate, days, "lo");
    const b = isoToIndex(toDate, days, "hi");
    return [Math.min(a, b), Math.max(a, b)];
  }, [days, fromDate, toDate]);

  const selectedDay =
    dateWin && dateWin[0] === dateWin[1] ? new Date(dateWin[0] + "T00:00:00") : undefined;
  const workDays = useMemo(() => days.map((d) => new Date(d + "T00:00:00")), [days]);

  // Draw / redraw on any change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !data) return;

    overlaysRef.current.forEach((o) => o.setMap(null));
    overlaysRef.current = [];
    const bounds = new google.maps.LatLngBounds();
    let drawn = 0;

    for (const f of data.features) {
      const p = f.properties as any;
      const cat = p.category as Category;
      if (!cats[cat]) continue;
      if (fromDate && toDate && !inWindow(p, fromDate, toDate)) continue;
      const color = COLORS[cat];

      const when =
        cat === "construction" && p.endDate && p.endDate !== p.date
          ? `${fmtDate(p.date)} – ${fmtDate(p.endDate)}`
          : fmtDate(p.date);
      const detailLine =
        cat === "construction" && p.detail
          ? `<br/><span style="color:#6b7280">${escapeHtml(p.detail)}</span>`
          : p.label && p.label !== p.street
          ? `<br/><span style="color:#6b7280">${escapeHtml(p.label)}</span>`
          : "";
      const info = `<strong>${escapeHtml(p.street)}</strong><br/>${LABELS[cat]} — ${when}${
        p.approx ? " <em>(approx.)</em>" : ""
      }${detailLine}`;

      if (f.geometry.type === "LineString") {
        const path = (f.geometry.coordinates as number[][]).map((c) => ({ lat: c[1], lng: c[0] }));
        path.forEach((pt) => bounds.extend(pt));
        const line = new google.maps.Polyline({
          path,
          strokeColor: color,
          strokeOpacity: p.approx ? 0.5 : 0.9,
          strokeWeight: 5,
          map,
        });
        line.addListener("click", (e: google.maps.PolyMouseEvent) => openInfo(info, e.latLng));
        overlaysRef.current.push(line);
        drawn++;
      } else if (f.geometry.type === "Point") {
        const c = f.geometry.coordinates as number[];
        const pos = { lat: c[1], lng: c[0] };
        bounds.extend(pos);
        const marker = new google.maps.Marker({
          position: pos,
          map,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 6,
            fillColor: color,
            fillOpacity: 0.9,
            strokeColor: "#fff",
            strokeWeight: 1.5,
          },
        });
        marker.addListener("click", () => openInfo(info, pos));
        overlaysRef.current.push(marker);
        drawn++;
      }
    }
    if (drawn > 0 && !bounds.isEmpty()) map.fitBounds(bounds, 60);

    function openInfo(content: string, latLng: google.maps.LatLng | null | { lat: number; lng: number }) {
      if (!infoRef.current || !latLng) return;
      infoRef.current.setContent(content);
      infoRef.current.setPosition(latLng as google.maps.LatLng);
      infoRef.current.open(map!);
    }
  }, [data, cats, fromDate, toDate, ready]);

  const lastUpdated = data?.meta?.generatedAt ? new Date(data.meta.generatedAt).toLocaleString() : null;
  const unresolved = data?.meta?.unresolved ?? [];

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b bg-background px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <h1 className="text-sm font-semibold tracking-tight">Pittsburgh Paving and Construction</h1>
          <a
            href="https://taylordavidson.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            taylordavidson.com
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 md:ml-auto">
          {(Object.keys(COLORS) as Category[]).map((c) => (
            <div key={c} className="flex items-center gap-2">
              <Checkbox
                id={`cat-${c}`}
                checked={cats[c]}
                onCheckedChange={(v) => setCats((prev) => ({ ...prev, [c]: v === true }))}
              />
              <Label htmlFor={`cat-${c}`} className="flex cursor-pointer items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded-sm" style={{ background: COLORS[c] }} />
                {LABELS[c]}
              </Label>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {/* Week presets — snap the window to a calendar week. */}
            <div className="flex items-center gap-1">
              {presets.map((p) => {
                const active =
                  !!p.range && !!dateWin && dateWin[0] === p.range[0] && dateWin[1] === p.range[1];
                return (
                  <Button
                    key={p.label}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    className="h-7 px-2 text-xs"
                    disabled={!p.range}
                    onClick={() => p.range && setDateWin(p.range)}
                  >
                    {p.label}
                  </Button>
                );
              })}
            </div>

            {/* Calendar — pick an individual day (days with work are bold). */}
            <Popover open={calOpen} onOpenChange={setCalOpen}>
              <PopoverTrigger asChild>
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-xs">
                  <CalendarIcon className="h-3.5 w-3.5" />
                  {selectedDay && dateWin ? fmtDate(dateWin[0]) : "Pick a day"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={selectedDay}
                  defaultMonth={selectedDay ?? new Date()}
                  onSelect={(d) => {
                    if (!d) return;
                    const iso = isoOf(d);
                    setDateWin([iso, iso]);
                    setCalOpen(false);
                  }}
                  modifiers={{ hasWork: workDays }}
                  modifiersClassNames={{ hasWork: "font-semibold text-primary" }}
                />
              </PopoverContent>
            </Popover>

            {/* Slider — fine range control across the days that have data. */}
            {days.length > 1 && (
              <Slider
                className="w-40"
                min={0}
                max={days.length - 1}
                step={1}
                value={sliderValue}
                onValueChange={(v) => {
                  const a = v[0] ?? 0;
                  const b = v[1] ?? a;
                  setDateWin([days[Math.min(a, b)], days[Math.max(a, b)]]);
                }}
                aria-label="Date range"
              />
            )}

            {fromDate && toDate && (
              <span className="text-xs text-muted-foreground">
                {fromDate === toDate ? fmtDate(fromDate) : `${fmtDate(fromDate)} – ${fmtDate(toDate)}`}
              </span>
            )}
          </div>

          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => setShowShare(true)}
          >
            Add to Google Maps
          </Button>
        </div>
      </header>

      {error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          Map error: {error}
        </div>
      )}

      <div className="relative flex-1">
        <div ref={mapEl} className="h-full w-full" />
        <Card className="absolute bottom-4 left-4 z-[2] p-3 text-xs leading-relaxed">
          {(Object.keys(COLORS) as Category[]).map((c) => (
            <div key={c} className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: COLORS[c] }} />
              {LABELS[c]}
            </div>
          ))}
          {lastUpdated && <div className="mt-1.5 text-muted-foreground">Schedule pulled {lastUpdated}</div>}
          {unresolved.length > 0 && (
            <button
              type="button"
              onClick={() => setShowUnresolved(true)}
              className="text-left text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {unresolved.length} item(s) couldn&apos;t be placed
            </button>
          )}
        </Card>
      </div>

      {showUnresolved && (
        <UnresolvedModal items={unresolved} onClose={() => setShowUnresolved(false)} />
      )}
      {showShare && <ShareModal onClose={() => setShowShare(false)} />}
    </div>
  );
}

/**
 * Walks the user through importing the live overlay into Google My Maps, where
 * it sits alongside Google's own base map (and traffic layer) — the combination
 * the schedule sheet alone can't give you.
 */
function ShareModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const kmlAll = `${origin}${base}/api/kml`;
  const kmlConstruction = `${origin}${base}/api/kml?category=construction`;

  return (
    <div
      className="fixed inset-0 z-[10] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Add this map to Google My Maps"
    >
      <Card
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Add to Google My Maps</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Import this live overlay as a layer, then turn on Google&apos;s Traffic layer — active
              construction closures on top of real-time traffic.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-sm px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3 text-xs">
          <ol className="space-y-3">
            <li className="flex flex-col gap-1.5">
              <span>
                <strong>1.</strong> Copy the live feed link (everything, or construction only):
              </span>
              <CopyRow label="Everything" url={kmlAll} />
              <CopyRow label="Construction only" url={kmlConstruction} />
              <span className="text-muted-foreground">
                Tip: add <code className="rounded bg-muted px-1">?date=YYYY-MM-DD</code> to pin a day.
              </span>
            </li>
            <li>
              <strong>2.</strong> Open{" "}
              <Button asChild size="sm" variant="outline" className="mx-0.5 h-6 px-2 text-xs">
                <a
                  href="https://www.google.com/maps/d/u/0/?action=new"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Google My Maps ↗
                </a>
              </Button>{" "}
              and create (or open) a map.
            </li>
            <li>
              <strong>3.</strong> In the legend, click <em>Add layer → Import</em>, choose{" "}
              <em>paste a URL</em>, and paste the link from step 1.
            </li>
            <li>
              <strong>4.</strong> Set the base map to <em>Traffic</em> (or open the map in the Google
              Maps app and enable the Traffic layer) to see closures against live conditions.
            </li>
          </ol>
          <p className="mt-3 text-muted-foreground">
            My Maps imports a snapshot, so re-import to pull the latest. The link always serves the
            current data, so an embed of this app stays continuously live.
          </p>
        </div>
      </Card>
    </div>
  );
}

function CopyRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{label}</span>
      <code className="flex-1 truncate text-[11px]" title={url}>
        {url}
      </code>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-6 shrink-0 px-2 text-[11px]"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard blocked; user can still select the text */
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function UnresolvedModal({
  items,
  onClose,
}: {
  items: { category: string; date: string; street: string; limits: string }[];
  onClose: () => void;
}) {
  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sorted = [...items].sort(
    (a, b) => a.category.localeCompare(b.category) || a.street.localeCompare(b.street)
  );

  return (
    <div
      className="fixed inset-0 z-[10] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Items that couldn't be placed on the map"
    >
      <Card
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">
              {items.length} item(s) couldn&apos;t be placed
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The city&apos;s schedule lists these by hand, so misspelled or ambiguous street
              names can&apos;t be matched to map geometry. They&apos;re shown here verbatim.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-sm px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-2">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-background text-left text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Type</th>
                <th className="py-1.5 pr-3 font-medium">Date</th>
                <th className="py-1.5 pr-3 font-medium">Street</th>
                <th className="py-1.5 font-medium">Limits / intersections</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((u, i) => (
                <tr key={i} className="border-t align-top">
                  <td className="py-1.5 pr-3 capitalize">{u.category}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{u.date}</td>
                  <td className="py-1.5 pr-3">{u.street}</td>
                  <td className="py-1.5 text-muted-foreground">{u.limits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
