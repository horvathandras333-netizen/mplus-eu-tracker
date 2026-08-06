/* Tests for the forecast maths. Node's built-in runner — no dependencies. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Core = require("../site/forecast-core.js");

const TARGET = "2026-08-11";

/** Build a dated series ending on `end`, one point per day, from `values`. */
function series(values, end = "2026-08-06") {
  const endDay = Core.dayNumber(end);
  return values.map((value, i) => ({
    date: Core.dateFromDayNumber(endDay - (values.length - 1 - i)),
    value
  }));
}

/* ── Date helpers ───────────────────────────────────────────────────────── */

test("dayNumber and dateFromDayNumber round-trip in UTC", () => {
  assert.equal(Core.dateFromDayNumber(Core.dayNumber("2026-08-06")), "2026-08-06");
  assert.equal(Core.dayNumber("2026-08-11") - Core.dayNumber("2026-08-06"), 5);
});

test("isValidDate rejects malformed input", () => {
  assert.ok(Core.isValidDate("2026-08-06"));
  assert.ok(!Core.isValidDate("06/08/2026"));
  assert.ok(!Core.isValidDate("2026-8-6"));
  assert.ok(!Core.isValidDate(""));
  assert.ok(!Core.isValidDate(null));
});

/* ── Cleaning ───────────────────────────────────────────────────────────── */

test("cleanSeries sorts, drops junk, and de-duplicates by date (last wins)", () => {
  const cleaned = Core.cleanSeries([
    { date: "2026-08-03", value: 300 },
    { date: "2026-08-01", value: 100 },
    { date: "2026-08-02", value: "not a number" },
    { date: "bad-date", value: 999 },
    null,
    { date: "2026-08-01", value: 150 }
  ]);
  assert.deepEqual(cleaned, [
    { date: "2026-08-01", value: 150 },
    { date: "2026-08-03", value: 300 }
  ]);
});

/* ── Regression primitives ──────────────────────────────────────────────── */

test("leastSquares recovers a known slope exactly", () => {
  const fit = Core.leastSquares([0, 1, 2, 3], [10, 20, 30, 40], null);
  assert.ok(Math.abs(fit.slope - 10) < 1e-9);
  assert.ok(Math.abs(fit.intercept - 10) < 1e-9);
  assert.ok(Math.abs(fit.r2 - 1) < 1e-9);
  assert.ok(fit.se < 1e-9);
});

test("leastSquares returns null when x has no spread", () => {
  assert.equal(Core.leastSquares([2, 2, 2], [1, 2, 3], null), null);
  assert.equal(Core.leastSquares([1], [1], null), null);
});

/* ── Degenerate inputs ──────────────────────────────────────────────────── */

test("empty history reports the empty state without throwing", () => {
  const a = Core.analyseSeries([], { targetDate: TARGET });
  assert.equal(a.status, "empty");
  assert.equal(a.n, 0);
  assert.equal(a.sufficient, false);
  assert.ok(a.warnings.length > 0);
  assert.deepEqual(a.projection, []);
});

test("a single snapshot warns and does not invent a trend", () => {
  const a = Core.analyseSeries(series([3000]), { targetDate: TARGET });
  assert.equal(a.status, "insufficient");
  assert.equal(a.n, 1);
  assert.equal(a.sufficient, false);
  assert.equal(a.predicted, 3000);
  assert.equal(a.increase, 0);
  assert.equal(a.low, 3000);
  assert.equal(a.high, 3000);
  assert.match(a.warnings.join(" "), /one snapshot/i);
});

/* ── Core forecasting behaviour ─────────────────────────────────────────── */

test("perfectly linear growth projects the exact slope over the horizon", () => {
  // 7 days ending 2026-08-06, +10/day. Target is 5 days later.
  const a = Core.analyseSeries(
    series([3000, 3010, 3020, 3030, 3040, 3050, 3060]),
    { targetDate: TARGET }
  );

  assert.equal(a.status, "ok");
  assert.equal(a.n, 7);
  assert.equal(a.spanDays, 6);
  assert.equal(a.daysRemaining, 5);
  assert.equal(a.current, 3060);
  assert.equal(a.sufficient, true);

  assert.ok(Math.abs(a.avgDaily - 10) < 1e-9);
  assert.ok(Math.abs(a.recentDaily - 10) < 1e-9);
  assert.ok(Math.abs(a.regression.slope - 10) < 1e-9);
  assert.ok(Math.abs(a.weightedSlope - 10) < 1e-9);
  assert.ok(Math.abs(a.blendedRate - 10) < 1e-9);

  assert.ok(Math.abs(a.increase - 50) < 1e-6, `increase was ${a.increase}`);
  assert.ok(Math.abs(a.predicted - 3110) < 1e-6);
  assert.equal(a.trend, "steady");
});

