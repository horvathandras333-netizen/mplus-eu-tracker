/* Tests for the snapshot endpoint, against an in-memory stand-in for Netlify
   Blobs. Covers the duplicate-write guarantee at the API layer. */
import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, recordSnapshot } from "../netlify/functions/cutoff-history.mjs";

const URL_BASE = "https://example.netlify.app/.netlify/functions/cutoff-history";

/** Minimal fake of the Blobs API, with a write counter and failure injection. */
function fakeStore(initial = {}) {
  return {
    data: { ...initial },
    writes: 0,
    failOn: null,
    async get(key) {
      if (this.failOn === "get") throw new Error("blob store offline");
      return this.data[key] ?? null;
    },
    async setJSON(key, value) {
      if (this.failOn === "set") throw new Error("blob store read-only");
      this.writes++;
      this.data[key] = value;
    }
  };
}

const get = (qs) => new Request(`${URL_BASE}?${qs}`);
const post = (body) =>
  new Request(URL_BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });

const REC = {
  date: "2026-08-06", season: "season-mn-1", region: "eu", p990: 3000, p999: 3500
};

/* ── GET ────────────────────────────────────────────────────────────────── */

test("GET returns an empty record list for an untouched season", async () => {
  const res = await handleRequest(get("season=season-mn-1&region=eu"), fakeStore());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.season, "season-mn-1");
  assert.equal(body.region, "eu");
  assert.deepEqual(body.records, []);
});

test("GET rejects a missing or malformed season or region", async () => {
  const bad = [
    "region=eu",
    "season=season-mn-1",
    "season=season-mn-1&region=mars",
    "season=../etc/passwd&region=eu",
    "season=a&region=eu"
  ];
  for (const qs of bad) {
    const res = await handleRequest(get(qs), fakeStore());
    assert.equal(res.status, 400, `expected 400 for "${qs}"`);
  }
});

test("GET surfaces a storage failure as 502 rather than pretending it is empty", async () => {
  const store = fakeStore();
  store.failOn = "get";
  const res = await handleRequest(get("season=season-mn-1&region=eu"), store);
  assert.equal(res.status, 502);
});

/* ── The endpoint is read-only: no unauthenticated write path ───────────── */

test("POST is refused — there is no public write path", async () => {
  const store = fakeStore();
  const res = await handleRequest(post(REC), store);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
  assert.match((await res.json()).error, /read-only/i);
  assert.equal(store.writes, 0, "a POST reached storage");
});

test("no method other than GET or HEAD can write", async () => {
  const store = fakeStore();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = await handleRequest(
      new Request(URL_BASE, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "DELETE" ? undefined : JSON.stringify(REC)
      }),
      store
    );
    assert.equal(res.status, 405, `${method} was not refused`);
  }
  assert.equal(store.writes, 0);
  assert.equal(Object.keys(store.data).length, 0, "storage was touched");
});

test("HEAD is allowed alongside GET", async () => {
  const store = fakeStore();
  const res = await handleRequest(
    new Request(`${URL_BASE}?season=season-mn-1&region=eu`, { method: "HEAD" }),
    store
  );
  assert.equal(res.status, 200);
});

/* ── recordSnapshot: the duplicate guarantee, now writer-side only ──────── */

test("recordSnapshot inserts, and GET reads it back", async () => {
  const store = fakeStore();
  const out = await recordSnapshot(store, REC);
  assert.deepEqual(out, { ok: true, action: "inserted", changed: true, count: 1 });

  const body = await (await handleRequest(get("season=season-mn-1&region=eu"), store)).json();
  assert.equal(body.records.length, 1);
  assert.equal(body.records[0].p990, 3000);
  assert.equal(body.records[0].p999, 3500);
});

test("recording the same day twice updates in place — never a second record", async () => {
  const store = fakeStore();
  await recordSnapshot(store, REC);
  const out = await recordSnapshot(store, { ...REC, p990: 3050, p999: 3560 });

  assert.equal(out.action, "updated");
  assert.equal(out.count, 1, "a duplicate record was created");

  const body = await (await handleRequest(get("season=season-mn-1&region=eu"), store)).json();
  assert.equal(body.records.length, 1);
  assert.equal(body.records[0].p990, 3050, "the later value should win");
});

