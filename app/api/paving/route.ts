import { NextResponse } from "next/server";
import { buildCollection } from "@/lib/data";

export const runtime = "nodejs";
export const revalidate = 3600;

export async function GET() {
  const { collection, unresolved } = await buildCollection({
    includeConstruction: true,
    includeProjects: true,
    includeEvents: true,
  });
  return NextResponse.json(
    {
      ...collection,
      meta: {
        generatedAt: new Date().toISOString(),
        unresolved: unresolved.map((u) => ({
          category: u.category,
          date: u.date,
          street: u.street,
          limits: u.intersections?.join(", ") ?? [u.from, u.to].filter(Boolean).join(" to "),
        })),
      },
    },
    { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } }
  );
}
