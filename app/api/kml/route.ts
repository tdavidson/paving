import { buildCollection, filterCollection } from "@/lib/data";
import { parseFilters } from "@/lib/filters";
import { toKml } from "@/lib/kml";

export const runtime = "nodejs";
export const revalidate = 3600;

export async function GET(req: Request) {
  const { collection } = await buildCollection({ includeConstruction: true });
  const filtered = filterCollection(collection, parseFilters(req.url));
  const kml = toKml(filtered);
  return new Response(kml, {
    headers: {
      "Content-Type": "application/vnd.google-earth.kml+xml; charset=utf-8",
      "Content-Disposition": 'inline; filename="pittsburgh-paving.kml"',
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
