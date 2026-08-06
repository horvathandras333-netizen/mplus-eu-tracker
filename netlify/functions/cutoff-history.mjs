/* ═══════════════════════════════════════════════════════════════════════════
   cutoff-history — read and record daily M+ cutoff snapshots.

   GET  /.netlify/functions/cutoff-history?season=<slug>&region=<eu|us|kr|tw>
        → { version, season, region, records: [...] }

   POST /.netlify/functions/cutoff-history
        body: { date, season, region, p990, p999 }
        → upserts. A second POST for the same (season, region, date) UPDATES
          the existing record; it never appends a duplicate.

   Storage is Netlify Blobs, one blob per (season, region), so records from
   different seasons or regions are physically incapable of mixing.

   This endpoint is additive: the site works without it (the browser falls
   back to its own localStorage record), so a deploy that lacks functions
   degrades silently rather than breaking.
   ═══════════════════════════════════════════════════════════════════════════ */
import { getStore } from "@netlify/blobs";
import Snapshots from "../../site/snapshot-store.js";

const STORE_NAME = "cutoff-history";
const ALLOWED_REGIONS = new Set(["us", "eu", "kr", "tw", "cn"]);
const MAX_RECORDS = 400; // a season is far shorter; this is a runaway guard

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      ...extra
    }
  });
}

function badRequest(message) {
  return json({ error: message }, 400);
}

function validParams(season, region) {
  /* normaliseSeason/Region turn a missing value into "unknown", which would
     otherwise sail through the format check and read a phantom bucket. */
  if (!season || season === "unknown" || !/^[a-z0-9-]{3,64}$/.test(season)) {
    return "Invalid or missing 'season'.";
  }
  if (!region || region === "unknown" || !ALLOWED_REGIONS.has(region)) {
    return "Invalid or missing 'region'.";
  }
  return null;
}

export async function readHistory(store, season, region) {
  const key = Snapshots.bucketKey(season, region);
  const payload = await store.get(key, { type: "json" });
  return Snapshots.filterSeasonRegion(Snapshots.parse(payload), season, region);
}

export async function writeHistory(store, season, region, records) {
  const key = Snapshots.bucketKey(season, region);
  await store.setJSON(key, Snapshots.serialise(records, season, region));
}

/**
 * Validate and upsert one snapshot. Not reachable over HTTP — the scheduled
 * function is the only writer, so there is no unauthenticated write path.
 *
 * Returns a plain result object; throws only if storage itself fails.
 */
export async function recordSnapshot(store, raw) {
  const record = Snapshots.normaliseRecord(raw);
  if (!record) {
    return { ok: false, error: "Record needs a valid date and at least one threshold." };
  }
  const err = validParams(record.season, record.region);
  if (err) return { ok: false, error: err };

  for (const key of ["p990", "p999"]) {
    const v = record[key];
    if (v !== undefined && (v < 0 || v > 100000)) {
      return { ok: false, error: `'${key}' is out of plausible range.` };
    }
  }

  const existing = await readHistory(store, record.season, record.region);
  const { list, action, changed } = Snapshots.upsert(existing, record);
  /* Only write when something actually changed — repeat runs in a day are
     cheap no-ops rather than blob churn. */
  if (changed || action === "inserted") {
    await writeHistory(store, record.season, record.region, list.slice(-MAX_RECORDS));
  }
  return { ok: true, action, changed, count: list.length };
}

/**
 * The endpoint, with storage injected so it can be tested against a fake blob
 * store. `export default` binds it to the real one.
 *
 * READ ONLY. This used to accept POST so a visitor's browser could contribute
 * a snapshot, but that meant an unauthenticated write reachable by anyone —
 * a way to create unbounded blobs and burn function invocations. It became
 * redundant once Raider.IO's own graphData turned out to carry the history,
 * so the route is gone rather than merely guarded.
 */
export async function handleRequest(req, store) {
  const url = new URL(req.url);

  if (req.method === "GET" || req.method === "HEAD") {
    const season = Snapshots.normaliseSeason(url.searchParams.get("season"));
    const region = Snapshots.normaliseRegion(url.searchParams.get("region"));
    const err = validParams(season, region);
    if (err) return badRequest(err);

    try {
      const records = await readHistory(store, season, region);
      return json(Snapshots.serialise(records, season, region));
    } catch (e) {
      return json({ error: "Could not read history: " + e.message }, 502);
    }
  }

  return json(
    { error: "This endpoint is read-only. Snapshots are written by the scheduled job." },
    405,
    { allow: "GET, HEAD" }
  );
}

export default async (req) => handleRequest(req, getStore(STORE_NAME));
