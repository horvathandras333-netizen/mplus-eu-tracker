/* ═══════════════════════════════════════════════════════════════════════════
   snapshot-cutoffs — scheduled daily recorder.

   Runs once a day (see `config` below), reads the live cutoffs straight from
   Raider.IO server-side, and upserts one record per (season, region, date).

   Safe to run repeatedly: the upsert in snapshot-store.js means a second run
   on the same UTC day updates the existing record instead of adding another.
   You can also trigger it by hand for a manual top-up:

       curl -X POST https://<site>/.netlify/functions/snapshot-cutoffs

   Regions are configurable with the SNAPSHOT_REGIONS environment variable
   (comma separated). It defaults to "eu", which is what the site displays.
   ═══════════════════════════════════════════════════════════════════════════ */
import { getStore } from "@netlify/blobs";
import Snapshots from "../../site/snapshot-store.js";
import { recordSnapshot } from "./cutoff-history.mjs";

const STORE_NAME = "cutoff-history";
const SEASONS = ["season-mn-1", "season-tww-3", "season-tww-2"];

function regions() {
  return (process.env.SNAPSHOT_REGIONS || "eu")
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
}

/** First season slug that returns usable cutoffs, mirroring the front end. */
async function fetchCutoffs(region) {
  for (const season of SEASONS) {
    const res = await fetch(
      `https://raider.io/api/v1/mythic-plus/season-cutoffs?season=${season}&region=${region}`
    );
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Raider.IO HTTP ${res.status} for ${season}/${region}`);

    const data = await res.json();
    const c = (data && data.cutoffs) || {};
    const p990 = c.p990?.all?.quantileMinValue;
    const p999 = c.p999?.all?.quantileMinValue;
    if (!Number.isFinite(Number(p990)) && !Number.isFinite(Number(p999))) continue;

    return {
      season,
      region,
      p990: Number(p990),
      p999: Number(p999),
      raiderUpdatedAt: c.updatedAt || null
    };
  }
  return null; // no active season — record nothing rather than invent a value
}

export default async () => {
  const store = getStore(STORE_NAME);
  const date = Snapshots.todayKey();
  const results = [];

  for (const region of regions()) {
    try {
      const live = await fetchCutoffs(region);
      if (!live) {
        results.push({ region, status: "no-active-season" });
        continue;
      }

      const outcome = await recordSnapshot(store, {
        date,
        season: live.season,
        region,
        p990: live.p990,
        p999: live.p999,
        updatedAt: new Date().toISOString(),
        source: "scheduled"
      });

      results.push({ region, season: live.season, date, ...outcome });
    } catch (e) {
      results.push({ region, status: "error", message: e.message });
    }
  }

  const failed = results.every((r) => r.status === "error");
  return new Response(JSON.stringify({ date, results }, null, 2), {
    status: failed ? 502 : 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
};

/* 06:10 UTC daily — after Raider.IO's own nightly recalculation has settled. */
export const config = {
  schedule: "10 6 * * *"
};
