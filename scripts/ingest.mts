import fs from "node:fs";
import path from "node:path";
import { fetchSchedule } from "../lib/sheet";
import { loadArchive, mergeIntoArchive, saveArchive } from "../lib/archive";
import { buildCollection } from "../lib/data";

/**
 * Ingest the current sheet into the durable archive, then refresh geometry.
 *
 * The published sheet only shows a rolling "this week / past week" window, so
 * this is meant to run on a schedule (see .github/workflows/ingest.yml). Each
 * run:
 *   1. pulls the live sheet and appends any new dated rows to data/archive.json
 *      (nothing is ever removed — old weeks accumulate),
 *   2. re-resolves geometry for the whole archive into data/geocode-cache.json
 *      so historical rows keep their map positions.
 *
 *   npm run ingest
 */
async function main() {
  console.log("Pulling live sheet…");
  const items = await fetchSchedule();
  console.log(`  ${items.length} rows in the current window.`);

  const before = loadArchive();
  const { records, added, updated } = mergeIntoArchive(before, items);
  saveArchive(records);
  console.log(
    `Archive: ${records.length} total rows (+${added} new, ${updated} re-seen this run).`
  );

  console.log("Resolving geometry for the full archive…");
  const { collection, unresolved, cache } = await buildCollection({ allowLive: true });
  const cachePath = path.join(process.cwd(), "data", "geocode-cache.json");
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 0));
  const approx = collection.features.filter((f) => (f.properties as any).approx).length;
  console.log(
    `  ${collection.features.length} map features (${approx} approximate); cache: ${
      Object.keys(cache).length
    } entries.`
  );

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