test("a perfect fit still carries an uncertainty floor, never an exact number", () => {
  // se = 0 and no estimator disagreement would otherwise advertise a single
  // exact value. Real cutoffs are never that well behaved.
  const a = Core.analyseSeries(
    series([3000, 3010, 3020, 3030, 3040, 3050, 3060]),
    { targetDate: TARGET }
  );
  assert.ok(a.band > 0, "band collapsed to zero on a perfect fit");
  assert.ok(a.low < a.predicted, "low bound equals the prediction");
  assert.ok(a.high > a.predicted, "high bound equals the prediction");
  // Floor is 0.5/sqrt(n-1) of the projected move, capped to [0.08, 0.6].
  const expected = (0.5 / Math.sqrt(6)) * a.increase;
  assert.ok(Math.abs(a.band - expected) < 1e-6, `band ${a.band} vs floor ${expected}`);
});

test("the thinnest data produces the widest band, not the narrowest", () => {
  // Two consistent points used to yield a zero-width range — maximum
  // confidence exactly where we know least.
  const two = Core.analyseSeries(series([3000, 3020]), { targetDate: TARGET });
  assert.ok(two.band > 0);
  assert.ok(two.high - two.low > two.increase * 0.5,
    "a two-point forecast must not look precise");
  assert.equal(two.sufficient, false);
});

test("the projection walks day by day to the target date", () => {
  const a = Core.analyseSeries(
    series([3000, 3010, 3020, 3030, 3040, 3050, 3060]),
    { targetDate: TARGET }
  );
  assert.equal(a.projection.length, 5);
  assert.equal(a.projection[0].date, "2026-08-07");
  assert.equal(a.projection[4].date, TARGET);
  assert.ok(Math.abs(a.projection[4].value - a.predicted) < 1e-9);
  // Strictly increasing, and each step carries a band.
  for (let i = 1; i < a.projection.length; i++) {
    assert.ok(a.projection[i].value >= a.projection[i - 1].value);
    assert.ok(a.projection[i].low <= a.projection[i].value);
    assert.ok(a.projection[i].high >= a.projection[i].value);
  }
});

test("accelerating growth is detected and pushes the forecast above the flat rate", () => {
  // Daily deltas 5, 6, 7, 8, 9, 10 — speeding up.
  const a = Core.analyseSeries(
    series([1000, 1005, 1011, 1018, 1026, 1035, 1045]),
    { targetDate: TARGET }
  );
  assert.equal(a.trend, "accelerating");
  assert.ok(a.accelPerDay > 0);
  assert.ok(a.recentDaily > a.earlyDaily);
  // Must beat the naive "average rate x days remaining" projection.
  assert.ok(a.increase > a.avgDaily * a.daysRemaining,
    `increase ${a.increase} should exceed avg-rate projection ${a.avgDaily * a.daysRemaining}`);
});

test("slowing growth is detected and pulls the forecast below the flat rate", () => {
  // Daily deltas 10, 9, 8, 7, 6, 5 — flattening out.
  const a = Core.analyseSeries(
    series([1000, 1010, 1019, 1027, 1034, 1040, 1045]),
    { targetDate: TARGET }
  );
  assert.equal(a.trend, "slowing");
  assert.ok(a.accelPerDay < 0);
  assert.ok(a.increase < a.avgDaily * a.daysRemaining,
    `increase ${a.increase} should undercut avg-rate projection ${a.avgDaily * a.daysRemaining}`);
});

test("recency weighting favours the recent pace over the long-run average", () => {
  // Flat for four days, then a sharp climb — the weighted slope must exceed OLS.
  const a = Core.analyseSeries(
    series([1000, 1000, 1000, 1000, 1020, 1045, 1075]),
    { targetDate: TARGET }
  );
  assert.ok(a.weightedSlope > a.regression.slope,
    `weighted ${a.weightedSlope} should exceed OLS ${a.regression.slope}`);
  assert.ok(a.recentDaily > a.avgDaily);
});

