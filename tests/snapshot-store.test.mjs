/* Tests for snapshot storage: duplicate handling, season/region separation. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Store = require("../site/snapshot-store.js");

const REC = {
  date: "2026-08-06",
  season: "season-mn-1",
  region: "eu",
  p990: 3000,
  p999: 3500
};

/* ── Bucketing: seasons and regions can never share storage ─────────────── */

test("bucket keys separate seasons and regions", () => {
  const a = Store.bucketKey("season-mn-1", "eu");
  const b = Store.bucketKey("season-tww-3", "eu");
  const c = Store.bucketKey("season-mn-1", "us");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
  assert.ok(a.startsWith(Store.KEY_PREFIX + ":"));
});

test("bucket keys are case- and whitespace-insensitive", () => {
  assert.equal(
    Store.bucketKey("  Season-MN-1 ", "EU"),
    Store.bucketKey("season-mn-1", "eu")
  );
});

test("filterSeasonRegion drops records from any other season or region", () => {
  const mixed = [
    { ...REC, date: "2026-08-04" },
    { ...REC, date: "2026-08-05", season: "season-tww-3" },
    { ...REC, date: "2026-08-06", region: "us" },
    { ...REC, date: "2026-08-07" }
  ];
  const kept = Store.filterSeasonRegion(mixed, "season-mn-1", "eu");
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((r) => r.date), ["2026-08-04", "2026-08-07"]);
});

/* ── Duplicate prevention — the central guarantee ───────────────────────── */

test("a second write for the same date updates rather than duplicates", () => {
  let list = [];
  let res = Store.upsert(list, REC);
  assert.equal(res.action, "inserted");
  assert.equal(res.changed, true);
  assert.equal(res.list.length, 1);

  res = Store.upsert(res.list, { ...REC, p990: 3025, p999: 3560 });
  assert.equal(res.action, "updated");
  assert.equal(res.changed, true);
  assert.equal(res.list.length, 1, "must not append a second record for the same day");
  assert.equal(res.list[0].p990, 3025);
  assert.equal(res.list[0].p999, 3560);
});

test("running the snapshot twenty times in one day yields exactly one record", () => {
  let list = [];
  for (let i = 0; i < 20; i++) {
    list = Store.upsert(list, { ...REC, p990: 3000 + i }).list;
  }
  assert.equal(list.length, 1);
  assert.equal(list[0].date, REC.date);
  assert.equal(list[0].p990, 3019, "the latest value should win");
});

test("an unchanged re-write reports changed:false so callers can skip storage", () => {
  const first = Store.upsert([], REC);
  const second = Store.upsert(first.list, REC);
  assert.equal(second.action, "updated");
  assert.equal(second.changed, false);
  assert.equal(second.list.length, 1);
});

test("distinct dates accumulate and stay sorted regardless of write order", () => {
  let list = [];
  ["2026-08-06", "2026-08-04", "2026-08-05"].forEach((date) => {
    list = Store.upsert(list, { ...REC, date }).list;
  });
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((r) => r.date), ["2026-08-04", "2026-08-05", "2026-08-06"]);
});

test("updating one threshold preserves the other already on record", () => {
  const first = Store.upsert([], REC).list;
  const second = Store.upsert(first, {
    date: REC.date, season: REC.season, region: REC.region, p990: 3100
  }).list;
  assert.equal(second.length, 1);
  assert.equal(second[0].p990, 3100, "supplied value updates");
  assert.equal(second[0].p999, 3500, "omitted value is retained");
});

test("upsert does not mutate the list it was given", () => {
  const original = Store.upsert([], REC).list;
  const snapshot = JSON.stringify(original);
  Store.upsert(original, { ...REC, p990: 9999 });
  assert.equal(JSON.stringify(original), snapshot);
});

/* ── Validation ─────────────────────────────────────────────────────────── */

test("records without a usable date or score are rejected, not stored", () => {
  const cases = [
    null,
    undefined,
    "nonsense",
    {},
    { date: "06/08/2026", p990: 3000 },
    { date: "2026-08-06" },                       // no thresholds at all
    { date: "2026-08-06", p990: "abc", p999: null }
  ];
  for (const bad of cases) {
    assert.equal(Store.normaliseRecord(bad), null, `should reject ${JSON.stringify(bad)}`);
    const res = Store.upsert([], bad);
    assert.equal(res.action, "rejected");
    assert.equal(res.changed, false);
    assert.equal(res.list.length, 0);
  }
});

