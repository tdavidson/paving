import type { FeatureCollection } from "geojson";
import type { Category, PavingFeatureProps } from "./types";

const COLORS: Record<Category, string> = {
  // KML colors are aabbggrr (alpha, blue, green, red).
  milling: "ff3b82f6", // blue
  paving: "ff111827", // near-black
  ada: "ff7c3aed", // purple
  construction: "ff147ce6", // amber/orange (#e67c14)
  paprojects: "ffed3a7c", // violet (#7c3aed)
};

const LABELS: Record<Category, string> = {
  milling: "Milling",
  paving: "Paving",
  ada: "ADA curb ramps",
  construction: "Construction (street closures)",
  paprojects: "PennDOT projects (Allegheny Co.)",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render a GeoJSON FeatureCollection as KML for import into Google My Maps. */
export function toKml(fc: FeatureCollection, title = "Pittsburgh Paving Schedule"): string {
  const styles = (Object.keys(COLORS) as Category[])
    .map(
      (cat) => `    <Style id="${cat}">
      <LineStyle><color>${COLORS[cat]}</color><width>5</width></LineStyle>
      <IconStyle><color>${COLORS[cat]}</color><scale>1.0</scale></IconStyle>
    </Style>`
    )
    .join("\n");

  const placemarks = fc.features
    .map((f) => {
      const p = f.properties as PavingFeatureProps;
      const spansRange = p.category === "construction" || p.category === "paprojects";
      const when =
        spansRange && p.endDate && p.endDate !== p.date
          ? `${esc(p.date)} – ${esc(p.endDate)}`
          : `${esc(p.date)} (${esc(p.weekday)})`;
      const extra = spansRange && p.detail ? ` — ${esc(p.detail)}` : "";
      const desc = `${LABELS[p.category]} — ${when}${p.approx ? " — approximate" : ""}${extra}`;
      const geom = f.geometry;
      let geomXml = "";
      if (geom.type === "LineString") {
        const coords = (geom.coordinates as number[][]).map((c) => `${c[0]},${c[1]},0`).join(" ");
        geomXml = `<LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>`;
      } else if (geom.type === "Point") {
        const c = geom.coordinates as number[];
        geomXml = `<Point><coordinates>${c[0]},${c[1]},0</coordinates></Point>`;
      } else {
        return "";
      }
      return `    <Placemark>
      <name>${esc(p.street)}</name>
      <description>${desc}</description>
      <styleUrl>#${p.category}</styleUrl>
      ${geomXml}
    </Placemark>`;
    })
    .filter(Boolean)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(title)}</name>
${styles}
${placemarks}
  </Document>
</kml>`;
}
