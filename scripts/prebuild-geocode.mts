import fs from "node:fs";
import path from "node:path";
import { buildCollection } from "../lib/data";

/**
 * Resolve geometry for every item currently in the sheet and write the cache
 * to data/geocode-cache.json. Run this whenever you want to refresh the
 * committed cache (e.g. on a schedule or before deploy):  npm run geocode
 */
async function main() {
  console.log("Fetching schedule + resolving geometry from Pittsburgh GIS…");
  const { collection, unresolved, cache } = await buildCollection({ allowLive: true });

  const out = path.join(process.cwd(), "data", "geocode-cache.json");
  fs.writeFileSync(out, JSON.stringify(cache, null, 0));

  const approx = collection.features.filter((f) => (f.properties as any).approx).length;
  console.log(`\nResolved ${collection.features.length} map features (${approx} approximate).`);
  console.log(`Cache entries: ${Object.keys(cache).length} -> ${out}`);

  if (unresolved.length) {
    console.log(`\nCould not place ${unresolved.length} item(s):`);
    for (const u of unresolved) {
      const limits = u.intersections?.join(", ") ?? [u.from, u.to].filter(Boolean).join(" to ");
      console.log(`  - [${u.category}] ${u.date} ${u.street}${limits ? ` (${limits})` : ""}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
