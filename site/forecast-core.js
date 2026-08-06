/* ═══════════════════════════════════════════════════════════════════════════
   forecast-core.js — pure forecast maths for the Cutoff Forecast section.

   No DOM, no network, no globals beyond the single export. Loadable both as a
   browser script (window.ForecastCore) and as a CommonJS module (tests, and
   the Netlify functions via esbuild's CJS interop).

   Nothing in this file touches the existing tracker.
   ═══════════════════════════════════════════════════════════════════════════ */
;(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ForecastCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ── Tunable constants (documented in the methodology panel) ─────────────── */
  var TARGET_DATE     = "2026-08-11"; // season-end date we forecast towards
  var MS_DAY          = 86400000;
  var HALF_LIFE_DAYS  = 3;    // weighted regression: weight halves every 3 days
  var RECENT_DAYS     = 3;    // "recent rate" look-back window
  var ACCEL_DAMPING   = 0.35; // we only trust a third of measured acceleration
  var Z_80            = 1.2816; // ~80% confidence band
  var MIN_POINTS_OK   = 4;    // below this we flag the forecast as unreliable
  var MIN_SPAN_OK     = 3;    // ...and below this many days of span

  /* Analysis window. Raider.IO publishes the full season, but M+ cutoffs climb
     steeply in the opening weeks and flatten badly by the end — fitting the
     whole season triples the apparent rate. Only the trailing window is used;
     the rest is still counted and reported as available. */
  var ANALYSIS_WINDOW_DAYS = 21;

  /* Blend weights for the three rate estimators. Sum to 1. */
  var W_WEIGHTED = 0.45;
  var W_OLS      = 0.30;
  var W_RECENT   = 0.25;

  /* ── Date helpers — everything is UTC so day keys never shift by timezone ── */

  function dayNumber(dateStr) {
    var t = Date.parse(String(dateStr).slice(0, 10) + "T00:00:00Z");
    return Number.isNaN(t) ? NaN : Math.round(t / MS_DAY);
  }

  function dateFromDayNumber(n) {
    return new Date(n * MS_DAY).toISOString().slice(0, 10);
  }

  function isValidDate(dateStr) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr)) && !Number.isNaN(dayNumber(dateStr));
  }

  /* ── Cleaning ────────────────────────────────────────────────────────────── */

  /**
   * Parse a score, or null when absent. Number(null) and Number("") are both 0,
   * which would otherwise plot a missing threshold as a cutoff of zero.
   */
  function score(v) {
    if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Normalise a raw series into ascending, de-duplicated, numeric points.
   * Later entries win on a duplicate date, matching the storage layer's upsert.
   */
  function cleanSeries(points) {
    var byDate = Object.create(null);
    (points || []).forEach(function (p) {
      if (!p || !isValidDate(p.date)) return;
      var v = score(p.value);
      if (v === null) return;
      byDate[String(p.date).slice(0, 10)] = v;
    });
    return Object.keys(byDate)
      .sort()
      .map(function (d) { return { date: d, value: byDate[d] }; });
  }

  /* ── Regression primitives ───────────────────────────────────────────────── */

  /**
   * Weighted least squares of y on x. Pass weights of 1 for ordinary OLS.
   * Returns null when the x values are degenerate (no spread).
   */
  function leastSquares(xs, ys, ws) {
    var n = xs.length;
    if (n < 2) return null;
    var Sw = 0, Swx = 0, Swy = 0, Swxx = 0, Swxy = 0;
    for (var i = 0; i < n; i++) {
      var w = ws ? ws[i] : 1;
      Sw += w; Swx += w * xs[i]; Swy += w * ys[i];
      Swxx += w * xs[i] * xs[i]; Swxy += w * xs[i] * ys[i];
    }
    var denom = Sw * Swxx - Swx * Swx;
    if (Math.abs(denom) < 1e-12) return null;
    var slope = (Sw * Swxy - Swx * Swy) / denom;
    var intercept = (Swy - slope * Swx) / Sw;

    /* r² and residual standard error, both unweighted so they describe the
       actual scatter of the recorded data rather than the weighting scheme. */
    var meanY = ys.reduce(function (a, b) { return a + b; }, 0) / n;
    var ssTot = 0, ssRes = 0;
    for (var j = 0; j < n; j++) {
      var pred = intercept + slope * xs[j];
      ssTot += (ys[j] - meanY) * (ys[j] - meanY);
      ssRes += (ys[j] - pred) * (ys[j] - pred);
    }
    return {
      slope: slope,
      intercept: intercept,
      r2: ssTot > 1e-12 ? 1 - ssRes / ssTot : 1,
      se: n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0
    };
  }

  function stdev(values) {
    var n = values.length;
    if (n < 2) return 0;
    var mean = values.reduce(function (a, b) { return a + b; }, 0) / n;
    var v = values.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (n - 1);
    return Math.sqrt(v);
  }

  /** Average daily rate between the first and last point of a slice. */
  function rateOver(slice) {
    if (!slice || slice.length < 2) return null;
    var first = slice[0], last = slice[slice.length - 1];
    var days = dayNumber(last.date) - dayNumber(first.date);
    if (days <= 0) return null;
    return (last.value - first.value) / days;
  }

  /* ── Main analysis ───────────────────────────────────────────────────────── */

  /**
   * Forecast a single threshold series towards the target date.
   *
   * @param {Array<{date:string,value:number}>} rawPoints recorded snapshots
   * @param {{targetDate?:string, today?:string}} [options]
   * @returns {object} analysis — always returns, never throws
   */
  function analyseSeries(rawPoints, options) {
    var opts = options || {};
    var targetDate = opts.targetDate || TARGET_DATE;
    var all = cleanSeries(rawPoints);

    /* Trim to the trailing analysis window. `windowDays: 0` disables it. */
    var windowDays = opts.windowDays === undefined ? ANALYSIS_WINDOW_DAYS : opts.windowDays;
    var points = all;
    if (windowDays && all.length) {
      var cutoffDay = dayNumber(all[all.length - 1].date) - windowDays;
      var trimmed = all.filter(function (p) { return dayNumber(p.date) >= cutoffDay; });
      if (trimmed.length >= 2) points = trimmed;
    }

    var n = points.length;
    var targetDay = dayNumber(targetDate);

    var base = {
      targetDate: targetDate,
      points: points,
      n: n,
      nAvailable: all.length,
      windowDays: windowDays,
      sufficient: false,
      warnings: [],
      projection: []
    };

    if (n === 0) {
      base.status = "empty";
      base.warnings.push("No snapshots recorded yet.");
      return base;
    }

    var days = points.map(function (p) { return dayNumber(p.date); });
    var firstDay = days[0];
    var lastDay = days[n - 1];
    var xs = days.map(function (d) { return d - firstDay; });
    var ys = points.map(function (p) { return p.value; });
    var spanDays = lastDay - firstDay;
    var current = ys[n - 1];
    var daysRemaining = Math.max(0, targetDay - lastDay);

    base.current = current;
    base.currentDate = points[n - 1].date;
    base.firstDate = points[0].date;
    base.spanDays = spanDays;
    base.daysRemaining = daysRemaining;

    /* A single point tells us a level but no rate — report it honestly. */
    if (n === 1) {
      base.status = "insufficient";
      base.warnings.push(
        "Only one snapshot recorded — a trend needs at least two days of data."
      );
      base.predicted = current;
      base.increase = 0;
      base.low = current;
      base.high = current;
      return base;
    }

    /* — Three independent estimates of the daily rate of increase — */

    var avgDaily = spanDays > 0 ? (current - ys[0]) / spanDays : 0;

    /* Recent: the last RECENT_DAYS of span, widened to two points if sparse. */
    var recentSlice = points.filter(function (p) {
      return dayNumber(p.date) >= lastDay - RECENT_DAYS;
    });
    if (recentSlice.length < 2) recentSlice = points.slice(-2);
    var recentDaily = rateOver(recentSlice);
    if (recentDaily === null) recentDaily = avgDaily;

    /* Early: the first half of the span, for the acceleration comparison. */
    var earlySlice = points.filter(function (p) {
      return dayNumber(p.date) <= firstDay + Math.max(1, spanDays / 2);
    });
    if (earlySlice.length < 2) earlySlice = points.slice(0, 2);
    var earlyDaily = rateOver(earlySlice);
    if (earlyDaily === null) earlyDaily = avgDaily;

    var ols = leastSquares(xs, ys, null);

    /* Exponential recency weights — weight halves every HALF_LIFE_DAYS. */
    var weights = xs.map(function (x) {
      return Math.pow(0.5, (spanDays - x) / HALF_LIFE_DAYS);
    });
    var weighted = leastSquares(xs, ys, weights);

    var olsSlope = ols ? ols.slope : avgDaily;
    var wSlope = weighted ? weighted.slope : olsSlope;

    var blendedRate = W_WEIGHTED * wSlope + W_OLS * olsSlope + W_RECENT * recentDaily;
    if (!Number.isFinite(blendedRate)) blendedRate = avgDaily;

    /* — Acceleration: is the climb speeding up or flattening out? — */
    var earlyMid = (dayNumber(earlySlice[0].date) +
                    dayNumber(earlySlice[earlySlice.length - 1].date)) / 2;
    var recentMid = (dayNumber(recentSlice[0].date) +
                     dayNumber(recentSlice[recentSlice.length - 1].date)) / 2;
    var midGap = Math.max(1, recentMid - earlyMid);
    var accelPerDay = (recentDaily - earlyDaily) / midGap;
    if (!Number.isFinite(accelPerDay)) accelPerDay = 0;

    var accelThreshold = Math.max(0.5, Math.abs(blendedRate) * 0.05);
    var trend = accelPerDay > accelThreshold ? "accelerating"
              : accelPerDay < -accelThreshold ? "slowing"
              : "steady";

    /* — Projection: accumulate day by day, applying damped acceleration — */
    var maxRate = Math.max(Math.abs(blendedRate) * 2, Math.abs(recentDaily) * 2, 1);
    var projection = [];
    var running = current;
    for (var d = 1; d <= daysRemaining; d++) {
      var rate = blendedRate + accelPerDay * ACCEL_DAMPING * d;
      /* Cutoffs are non-decreasing in practice, and no single day plausibly
         doubles the observed pace — clamp to keep long horizons sane. */
      rate = Math.min(Math.max(rate, 0), maxRate);
      running += rate;
      projection.push({ date: dateFromDayNumber(lastDay + d), value: running });
    }
    var predicted = running;
    var increase = predicted - current;

    /* — Confidence band —
       Two sources of uncertainty, added: the scatter of the recorded points
       around the regression line (propagated over the horizon), and the
       disagreement between the three rate estimators. Small samples widen it. */
    var se = ols ? ols.se : 0;
    var scatter = Z_80 * se * Math.sqrt(Math.max(1, daysRemaining));
    var disagreement = stdev([olsSlope, wSlope, recentDaily]) * daysRemaining;
    var smallSamplePenalty = 1 + 2 / n;
    var band = (scatter + disagreement) * smallSamplePenalty;
    if (!Number.isFinite(band) || band < 0) band = 0;

    /* Uncertainty floor. A handful of points that happen to fall on a straight
       line produce se = 0 and no estimator disagreement, which would advertise
       a single exact number — most misleadingly with the two points where we
       know least. Cutoffs are never that well behaved, so the band can never
       be narrower than this fraction of the move being predicted. */
    var floorFrac = Math.min(0.6, Math.max(0.08, 0.5 / Math.sqrt(Math.max(1, n - 1))));
    band = Math.max(band, floorFrac * Math.abs(increase));

    var low = Math.max(current, predicted - band);
    var high = predicted + band;

    /* Band on the projection path, widening with the horizon. */
    projection.forEach(function (p, i) {
      var frac = daysRemaining > 0 ? (i + 1) / daysRemaining : 1;
      var w = band * frac;
      p.low = Math.max(current, p.value - w);
      p.high = p.value + w;
    });

    /* — Reliability — */
    var gaps = [];
    for (var g = 1; g < n; g++) {
      var gap = days[g] - days[g - 1];
      if (gap > 2) gaps.push(gap);
    }

    if (n < MIN_POINTS_OK) {
      base.warnings.push(
        "Only " + n + " snapshots recorded — at least " + MIN_POINTS_OK +
        " are needed before this forecast is dependable."
      );
    }
    if (spanDays < MIN_SPAN_OK) {
      base.warnings.push(
        "Data covers just " + spanDays + " day" + (spanDays === 1 ? "" : "s") +
        " — short spans exaggerate whatever the last day happened to do."
      );
    }
    if (gaps.length) {
      base.warnings.push(
        "There " + (gaps.length === 1 ? "is a gap" : "are gaps") +
        " in the record (largest " + Math.max.apply(null, gaps) +
        " days) — missed days are interpolated by the trend, not measured."
      );
    }
    if (daysRemaining === 0) {
      base.warnings.push("The target date has been reached — no forecast horizon remains.");
    }

    base.status = "ok";
    base.sufficient = n >= MIN_POINTS_OK && spanDays >= MIN_SPAN_OK;
    base.avgDaily = avgDaily;
    base.recentDaily = recentDaily;
    base.earlyDaily = earlyDaily;
    base.regression = ols || { slope: avgDaily, intercept: ys[0], r2: 0, se: 0 };
    base.weightedSlope = wSlope;
    base.blendedRate = blendedRate;
    base.accelPerDay = accelPerDay;
    base.trend = trend;
    base.predicted = predicted;
    base.increase = increase;
    base.low = low;
    base.high = high;
    base.band = band;
    base.bandFloorFrac = floorFrac;
    base.projection = projection;
    return base;
  }

  /**
   * Convenience wrapper: analyse both thresholds from a snapshot list.
   * @param {Array<{date:string,p990:number,p999:number}>} snapshots
   */
  function analyseSnapshots(snapshots, options) {
    var list = snapshots || [];
    var pick = function (key) {
      return list
        .filter(function (row) { return row && score(row[key]) !== null; })
        .map(function (row) { return { date: row.date, value: score(row[key]) }; });
    };
    return {
      p990: analyseSeries(pick("p990"), options),
      p999: analyseSeries(pick("p999"), options)
    };
  }

  return {
    TARGET_DATE: TARGET_DATE,
    HALF_LIFE_DAYS: HALF_LIFE_DAYS,
    RECENT_DAYS: RECENT_DAYS,
    ACCEL_DAMPING: ACCEL_DAMPING,
    MIN_POINTS_OK: MIN_POINTS_OK,
    MIN_SPAN_OK: MIN_SPAN_OK,
    ANALYSIS_WINDOW_DAYS: ANALYSIS_WINDOW_DAYS,
    dayNumber: dayNumber,
    dateFromDayNumber: dateFromDayNumber,
    isValidDate: isValidDate,
    score: score,
    cleanSeries: cleanSeries,
    leastSquares: leastSquares,
    analyseSeries: analyseSeries,
    analyseSnapshots: analyseSnapshots
  };
});