test("running the daily job ten times leaves one record and one write", async () => {
  const store = fakeStore();
  for (let i = 0; i < 10; i++) await recordSnapshot(store, REC);

  const body = await (await handleRequest(get("season=season-mn-1&region=eu"), store)).json();
  assert.equal(body.records.length, 1);
  assert.equal(store.writes, 1, "identical repeat runs should not churn storage");
});

test("an unchanged re-run reports changed:false", async () => {
  const store = fakeStore();
  await recordSnapshot(store, REC);
  const again = await recordSnapshot(store, REC);
  assert.equal(again.changed, false);
  assert.equal(again.count, 1);
});

test("consecutive days accumulate as separate records", async () => {
  const store = fakeStore();
  for (const date of ["2026-08-04", "2026-08-05", "2026-08-06"]) {
    await recordSnapshot(store, { ...REC, date });
  }
  const body = await (await handleRequest(get("season=season-mn-1&region=eu"), store)).json();
  assert.deepEqual(body.records.map((r) => r.date),
    ["2026-08-04", "2026-08-05", "2026-08-06"]);
});

/* ── Season and region never mix ────────────────────────────────────────── */

test("the same date in two seasons is stored separately", async () => {
  const store = fakeStore();
  await recordSnapshot(store, REC);
  await recordSnapshot(store, { ...REC, season: "season-tww-3", p990: 9 });

  const mn = await (await handleRequest(get("season=season-mn-1&region=eu"), store)).json();
  const tww = await (await handleRequest(get("season=season-tww-3&region=eu"), store)).json();

  assert.equal(mn.records[0].p990, 3000);
  assert.equal(tww.records[0].p990, 9);
});

test("the same date in two regions is stored separately", async () => {
  const store = fakeStore();
  await recordSnapshot(store, REC);
  await recordSnapshot(store, { ...REC, region: "us", p990: 7 });

  const eu = await (await handleRequest(get("season=season-mn-1&region=eu"), store)).json();
  const us = await (await handleRequest(get("season=season-mn-1&region=us"), store)).json();

  assert.equal(eu.records[0].p990, 3000);
  assert.equal(us.records[0].p990, 7);
  assert.equal(Object.keys(store.data).length, 2, "regions shared a bucket");
});

/* ── recordSnapshot validation ──────────────────────────────────────────── */

test("recordSnapshot rejects unusable records without writing anything", async () => {
  const store = fakeStore();
  const bad = [
    null,
    {},
    { date: "06/08/2026", p990: 3000, season: "season-mn-1", region: "eu" },
    { date: "2026-08-06", season: "season-mn-1", region: "eu" },
    { ...REC, region: "mars" },
    { ...REC, season: "x" }
  ];
  for (const raw of bad) {
    const out = await recordSnapshot(store, raw);
    assert.equal(out.ok, false, `should reject ${JSON.stringify(raw)}`);
    assert.ok(out.error);
  }
  assert.equal(store.writes, 0, "an invalid record reached storage");
});

test("recordSnapshot rejects implausible scores rather than poisoning history", async () => {
  const store = fakeStore();
  for (const bad of [{ p990: -5 }, { p999: 1e9 }]) {
    const out = await recordSnapshot(store, { ...REC, ...bad });
    assert.equal(out.ok, false);
  }
  assert.equal(store.writes, 0);
});

test("a null threshold is treated as absent, not as a cutoff of zero", async () => {
  const store = fakeStore();
  const out = await recordSnapshot(store, { ...REC, p999: null });
  assert.equal(out.ok, true);

  const body = await (await handleRequest(get("season=season-mn-1&region=eu"), store)).json();
  assert.equal(body.records[0].p990, 3000);
  assert.equal(body.records[0].p999, undefined, "null was stored as a real score");
});
