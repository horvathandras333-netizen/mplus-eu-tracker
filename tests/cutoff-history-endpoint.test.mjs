/* Tests for the snapshot endpoint, against an in-memory stand-in for Netlify
   Blobs. Covers the duplicate-write guarantee at the API layer. */
import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../netlify/functions/cutoff-history.mjs";

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

/* ── POST: the duplicate guarantee ──────────────────────────────────────── */

test("POST records a snapshot and GET reads it back", async () => {
  const store = fakeStore();

  const write = await handleRequest(post(REC), store);
  assert.equal(write.status, 200);
  assert.deepEqual(await write.json(), {
    ok: true, action: "inserted", changed: true, count: 1
  });

  const read = await handleRequest(get("season=season-mn-1&region=eu"), store);
  const body = await read.json();
  assert.equal(body.records.length, 1);
  assert.equal(body.records[0].p990, 3000);
  assert.equal(body.records[0].p999, 3500);
});

test("posting the same day twice updates in place — never a second record", async () => {
  const store = fakeStore();
  await handleRequest(post(REC), store);
  const res = await handleRequest(post({ ...REC, p990: 3050, p999: 3560 }), store);

  const body = await res.json();
  assert.equal(body.action, "updated");
  assert.equal(body.count, 1, "a duplicate record was created");

  const read = await handleRequest(get("season=season-mn-1&region=eu"), store);
  const stored = (await read.json()).records;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].p990, 3050, "the later value should win");
});

test("running the daily snapshot ten times leaves one record and nine no-op writes", async () => {
  const store = fakeStore();
  for (let i = 0; i < 10; i++) await handleRequest(post(REC), store);

  const read = await handleRequest(get("season=season-mn-1&region=eu"), store);
  assert.equal((await read.json()).records.length, 1);
  assert.equal(store.writes, 1,
    "identical repeat posts should not churn the blob store");
});

test("an unchanged repost reports changed:false", async () => {
  const store = fakeStore();
  await handleRequest(post(REC), store);
  const again = await handleRequest(post(REC), store);
  const body = await again.json();
  assert.equal(body.changed, false);
  assert.equal(body.count, 1);
});

test("consecutive days accumulate as separate records", async () => {
  const store = fakeStore();
  for (const date of ["2026-08-04", "2026-08-05", "2026-08-06"]) {
    await handleRequest(post({ ...REC, date }), store);
  }
  const body = await (await handleRequest(get("season=season-mn-1&region=eu"), store)).json();
  assert.deepEqual(body.records.map((r) => r.date),
    ["2026-08-04", "2026-08-05", "2026-08-06"]);
});

/* ── POST: season and region never mix ──────────────────────────────────── */

test("the same date in two seasons is stored separately", async () => {
  const store = fakeStore();
  await handleRequest(post(REC), store);
  await handleRequest(post({ ...REC, season: "season-tww-3", p990: 9 }), store);

  const mn = await (await handleRequest(get("season=season-mn-1&region=eu"), store)).json();
  const tww = await (await handleRequest(get("season=season-tww-3&region=eu"), store)).json();

  assert.equal(mn.records.length, 1);
  assert.equal(tww.records.length, 1);
  assert.equal(mn.records[0].p990, 3000);
  assert.equal(tww.records[0].p990, 9);
});

test("the same date in two regions is stored separately", async () => {
  const store = fakeStore();
  await handleRequest(post(REC), store);
  await handleRequest(post({ ...REC, region: "us", p990: 7 }), store);

  const eu = await (await handleRequest(get("season=season-mn-1&region=eu"), store)).json();
  const us = await (await handleRequest(get("season=season-mn-1&region=us"), store)).json();

  assert.equal(eu.records[0].p990, 3000);
  assert.equal(us.records[0].p990, 7);
  assert.equal(Object.keys(store.data).length, 2, "regions shared a bucket");
});

/* ── POST: validation ───────────────────────────────────────────────────── */

test("POST rejects unusable bodies without writing anything", async () => {
  const store = fakeStore();
  const bad = [
    "not json at all",
    JSON.stringify({}),
    JSON.stringify({ date: "06/08/2026", p990: 3000, season: "season-mn-1", region: "eu" }),
    JSON.stringify({ date: "2026-08-06", season: "season-mn-1", region: "eu" }),
    JSON.stringify({ ...REC, region: "mars" }),
    JSON.stringify({ ...REC, season: "x" })
  ];
  for (const body of bad) {
    const res = await handleRequest(post(body), store);
    assert.equal(res.status, 400, `expected 400 for ${body.slice(0, 60)}`);
  }
  assert.equal(store.writes, 0, "an invalid post reached storage");
});

test("POST rejects implausible scores rather than poisoning the history", async () => {
  const store = fakeStore();
  for (const bad of [{ p990: -5 }, { p999: 1e9 }]) {
    const res = await handleRequest(post({ ...REC, ...bad }), store);
    assert.equal(res.status, 400);
  }
  assert.equal(store.writes, 0);
});

test("a null threshold is treated as absent, not as a cutoff of zero", async () => {
  const store = fakeStore();
  const res = await handleRequest(post({ ...REC, p999: null }), store);
  assert.equal(res.status, 200);

  const body = await (await handleRequest(get("season=season-mn-1&region=eu"), store)).json();
  assert.equal(body.records[0].p990, 3000);
  assert.equal(body.records[0].p999, undefined, "null was stored as a real score");
});

test("POST surfaces a storage write failure as 502", async () => {
  const store = fakeStore();
  store.failOn = "set";
  const res = await handleRequest(post(REC), store);
  assert.equal(res.status, 502);
});

/* ── Other methods ──────────────────────────────────────────────────────── */

test("unsupported methods are refused", async () => {
  for (const method of ["DELETE", "PUT", "PATCH"]) {
    const res = await handleRequest(new Request(URL_BASE, { method }), fakeStore());
    assert.equal(res.status, 405);
  }
});
