/* ═══════════════════════════════════════════════════════════════════════════
   snapshot-store.js — pure snapshot record handling for the Cutoff Forecast.

   Owns the rules that keep the history honest:
     · one record per (season, region, date) — writing again updates in place
     · records for different seasons or regions never share a bucket
     · malformed records are dropped rather than stored

   Shared verbatim by the browser (localStorage tier) and the Netlify functions
   (Blobs tier) so both tiers cannot drift apart. No DOM, no network.
   ═══════════════════════════════════════════════════════════════════════════ */
;(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SnapshotStore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var KEY_PREFIX = "mplus-cutoff-history";
  var SCHEMA_VERSION = 1;

  /** Storage key for a season+region bucket. Seasons/regions can never mix. */
  function bucketKey(season, region) {
    return KEY_PREFIX + ":" + normaliseSeason(season) + ":" + normaliseRegion(region);
  }

  function normaliseSeason(season) {
    return String(season || "unknown").trim().toLowerCase();
  }

  function normaliseRegion(region) {
    return String(region || "unknown").trim().toLowerCase();
  }

  /** UTC day key, so a visitor's timezone can never split one day into two. */
  function todayKey(now) {
    var d = now instanceof Date ? now : (now ? new Date(now) : new Date());
    return d.toISOString().slice(0, 10);
  }

  function isValidDate(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return false;
    return !Number.isNaN(Date.parse(String(dateStr) + "T00:00:00Z"));
  }

  /**
   * Parse a threshold value, or null when it is absent or unusable.
   * Guards the Number() traps: Number(null) and Number("") are both 0, which
   * would otherwise store a cutoff of zero for a threshold we simply lack.
   */
  function score(v) {
    if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Coerce an arbitrary object into a storable record, or null if unusable.
   * A record with neither threshold present carries no information — dropped.
   */
  function normaliseRecord(raw) {
    if (!raw || typeof raw !== "object") return null;
    var date = String(raw.date || "").slice(0, 10);
    if (!isValidDate(date)) return null;

    var p990 = score(raw.p990);
    var p999 = score(raw.p999);
    var has990 = p990 !== null;
    var has999 = p999 !== null;
    if (!has990 && !has999) return null;

    var rec = {
      date: date,
      season: normaliseSeason(raw.season),
      region: normaliseRegion(raw.region)
    };
    if (has990) rec.p990 = p990;
    if (has999) rec.p999 = p999;
    rec.updatedAt = raw.updatedAt || new Date().toISOString();
    if (raw.source) rec.source = String(raw.source);
    return rec;
  }

  function sortByDate(list) {
    return list.slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
  }

  /**
   * Insert or update a record. Never appends a second row for a date that is
   * already present — this is what makes the daily snapshot safe to run any
   * number of times per day.
   *
   * Returns a NEW list; the input is not mutated.
   */
  function upsert(list, raw) {
    var rec = normaliseRecord(raw);
    if (!rec) return { list: sortByDate((list || []).slice()), changed: false, action: "rejected" };

    var out = (list || []).slice();
    var idx = -1;
    for (var i = 0; i < out.length; i++) {
      if (out[i] && out[i].date === rec.date) { idx = i; break; }
    }

    if (idx === -1) {
      out.push(rec);
      return { list: sortByDate(out), changed: true, action: "inserted" };
    }

    /* Update in place, keeping any threshold the new record does not carry. */
    var prev = out[idx];
    var merged = {
      date: rec.date,
      season: rec.season,
      region: rec.region,
      updatedAt: rec.updatedAt
    };
    if (Number.isFinite(rec.p990)) merged.p990 = rec.p990;
    else if (Number.isFinite(prev.p990)) merged.p990 = prev.p990;
    if (Number.isFinite(rec.p999)) merged.p999 = rec.p999;
    else if (Number.isFinite(prev.p999)) merged.p999 = prev.p999;
    if (rec.source) merged.source = rec.source;
    else if (prev.source) merged.source = prev.source;

    var changed = merged.p990 !== prev.p990 || merged.p999 !== prev.p999;
    out[idx] = merged;
    return { list: sortByDate(out), changed: changed, action: "updated" };
  }

  /**
   * Merge two lists (e.g. server history + locally recorded days).
   * `primary` wins on a shared date — callers pass the server list as primary.
   */
  function merge(primary, secondary) {
    var out = [];
    (secondary || []).forEach(function (r) { out = upsert(out, r).list; });
    (primary || []).forEach(function (r) { out = upsert(out, r).list; });
    return sortByDate(out);
  }

  /** Defensive filter — belt and braces on top of per-bucket key separation. */
  function filterSeasonRegion(list, season, region) {
    var s = normaliseSeason(season), r = normaliseRegion(region);
    return sortByDate((list || []).filter(function (rec) {
      return rec && normaliseSeason(rec.season) === s && normaliseRegion(rec.region) === r;
    }));
  }

  /** Drop every record older than `days` before `endDate` (inclusive window). */
  function trimTo(list, days, endDate) {
    var end = Date.parse((endDate || todayKey()) + "T00:00:00Z");
    var cutoff = end - (days - 1) * 86400000;
    return sortByDate((list || []).filter(function (rec) {
      return Date.parse(rec.date + "T00:00:00Z") >= cutoff;
    }));
  }

  /** Parse a stored payload of any vintage into a plain record list. */
  function parse(payload) {
    if (!payload) return [];
    var data = payload;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { return []; }
    }
    var list = Array.isArray(data) ? data
             : Array.isArray(data.records) ? data.records
             : [];
    return sortByDate(list.map(normaliseRecord).filter(Boolean));
  }

  /** Wrap a record list in the stored envelope. */
  function serialise(list, season, region) {
    return {
      version: SCHEMA_VERSION,
      season: normaliseSeason(season),
      region: normaliseRegion(region),
      updatedAt: new Date().toISOString(),
      records: sortByDate(list || [])
    };
  }

  return {
    KEY_PREFIX: KEY_PREFIX,
    SCHEMA_VERSION: SCHEMA_VERSION,
    bucketKey: bucketKey,
    todayKey: todayKey,
    isValidDate: isValidDate,
    normaliseRecord: normaliseRecord,
    normaliseSeason: normaliseSeason,
    normaliseRegion: normaliseRegion,
    score: score,
    sortByDate: sortByDate,
    upsert: upsert,
    merge: merge,
    filterSeasonRegion: filterSeasonRegion,
    trimTo: trimTo,
    parse: parse,
    serialise: serialise
  };
});
