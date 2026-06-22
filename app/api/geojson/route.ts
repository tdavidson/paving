import { NextResponse } from "next/server";
import { buildCollection, filterCollection } from "@/lib/data";
import { parseFilters } from "@/lib/filters";

export const runtime = "nodejs";
export const revalidate = 3600;

export async function GET(req: Request) {
  const { collection } = await buildCollection({
    includeConstruction: true,
    includeProjects: true,
    includeEvents: true,
  });
  const filtered = filterCollection(collection, parseFilters(req.url));
  return NextResponse.json(filtered, {
    headers: {
      "Content-Type": "application/geo+json",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