/* ── Guardrails ─────────────────────────────────────────────────────────── */

test("the forecast never predicts a cutoff below today's value", () => {
  // A decline should still clamp the projection to non-negative daily rates.
  const a = Core.analyseSeries(
    series([1100, 1090, 1080, 1070, 1060, 1050, 1040]),
    { targetDate: TARGET }
  );
  assert.ok(a.predicted >= a.current, `predicted ${a.predicted} < current ${a.current}`);
  assert.ok(a.low >= a.current, `low ${a.low} < current ${a.current}`);
});

test("no single projected day exceeds twice the observed pace", () => {
  const a = Core.analyseSeries(
    series([1000, 1002, 1006, 1014, 1030, 1062, 1126]), // doubling deltas
    { targetDate: TARGET }
  );
  const cap = Math.max(Math.abs(a.blendedRate) * 2, Math.abs(a.recentDaily) * 2, 1);
  let prev = a.current;
  for (const p of a.projection) {
    assert.ok(p.value - prev <= cap + 1e-9,
      `day step ${p.value - prev} exceeded cap ${cap}`);
    prev = p.value;
  }
});

test("confidence band is ordered and widens with the horizon", () => {
  const noisy = Core.analyseSeries(
    series([1000, 1014, 1019, 1041, 1044, 1067, 1071]),
    { targetDate: TARGET }
  );
  assert.ok(noisy.band > 0, "noisy data should produce a non-zero band");
  assert.ok(noisy.low <= noisy.predicted);
  assert.ok(noisy.high >= noisy.predicted);
  const widths = noisy.projection.map((p) => p.high - p.low);
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i] >= widths[i - 1] - 1e-9, "band should not narrow over time");
  }
});

test("fewer snapshots produce a wider band than the same trend with more", () => {
  const values = [1000, 1012, 1018, 1033, 1041, 1058, 1064];
  const few = Core.analyseSeries(series(values.slice(-3)), { targetDate: TARGET });
  const many = Core.analyseSeries(series(values), { targetDate: TARGET });
  assert.ok(few.n < many.n);
  assert.ok(few.band >= many.band * 0.999,
    `band with ${few.n} points (${few.band}) should not be tighter than with ${many.n} (${many.band})`);
});

/* ── Reliability signalling ─────────────────────────────────────────────── */

test("fewer than four snapshots is flagged as unreliable", () => {
  const a = Core.analyseSeries(series([3000, 3010, 3020]), { targetDate: TARGET });
  assert.equal(a.status, "ok");
  assert.equal(a.n, 3);
  assert.equal(a.sufficient, false);
  assert.match(a.warnings.join(" "), /snapshots recorded/i);
});

test("four snapshots across four days clears the reliability bar", () => {
  const a = Core.analyseSeries(series([3000, 3010, 3020, 3030]), { targetDate: TARGET });
  assert.equal(a.n, 4);
  assert.equal(a.spanDays, 3);
  assert.equal(a.sufficient, true);
  assert.deepEqual(a.warnings, []);
});

test("gaps in the record are reported rather than hidden", () => {
  const a = Core.analyseSeries([
    { date: "2026-07-27", value: 3000 },
    { date: "2026-08-02", value: 3060 }, // six-day hole
    { date: "2026-08-05", value: 3090 },
    { date: "2026-08-06", value: 3100 }
  ], { targetDate: TARGET });
  assert.match(a.warnings.join(" "), /gap/i);
  assert.match(a.warnings.join(" "), /interpolated by the trend, not measured/i);
});

test("reaching the target date leaves no horizon to forecast", () => {
  const a = Core.analyseSeries(
    series([3000, 3010, 3020, 3030, 3040, 3050, 3060], TARGET),
    { targetDate: TARGET }
  );
  assert.equal(a.daysRemaining, 0);
  assert.equal(a.projection.length, 0);
  assert.equal(a.increase, 0);
  assert.equal(a.predicted, a.current);
  assert.match(a.warnings.join(" "), /target date has been reached/i);
});

/* ── The deadline is the EU weekly reset, not a calendar day ────────────── */

