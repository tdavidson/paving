"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Category } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";

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
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=${cbName}`;
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
  const [range, setRange] = useState<[number, number] | null>(null);
  const [ready, setReady] = useState(false);

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

  // Default the range to the full span whenever the set of days changes.
  useEffect(() => {
    setRange(days.length ? [0, days.length - 1] : null);
  }, [days]);

  const [lo, hi] = range ?? [0, Math.max(0, days.length - 1)];
  const fromDate = days[lo];
  const toDate = days[hi];

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
        <h1 className="text-sm font-semibold tracking-tight">Pittsburgh Paving Schedule</h1>

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

          {days.length > 1 ? (
            <div className="flex flex-col gap-1">
              <Slider
                className="w-48"
                min={0}
                max={days.length - 1}
                step={1}
                value={[lo, hi]}
                onValueChange={(v) => setRange([v[0], v[1] ?? v[0]])}
                aria-label="Date range"
              />
              <span className="text-xs text-muted-foreground">
                {fromDate === toDate ? fmtDate(fromDate) : `${fmtDate(fromDate)} – ${fmtDate(toDate)}`}
                {hi - lo + 1 > 1 ? ` · ${hi - lo + 1} days` : ""}
              </span>
            </div>
          ) : (
            days.length === 1 && <span className="text-xs text-muted-foreground">{fmtDate(days[0])}</span>
          )}
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
            <div
              className="text-muted-foreground"
              title={unresolved.map((u) => `${u.street} (${u.limits})`).join("\n")}
            >
              {unresolved.length} item(s) couldn&apos;t be placed
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