test("a record carrying only one threshold is still accepted", () => {
  const only990 = Store.normaliseRecord({ date: "2026-08-06", p990: 3000 });
  assert.equal(only990.p990, 3000);
  assert.equal(only990.p999, undefined);

  const only999 = Store.normaliseRecord({ date: "2026-08-06", p999: 3500 });
  assert.equal(only999.p999, 3500);
  assert.equal(only999.p990, undefined);
});

test("normaliseRecord defaults a missing season or region to 'unknown'", () => {
  const rec = Store.normaliseRecord({ date: "2026-08-06", p990: 3000 });
  assert.equal(rec.season, "unknown");
  assert.equal(rec.region, "unknown");
  assert.ok(rec.updatedAt);
});

/* ── Merging the two storage tiers ──────────────────────────────────────── */

test("merge lets the primary (server) list win on a shared date", () => {
  const server = [{ ...REC, date: "2026-08-06", p990: 3050, source: "scheduled" }];
  const local = [
    { ...REC, date: "2026-08-05", p990: 2990 },
    { ...REC, date: "2026-08-06", p990: 3000, source: "client" }
  ];
  const merged = Store.merge(server, local);
  assert.equal(merged.length, 2);
  const today = merged.find((r) => r.date === "2026-08-06");
  assert.equal(today.p990, 3050);
  assert.equal(today.source, "scheduled");
  assert.equal(merged.find((r) => r.date === "2026-08-05").p990, 2990,
    "local-only days survive the merge");
});

test("merge handles either side being empty or missing", () => {
  assert.deepEqual(Store.merge([], []), []);
  assert.equal(Store.merge(undefined, [REC]).length, 1);
  assert.equal(Store.merge([REC], undefined).length, 1);
});

/* ── Serialisation round-trip ───────────────────────────────────────────── */

test("parse accepts the stored envelope, a bare array, or a JSON string", () => {
  const list = Store.upsert([], REC).list;
  const envelope = Store.serialise(list, REC.season, REC.region);

  assert.equal(Store.parse(envelope).length, 1);
  assert.equal(Store.parse(list).length, 1);
  assert.equal(Store.parse(JSON.stringify(envelope)).length, 1);
});

test("parse survives corrupt or empty storage without throwing", () => {
  assert.deepEqual(Store.parse(null), []);
  assert.deepEqual(Store.parse(""), []);
  assert.deepEqual(Store.parse("{not json"), []);
  assert.deepEqual(Store.parse({ records: "nope" }), []);
  assert.deepEqual(Store.parse({ records: [null, { date: "x" }] }), []);
});

test("serialise stamps the schema version, season and region", () => {
  const out = Store.serialise([REC], "Season-MN-1", "EU");
  assert.equal(out.version, Store.SCHEMA_VERSION);
  assert.equal(out.season, "season-mn-1");
  assert.equal(out.region, "eu");
  assert.ok(Array.isArray(out.records));
});

/* ── Day keys ───────────────────────────────────────────────────────────── */

test("todayKey is a UTC date, so timezones cannot split a day in two", () => {
  // 23:30 UTC and 00:30 UTC the next day must be different keys, and a local
  // timezone offset must not shift either of them.
  assert.equal(Store.todayKey(new Date("2026-08-06T23:30:00Z")), "2026-08-06");
  assert.equal(Store.todayKey(new Date("2026-08-07T00:30:00Z")), "2026-08-07");
  assert.equal(Store.todayKey(new Date("2026-08-06T00:00:00Z")), "2026-08-06");
  assert.match(Store.todayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

test("trimTo keeps an inclusive window ending on the given date", () => {
  let list = [];
  for (let d = 1; d <= 10; d++) {
    list = Store.upsert(list, { ...REC, date: `2026-08-${String(d).padStart(2, "0")}` }).list;
  }
  const kept = Store.trimTo(list, 7, "2026-08-10");
  assert.equal(kept.length, 7);
  assert.equal(kept[0].date, "2026-08-04");
  assert.equal(kept[6].date, "2026-08-10");
});