test("the default target is the EU weekly reset: Wednesday 04:00 UTC", () => {
  assert.equal(Core.TARGET_INSTANT, "2026-08-12T04:00:00Z");
  assert.equal(Core.TARGET_DATE, "2026-08-12");
  const d = new Date(Core.TARGET_INSTANT);
  assert.equal(d.getUTCDay(), 3, "must fall on a Wednesday");
  assert.equal(d.getUTCHours(), 4, "EU reset is 05:00 CET = 04:00 UTC");
});

test("instantDays accepts a bare date or a full timestamp", () => {
  const midnight = Core.instantDays("2026-08-12");
  const reset = Core.instantDays("2026-08-12T04:00:00Z");
  assert.equal(midnight, Core.dayNumber("2026-08-12"));
  assert.ok(Math.abs(reset - midnight - 4 / 24) < 1e-9);
});

test("the horizon runs from the evening sample to the reset instant", () => {
  // Last reading 2026-08-06 at 21:00 UTC; reset 2026-08-12 04:00 UTC.
  // That is 5 days 7 hours = 5.29 days, not the 6.0 a midnight grid implies.
  const a = Core.analyseSeries(series([3940, 3946, 3950, 3956, 3959, 3966, 3973]), {
    lastSampleAt: Date.parse("2026-08-06T21:00:00Z")
  });
  assert.ok(Math.abs(a.daysRemaining - 5.2917) < 0.01,
    `daysRemaining was ${a.daysRemaining}`);
  assert.ok(a.daysRemaining < 6, "must not count a full extra day to midnight");
});

test("without a sample timestamp the horizon falls back to the date grid", () => {
  const a = Core.analyseSeries(series([3940, 3946, 3950, 3956, 3959, 3966, 3973]));
  assert.ok(Math.abs(a.daysRemaining - (6 + 4 / 24)) < 1e-6);
});

test("a nonsense sample timestamp is ignored rather than trusted", () => {
  const a = Core.analyseSeries(series([3000, 3010, 3020, 3030]), {
    lastSampleAt: Date.parse("2020-01-01T00:00:00Z")  // years off the last point
  });
  assert.ok(Math.abs(a.daysRemaining - (6 + 4 / 24)) < 1e-6,
    "should fall back to the date grid, not project across years");
});

test("the projection lands exactly on the reset, with a part-day final step", () => {
  const a = Core.analyseSeries(series([3940, 3946, 3950, 3956, 3959, 3966, 3973]), {
    lastSampleAt: Date.parse("2026-08-06T21:00:00Z")
  });
  const last = a.projection[a.projection.length - 1];
  assert.equal(a.projection.length, 6, "5 whole days plus a partial");
  assert.equal(last.isTarget, true);
  assert.equal(last.at, "2026-08-12T04:00:00.000Z");
  assert.ok(Math.abs(last.value - a.predicted) < 1e-9);

  // Whole-day steps, then a short one — never a step longer than a day.
  const steps = a.projection.map((p, i) =>
    i === 0 ? p.pos - Core.dayNumber(a.currentDate) : p.pos - a.projection[i - 1].pos);
  steps.forEach((s) => assert.ok(s > 0 && s <= 1 + 1e-9, `bad step ${s}`));
  assert.ok(steps[steps.length - 1] < 1, "final step should be a part day");
});

test("drawing positions stay anchored to the last plotted point", () => {
  // The dashed line must continue from the last dot, not jump to the sample
  // time — so the first projected position is exactly one day after it.
  const a = Core.analyseSeries(series([3940, 3946, 3950, 3956, 3959, 3966, 3973]), {
    lastSampleAt: Date.parse("2026-08-06T21:00:00Z")
  });
  assert.equal(a.projection[0].pos, Core.dayNumber("2026-08-06") + 1);
});

test("once the reset has passed there is nothing left to forecast", () => {
  const a = Core.analyseSeries(
    series([3940, 3946, 3950, 3956, 3959, 3966, 3973], "2026-08-13"),
    { lastSampleAt: Date.parse("2026-08-13T21:00:00Z") }
  );
  assert.equal(a.daysRemaining, 0);
  assert.equal(a.projection.length, 0);
  assert.equal(a.predicted, a.current);
  assert.match(a.warnings.join(" "), /target date has been reached/i);
});

/* ── Trailing analysis window ───────────────────────────────────────────── */

