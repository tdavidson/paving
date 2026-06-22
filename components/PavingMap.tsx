/// <reference types="google.maps" />
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarIcon, ChevronDown } from "lucide-react";
import type { Category } from "@/lib/types";
import { WORK_GROUPS } from "@/lib/workTypes";
import { RANGE_CATEGORIES } from "@/lib/categories";
import { scheduleDays as computeScheduleDays, selectableDays } from "@/lib/dateWindow";
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
  closures511: "#dc2626",
  construction: "#e67c14",
  paprojects: "#7c3aed",
};
const LABELS: Record<Category, string> = {
  milling: "Milling",
  paving: "Paving",
  ada: "ADA curb ramps",
  closures511: "Road closures",
  construction: "Construction",
  paprojects: "PennDOT projects",
};
// The range-vs-schedule category split lives in lib/categories so the date
// helpers (lib/dateWindow) can share it.
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

// Schedule items have a single `date`; the range layers (construction, PennDOT
// projects, road closures) span [date, endDate] and are shown whenever that
// range overlaps the selected [from, to] window.
function inWindow(p: any, from: string, to: string): boolean {
  if (RANGE_CATEGORIES.has(p.category)) {
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
  const trafficRef = useRef<google.maps.TrafficLayer | null>(null);

  const [data, setData] = useState<FC | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cats, setCats] = useState<Record<Category, boolean>>({
    milling: true,
    paving: true,
    ada: true,
    // Road closures (PennDOT/511PA, Pittsburgh + Allegheny County) are the
    // primary signal, so they're on by default.
    closures511: true,
    // The noisier layers are additive and off by default: DOMI city permits
    // (construction) and county-wide PennDOT capital projects. Toggling
    // projects on also widens the map to the whole county.
    construction: false,
    paprojects: false,
  });
  // Active date window as ISO [from, to] — the single source of truth. The
  // slider, the week presets, and the calendar all just set this.
  const [dateWin, setDateWin] = useState<[string, string] | null>(null);
  const [ready, setReady] = useState(false);
  const [showUnresolved, setShowUnresolved] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [calOpen, setCalOpen] = useState(false);
  const [traffic, setTraffic] = useState(false);
  // Which construction work-type buckets are shown (all on by default).
  const [workGroups, setWorkGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(WORK_GROUPS.map((g) => [g.key, true])),
  );
  const [workTypeOpen, setWorkTypeOpen] = useState(false);

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

  // Google's live Traffic layer, toggled on/off over our overlays.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (traffic) {
      if (!trafficRef.current) trafficRef.current = new google.maps.TrafficLayer();
      trafficRef.current.setMap(map);
    } else {
      trafficRef.current?.setMap(null);
    }
  }, [traffic, ready]);

  // Schedule work-days (milling/paving/ada) anchor the default "this week" view
  // and the calendar's "has work" bolding.
  const scheduleDays = useMemo(() => (data ? computeScheduleDays(data.features) : []), [data]);

  // The slider/preset domain: schedule days plus any *future* closure/project
  // start dates, so upcoming items that begin after the schedule ends are
  // reachable (ongoing ones are handled by range-overlap in inWindow). See
  // lib/dateWindow for the rationale.
  const days = useMemo(
    () => (data ? selectableDays(data.features, isoOf(new Date())) : []),
    [data]
  );

  const fullSpan = useMemo<[string, string] | null>(
    () => (days.length ? [days[0], days[days.length - 1]] : null),
    [days]
  );

  // Default to "this week" (falling back to the full span when there's no
  // current-week schedule data) whenever the set of days changes.
  const defaultWin = useMemo<[string, string] | null>(() => {
    const mon = mondayOf(new Date());
    const thisWeek: [string, string] = [isoOf(mon), isoOf(addDays(mon, 6))];
    if (days.some((d) => d >= thisWeek[0] && d <= thisWeek[1])) return thisWeek;
    return fullSpan;
  }, [days, fullSpan]);

  useEffect(() => {
    setDateWin(defaultWin);
  }, [defaultWin]);

  // Week presets, computed from today (Monday-based). A week preset is only
  // shown if the schedule actually has work in that week (no "Last week" button
  // when there's no last-week data); "All" shows whenever any data exists.
  const presets = useMemo(() => {
    const mon = mondayOf(new Date());
    const weeks: { label: string; range: [string, string] }[] = [
      { label: "Last week", range: [isoOf(addDays(mon, -7)), isoOf(addDays(mon, -1))] },
      { label: "This week", range: [isoOf(mon), isoOf(addDays(mon, 6))] },
      { label: "Next week", range: [isoOf(addDays(mon, 7)), isoOf(addDays(mon, 13))] },
    ];
    const hasData = (r: [string, string]) => days.some((d) => d >= r[0] && d <= r[1]);
    const list = weeks.filter((w) => hasData(w.range)) as {
      label: string;
      range: [string, string] | null;
    }[];
    // "Upcoming": today through the furthest known future date. Surfaces
    // closures/projects that start after this week. Shown only when the data
    // actually extends past next week (i.e. there are future-dated range items).
    const nextWeekEnd = isoOf(addDays(mon, 13));
    if (fullSpan && fullSpan[1] > nextWeekEnd) {
      list.push({ label: "Upcoming", range: [isoOf(new Date()), fullSpan[1]] });
    }
    if (fullSpan) list.push({ label: "All", range: fullSpan });
    return list;
  }, [days, fullSpan]);

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
  const workDays = useMemo(
    () => scheduleDays.map((d) => new Date(d + "T00:00:00")),
    [scheduleDays]
  );

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
      if (cat === "construction" && !workGroups[p.workGroup || "other"]) continue;
      if (fromDate && toDate && !inWindow(p, fromDate, toDate)) continue;
      const color = COLORS[cat];

      const spansRange = RANGE_CATEGORIES.has(cat);
      const when =
        spansRange && p.endDate && p.endDate !== p.date
          ? `${fmtDate(p.date)} – ${fmtDate(p.endDate)}`
          : p.date
            ? fmtDate(p.date)
            : "ongoing";
      const gray = (s: string) => `<br/><span style="color:#6b7280">${escapeHtml(s)}</span>`;
      let extra = "";
      if (cat === "construction") {
        if (p.detail) extra += gray(p.detail);
        if (p.hours) extra += gray(`Hours: ${p.hours}`);
        if (p.contractor) extra += gray(`Contractor: ${p.contractor}`);
        const permitBits = [
          p.permitId ? `Permit ${p.permitId}` : "",
          p.segment ? `segment ${p.segment}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        if (permitBits) extra += gray(permitBits);
        if (p.notes) extra += gray(p.notes);
      } else if (cat === "paprojects") {
        if (p.detail) extra += gray(p.detail);
        if (p.contractor) extra += gray(`Project manager: ${p.contractor}`);
      } else if (cat === "closures511") {
        if (p.detail) extra += gray(p.detail);
      } else if (p.label && p.label !== p.street) {
        extra += gray(p.label);
      }
      const info = `<strong>${escapeHtml(p.street)}</strong><br/>${LABELS[cat]} — ${when}${
        p.approx ? " <em>(approx.)</em>" : ""
      }${extra}`;

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
  }, [data, cats, workGroups, fromDate, toDate, ready]);

  const lastUpdated = data?.meta?.generatedAt ? new Date(data.meta.generatedAt).toLocaleString() : null;
  const unresolved = data?.meta?.unresolved ?? [];

  // Per-bucket construction counts for the work-type popover, reflecting the
  // active date window so the numbers match what's actually drawn.
  const constructionCounts = useMemo(() => {
    const counts: Record<string, number> = Object.fromEntries(WORK_GROUPS.map((g) => [g.key, 0]));
    for (const f of data?.features ?? []) {
      const p = f.properties as any;
      if (p.category !== "construction") continue;
      if (fromDate && toDate && !inWindow(p, fromDate, toDate)) continue;
      const g = p.workGroup || "other";
      if (g in counts) counts[g]++;
    }
    return counts;
  }, [data, fromDate, toDate]);

  const selectedWorkGroups = WORK_GROUPS.filter((g) => workGroups[g.key]).length;
  const allWorkGroupsOn = selectedWorkGroups === WORK_GROUPS.length;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-col gap-2.5 border-b bg-background px-4 py-2.5">
        {/* Row 1: title + actions */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-sm font-semibold tracking-tight">Pittsburgh Paving and Construction</h1>
          <div className="flex items-center gap-2 md:ml-auto">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              onClick={() => setShowAbout(true)}
            >
              About
            </Button>
          </div>
        </div>

        {/* Row 2: layer selectors + date controls */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          {(Object.keys(COLORS) as Category[]).map((c) => {
            const swatch = (
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: COLORS[c] }} />
            );
            const box = (
              <Checkbox
                id={`cat-${c}`}
                checked={cats[c]}
                aria-label={LABELS[c]}
                onCheckedChange={(v) => setCats((prev) => ({ ...prev, [c]: v === true }))}
              />
            );

            // Construction folds its work-type facet into the same control: the
            // checkbox toggles the layer, the label+chevron opens the buckets.
            if (c === "construction") {
              return (
                <div key={c} className="flex items-center gap-2">
                  {box}
                  <Popover open={workTypeOpen} onOpenChange={setWorkTypeOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="flex cursor-pointer items-center gap-1.5 text-sm"
                      >
                        {swatch}
                        {LABELS[c]}
                        {!allWorkGroupsOn && (
                          <span className="text-muted-foreground">
                            ({selectedWorkGroups}/{WORK_GROUPS.length})
                          </span>
                        )}
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-64 p-2">
                      <div className="flex items-center justify-between px-1 pb-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
                          Construction work type
                        </span>
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-foreground"
                          onClick={() =>
                            setWorkGroups(
                              Object.fromEntries(WORK_GROUPS.map((g) => [g.key, !allWorkGroupsOn])),
                            )
                          }
                        >
                          {allWorkGroupsOn ? "Clear all" : "Select all"}
                        </button>
                      </div>
                      {WORK_GROUPS.map((g) => (
                        <Label
                          key={g.key}
                          htmlFor={`wg-${g.key}`}
                          className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 hover:bg-muted"
                        >
                          <Checkbox
                            id={`wg-${g.key}`}
                            checked={workGroups[g.key]}
                            onCheckedChange={(v) =>
                              setWorkGroups((prev) => ({ ...prev, [g.key]: v === true }))
                            }
                          />
                          <span className="flex-1 text-sm">{g.label}</span>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {constructionCounts[g.key]}
                          </span>
                        </Label>
                      ))}
                    </PopoverContent>
                  </Popover>
                </div>
              );
            }

            return (
              <div key={c} className="flex items-center gap-2">
                {box}
                <Label htmlFor={`cat-${c}`} className="flex cursor-pointer items-center gap-1.5">
                  {swatch}
                  {LABELS[c]}
                </Label>
              </div>
            );
          })}

          {/* Google's live traffic layer. */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="cat-traffic"
              checked={traffic}
              onCheckedChange={(v) => setTraffic(v === true)}
            />
            <Label htmlFor="cat-traffic" className="flex cursor-pointer items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded-sm bg-gradient-to-r from-[#63d668] via-[#ff974d] to-[#f23c32]" />
              Live traffic
            </Label>
          </div>

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
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
    </div>
  );
}

/** Intro + how-it-works, adapted from the project README. */
function AboutModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[10] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="About this map"
    >
      <Card
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">
            About Pittsburgh Paving and Construction
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-sm px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto px-4 py-3 text-xs leading-relaxed">
          <p className="text-muted-foreground">
            Built and maintained by{" "}
            <a
              href="https://taylordavidson.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground underline underline-offset-2 hover:text-foreground"
            >
              Taylor Davidson
            </a>
            . Open source and public on{" "}
            <a
              href="https://github.com/tdavidson/paving"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground underline underline-offset-2 hover:text-foreground"
            >
              GitHub
            </a>
            .
          </p>
          <p>
            An unofficial, auto-updating map of the City of Pittsburgh&apos;s milling, paving, and
            ADA curb-ramp schedule, plus active street-closure <strong>construction</strong>{" "}
            permits. It reads the city&apos;s own published data live, so the map reflects whatever
            the city last published. See the city&apos;s official{" "}
            <a
              href="https://www.pittsburghpa.gov/Resident-Services/Road-Maintenance/Paving-Schedule"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Paving Schedule page
            </a>
            .
          </p>
          <p>
            The schedule covers only planned resurfacing. Most of the construction you see on the
            street (utility cuts, road openings, contractor work) is permitted separately by the{" "}
            Department of Mobility &amp; Infrastructure (DOMI) and published as the{" "}
            <a
              href="https://data.wprdc.org/dataset/street-closures"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              DOMI Street Closures
            </a>{" "}
            dataset on the Western Pennsylvania Regional Data Center (WPRDC).
          </p>

          <div>
            <h3 className="mb-1 text-xs font-semibold">How it works</h3>
            <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
              <li>
                <strong className="text-foreground">Paving / milling / ADA</strong> come from the
                city&apos;s published Google Sheet. The rolling sheet only shows this/past week, so a
                daily ingest stamps each row with its real date and keeps a growing history.
              </li>
              <li>
                Those hand-typed streets are matched to geometry using the City of Pittsburgh GIS
                centerline (no Google geocoding), with a typo-correction layer for names the sheet
                misspells.
              </li>
              <li>
                <strong className="text-foreground">Road closures</strong> (on by default) are live
                PennDOT road events — roadwork, closed bridges, and route closures — across
                Pittsburgh and Allegheny County, pulled from{" "}
                <a
                  href="https://www.511pa.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  511PA
                </a>{" "}
                (the public side of PennDOT&apos;s RCRS system). Unlike the project records, these
                carry the actual closure start/end dates.
              </li>
              <li>
                <strong className="text-foreground">Construction</strong> (off by default) is the
                City of Pittsburgh&apos;s DOMI street-closure permits, fetched live from the WPRDC
                closures feed, which already ships geometry. Only currently-active closures are
                shown. It overlaps the road-closures layer inside the city, so it&apos;s additive.
              </li>
              <li>
                <strong className="text-foreground">PennDOT projects</strong> (off by default) adds
                county-wide road &amp; bridge work on state-maintained roads, pulled live from
                PennDOT&apos;s public{" "}
                <a
                  href="https://gis.penndot.gov/paprojects/construction-map"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  PA Projects
                </a>{" "}
                map — only those under construction in Allegheny County. The city sheet and DOMI
                permits stop at the city line, so this fills in the rest of the county. Toggling it
                on widens the map to the whole county.
              </li>
              <li>
                Filter by work type and by day: use the week presets, the slider, or pick an
                individual day from the calendar. Toggle <em>Live traffic</em> to see closures
                against Google&apos;s real-time traffic.
              </li>
            </ul>
          </div>

          <p className="border-t pt-3 text-muted-foreground">
            <strong className="text-foreground">Disclaimer:</strong> Unofficial. Schedules change
            and are weather-dependent; always follow posted &ldquo;No Parking&rdquo; signs. Data ©
            City of Pittsburgh; geometry derived from the city&apos;s public GIS centerline and the
            WPRDC DOMI Street Closures dataset.
          </p>
        </div>
      </Card>
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