test("only the trailing window is fitted, and the rest is still counted", () => {
  const values = Array.from({ length: 60 }, (_, i) => 1000 + i * 5);
  const a = Core.analyseSeries(series(values), { targetDate: TARGET });
  assert.equal(a.nAvailable, 60, "the full record should be reported");
  assert.equal(a.windowDays, Core.ANALYSIS_WINDOW_DAYS);
  assert.equal(a.n, Core.ANALYSIS_WINDOW_DAYS + 1, "one point per day inside the window");
  assert.equal(a.firstDate, a.points[0].date);
});

test("a steep early season does not inflate a flat recent trend", () => {
  // 40 days climbing at +20/day, then 21 days flattening to +3/day —
  // the real shape of an M+ season. Fitting everything triples the rate.
  const values = [];
  let v = 1000;
  for (let i = 0; i < 40; i++) { values.push(v); v += 20; }
  for (let i = 0; i < 21; i++) { values.push(v); v += 3; }
  const input = series(values);

  const windowed = Core.analyseSeries(input, { targetDate: TARGET });
  const wholeSeason = Core.analyseSeries(input, { targetDate: TARGET, windowDays: 0 });

  assert.ok(Math.abs(windowed.blendedRate - 3) < 0.6,
    `windowed rate ${windowed.blendedRate} should track the recent +3/day`);
  assert.ok(wholeSeason.blendedRate > windowed.blendedRate * 2,
    "fitting the whole season should demonstrably overshoot");
  assert.ok(windowed.increase < wholeSeason.increase / 2);
});

test("windowDays: 0 disables trimming entirely", () => {
  const values = Array.from({ length: 40 }, (_, i) => 1000 + i * 5);
  const a = Core.analyseSeries(series(values), { targetDate: TARGET, windowDays: 0 });
  assert.equal(a.n, 40);
  assert.equal(a.nAvailable, 40);
});

test("a record shorter than the window is used in full", () => {
  const a = Core.analyseSeries(series([3000, 3010, 3020, 3030]), { targetDate: TARGET });
  assert.equal(a.n, 4);
  assert.equal(a.nAvailable, 4);
});

test("trimming never leaves fewer than two points", () => {
  // Two samples far apart: the window would strand a single point, so the
  // trim is skipped rather than destroying the trend.
  const a = Core.analyseSeries([
    { date: "2026-05-01", value: 3000 },
    { date: "2026-08-06", value: 3900 }
  ], { targetDate: TARGET });
  assert.equal(a.n, 2);
  assert.equal(a.status, "ok");
});

/* ── Determinism and the two-threshold wrapper ──────────────────────────── */

test("the same input always produces the same forecast", () => {
  const input = series([1000, 1011, 1019, 1034, 1042, 1059, 1066]);
  const a = Core.analyseSeries(input, { targetDate: TARGET });
  const b = Core.analyseSeries(input, { targetDate: TARGET });
  assert.equal(a.predicted, b.predicted);
  assert.equal(a.low, b.low);
  assert.equal(a.high, b.high);
});

test("analyseSnapshots forecasts both thresholds independently", () => {
  const snapshots = [
    { date: "2026-08-04", p990: 3000, p999: 3500, season: "season-mn-1", region: "eu" },
    { date: "2026-08-05", p990: 3010, p999: 3520, season: "season-mn-1", region: "eu" },
    { date: "2026-08-06", p990: 3020, p999: 3540, season: "season-mn-1", region: "eu" }
  ];
  const { p990, p999 } = Core.analyseSnapshots(snapshots, { targetDate: TARGET });
  assert.equal(p990.n, 3);
  assert.equal(p999.n, 3);
  assert.equal(p990.current, 3020);
  assert.equal(p999.current, 3540);
  assert.ok(p999.blendedRate > p990.blendedRate);
});

test("analyseSnapshots skips days where one threshold is missing", () => {
  const snapshots = [
    { date: "2026-08-04", p990: 3000, p999: 3500 },
    { date: "2026-08-05", p990: 3010 },            // p999 unavailable that day
    { date: "2026-08-06", p990: 3020, p999: 3540 }
  ];
  const { p990, p999 } = Core.analyseSnapshots(snapshots, { targetDate: TARGET });
  assert.equal(p990.n, 3);
  assert.equal(p999.n, 2);
  assert.equal(p999.current, 3540);
});

test("analyseSnapshots tolerates an undefined list", () => {
  const { p990, p999 } = Core.analyseSnapshots(undefined, { targetDate: TARGET });
  assert.equal(p990.status, "empty");
  assert.equal(p999.status, "empty");
});
