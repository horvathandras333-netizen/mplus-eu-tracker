/* ═══════════════════════════════════════════════════════════════════════════
   forecast.js — the Cutoff Forecast section.

   ISOLATION CONTRACT
   ------------------
   · Builds its own DOM and inserts it before <footer class="site-footer">.
     It never reads, writes or listens to any element the existing tracker owns.
   · Runs entirely inside an IIFE; the only global it touches is
     window.MPlusForecast (exposed for debugging).
   · Issues its own Raider.IO request rather than hooking the existing
     fetchCutoffs(), so the existing data flow is untouched.
   · If anything in here throws, the section simply fails to appear —
     the rest of the page is unaffected.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var Core = window.ForecastCore;
  var Store = window.SnapshotStore;
  if (!Core || !Store) return; // dependencies missing — stay out of the way

  /* ── Configuration (mirrors index.html rather than reaching into it) ────── */
  var REGION = "eu";
  var SEASONS = ["season-mn-1", "season-tww-3", "season-tww-2"];
  var TARGET_DATE = Core.TARGET_DATE;          // 2026-08-11
  var MIN_WINDOW_DAYS = 7;                     // today + the previous six days
  var FN_BASE = "/.netlify/functions";

  var SERIES = [
    { key: "p990", label: "Top 1%",   colorVar: "--fc-p990" },
    { key: "p999", label: "Top 0.1%", colorVar: "--fc-p999" }
  ];

  /* ── Tiny DOM helpers ───────────────────────────────────────────────────── */
  var SVG_NS = "http://www.w3.org/2000/svg";

  function h(tag, attrs, kids) {
    var node = document.createElement(tag);
    applyAttrs(node, attrs);
    appendKids(node, kids);
    return node;
  }
  function s(tag, attrs, kids) {
    var node = document.createElementNS(SVG_NS, tag);
    applyAttrs(node, attrs);
    appendKids(node, kids);
    return node;
  }
  function applyAttrs(node, attrs) {
    if (!attrs) return;
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else node.setAttribute(k, v);
    });
  }
  function appendKids(node, kids) {
    if (kids == null) return;
    (Array.isArray(kids) ? kids : [kids]).forEach(function (k) {
      if (k == null) return;
      node.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
    });
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* ── Formatting ─────────────────────────────────────────────────────────── */
  function fmtScore(v) {
    return Number.isFinite(v) ? Math.round(v).toLocaleString() : "—";
  }
  function fmtRate(v) {
    if (!Number.isFinite(v)) return "—";
    return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + " / day";
  }
  function fmtShortDate(dateStr) {
    var d = new Date(dateStr + "T00:00:00Z");
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  }
  function fmtLongDate(dateStr) {
    var d = new Date(dateStr + "T00:00:00Z");
    return d.toLocaleDateString(undefined, {
      weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
    });
  }

  /* ── Storage: localStorage tier ─────────────────────────────────────────── */
  function localRead(season, region) {
    try {
      return Store.parse(window.localStorage.getItem(Store.bucketKey(season, region)));
    } catch (e) { return []; }
  }
  function localWrite(season, region, list) {
    try {
      window.localStorage.setItem(
        Store.bucketKey(season, region),
        JSON.stringify(Store.serialise(list, season, region))
      );
      return true;
    } catch (e) { return false; }
  }

  /* ── Storage: Netlify function tier (absent on a drag-and-drop deploy) ──── */
  function serverRead(season, region) {
    var url = FN_BASE + "/cutoff-history?season=" + encodeURIComponent(season) +
              "&region=" + encodeURIComponent(region);
    return fetch(url, { headers: { accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) { return Store.parse(data); })
      .catch(function () { return null; }); // null = server tier unavailable
  }
  function serverWrite(record) {
    return fetch(FN_BASE + "/cutoff-history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record)
    }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  /* ── Raider.IO: published history ───────────────────────────────────────
     The season-cutoffs response carries a `graphData` block holding Raider.IO's
     own daily series for every percentile — the whole season, already recorded.
     That is the authoritative history; our snapshots are only a fallback for
     seasons or regions where it is absent. */
  function historyFromGraphData(cutoffs, season) {
    var graph = cutoffs && cutoffs.graphData;
    if (!graph) return [];

    var byDate = Object.create(null);
    SERIES.forEach(function (sr) {
      var block = graph[sr.key];
      var points = block && block.data;
      if (!Array.isArray(points)) return;
      points.forEach(function (p) {
        if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return;
        var date = new Date(Number(p.x)).toISOString().slice(0, 10);
        var row = byDate[date] || (byDate[date] = {
          date: date, season: season, region: REGION, source: "raider-graph"
        });
        /* Several samples can land on one UTC day; the latest wins, matching
           how the store de-duplicates. */
        row[sr.key] = Number(p.y);
      });
    });

    return Object.keys(byDate).sort().map(function (d) { return byDate[d]; });
  }

  /* ── Raider.IO: current cutoffs (independent of the existing fetch) ─────── */
  function fetchCurrentCutoffs() {
    var i = 0;
    function next() {
      if (i >= SEASONS.length) {
        return Promise.reject(new Error("No active season found"));
      }
      var slug = SEASONS[i++];
      return fetch("https://raider.io/api/v1/mythic-plus/season-cutoffs?season=" +
                   slug + "&region=" + REGION)
        .then(function (r) {
          if (r.status === 404) return next();
          if (!r.ok) throw new Error("Raider.IO returned HTTP " + r.status);
          return r.json().then(function (data) {
            var c = (data && data.cutoffs) || {};
            var p990 = c.p990 && c.p990.all && c.p990.all.quantileMinValue;
            var p999 = c.p999 && c.p999.all && c.p999.all.quantileMinValue;
            if (!Number.isFinite(Number(p990)) && !Number.isFinite(Number(p999))) {
              return next();
            }
            return {
              season: slug,
              region: REGION,
              p990: Number(p990),
              p999: Number(p999),
              updatedAt: c.updatedAt || null,
              history: historyFromGraphData(c, slug)
            };
          });
        });
    }
    return next();
  }

  /* ── Section scaffold ───────────────────────────────────────────────────── */
  var root = h("section", { id: "fc-forecast", "aria-labelledby": "fc-heading" });
  var head = h("div", { class: "fc-label", id: "fc-heading" }, [
    h("span", { text: "Cutoff Forecast" }),
    h("small", { class: "fc-head-note", html: '<span class="fc-spin"></span> Loading' })
  ]);
  var body = h("div", { class: "fc-body" });
  root.appendChild(head);
  root.appendChild(body);

  function setHeadNote(html) {
    var el = root.querySelector(".fc-head-note");
    if (el) el.innerHTML = html;
  }

  function mount() {
    var footer = document.querySelector("footer.site-footer");
    if (footer && footer.parentNode) footer.parentNode.insertBefore(root, footer);
    else document.body.appendChild(root);
  }

  /* ── States ─────────────────────────────────────────────────────────────── */
  function renderLoading() {
    clear(body);
    body.appendChild(h("div", { class: "fc-cards" }, [
      h("div", { class: "fc-skeleton fc-skeleton-card" }),
      h("div", { class: "fc-skeleton fc-skeleton-card" })
    ]));
    body.appendChild(h("div", { class: "fc-skeleton fc-skeleton-chart" }));
  }

  function renderEmpty(season, wroteToday) {
    clear(body);
    setHeadNote("no history yet");
    body.appendChild(h("div", { class: "fc-state" }, [
      h("div", {
        class: "fc-state-title",
        text: wroteToday ? "Recording starts today" : "No snapshots stored yet"
      }),
      h("div", {
        html: "Raider.IO publishes only the <em>current</em> cutoff — it keeps no history, " +
              "so past days cannot be recovered." +
              (wroteToday
                ? " This page has just recorded its first snapshot for <strong>" +
                  escapeHtml(season) + "</strong> (" + REGION.toUpperCase() + ").<br>" +
                  "Come back tomorrow and the trend line begins; the forecast becomes " +
                  "dependable at " + Core.MIN_POINTS_OK + " snapshots."
                : " Nothing is on record for <strong>" + escapeHtml(season) + "</strong> (" +
                  REGION.toUpperCase() + ") yet. If this browser blocks site storage, " +
                  "snapshots cannot be kept here — the shared snapshot service, once " +
                  "deployed, records them regardless.")
      })
    ]));
  }

  function renderError(message, onRetry) {
    clear(body);
    setHeadNote("unavailable");
    var btn = h("button", { class: "fc-state-retry", type: "button", text: "Try again" });
    btn.addEventListener("click", onRetry);
    body.appendChild(h("div", { class: "fc-state" }, [
      h("div", { class: "fc-state-title", text: "Forecast unavailable" }),
      h("div", { text: message }),
      h("div", { text: "The rest of this page is unaffected." }),
      btn
    ]));
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ── Prediction cards ───────────────────────────────────────────────────── */
  function buildCard(series, analysis) {
    var ok = analysis.status === "ok";
    var rows = [];

    rows.push(row("Today (" + fmtShortDate(analysis.currentDate || Store.todayKey()) + ")",
                  fmtScore(analysis.current)));
    rows.push(row("Expected increase",
                  ok ? "+" + fmtScore(analysis.increase) + " pts" : "—"));
    rows.push(row("Forecast range",
                  ok ? fmtScore(analysis.low) + " – " + fmtScore(analysis.high) : "—"));
    rows.push(row("Blended daily rate", ok ? fmtRate(analysis.blendedRate) : "—"));
    rows.push(row("Recent rate (" + Core.RECENT_DAYS + "d)", ok ? fmtRate(analysis.recentDaily) : "—"));

    var trendCell = h("span", {
      class: "fc-v fc-trend", "data-trend": ok ? analysis.trend : "steady",
      text: ok ? analysis.trend.charAt(0).toUpperCase() + analysis.trend.slice(1) : "—"
    });
    rows.push(h("div", { class: "fc-row" }, [
      h("span", { class: "fc-k", text: "Growth trend" }), trendCell
    ]));
    rows.push(row(
      "Data points used",
      analysis.nAvailable > analysis.n
        ? analysis.n + " of " + analysis.nAvailable
        : String(analysis.n)
    ));

    return h("div", { class: "fc-card", "data-series": series.key }, [
      h("div", { class: "fc-card-stripe" }),
      h("div", { class: "fc-card-head" }, [
        h("div", { class: "fc-card-title", text: series.label }),
        h("div", { class: "fc-tag", text: "Estimate" })
      ]),
      h("div", { class: "fc-card-val" }, [
        h("span", { class: "fc-approx", text: "≈" }),
        document.createTextNode(ok ? fmtScore(analysis.predicted) : "—")
      ]),
      h("div", {
        class: "fc-card-delta",
        html: ok
          ? "predicted on " + fmtLongDate(TARGET_DATE) +
            " &nbsp;·&nbsp; <strong>+" + fmtScore(analysis.increase) + "</strong> from today"
          : "not enough data to project"
      }),
      h("div", { class: "fc-card-rows" }, rows)
    ]);

    function row(k, v) {
      return h("div", { class: "fc-row" }, [
        h("span", { class: "fc-k", text: k }),
        h("span", { class: "fc-v", text: v })
      ]);
    }
  }

  /* ── Chart ──────────────────────────────────────────────────────────────── */

  /**
   * Pick a viewBox shaped for the space available. A wide 960x360 box squashed
   * into a phone gives a 130px-tall plot with illegible labels, so narrow
   * screens get a taller, narrower box — the SVG still scales to 100% width,
   * but text and gridlines land at a readable size.
   */
  function viewport(width) {
    if (width < 560) {
      return {
        W: 460, H: 400,
        M: { top: 16, right: 14, bottom: 38, left: 54 },
        fs: 14, xTicks: 3, yTicks: 4
      };
    }
    if (width < 900) {
      return {
        W: 720, H: 360,
        M: { top: 16, right: 16, bottom: 40, left: 58 },
        fs: 13, xTicks: 5, yTicks: 5
      };
    }
    return {
      W: 960, H: 360,
      M: { top: 18, right: 18, bottom: 42, left: 60 },
      fs: 11, xTicks: 8, yTicks: 5
    };
  }

  function buildChart(analyses, wrapWidth) {
    var vp = viewport(wrapWidth || 960);
    var VB_W = vp.W, VB_H = vp.H, M = vp.M;
    var plotW = VB_W - M.left - M.right;
    var plotH = VB_H - M.top - M.bottom;

    /* ── Domains ── */
    var lastDay = -Infinity, firstDay = Infinity;
    SERIES.forEach(function (sr) {
      var a = analyses[sr.key];
      a.points.forEach(function (p) {
        var d = Core.dayNumber(p.date);
        if (d < firstDay) firstDay = d;
        if (d > lastDay) lastDay = d;
      });
    });
    if (!Number.isFinite(firstDay)) return null;

    var targetDay = Core.dayNumber(TARGET_DATE);
    /* Always show today plus the previous six days, even before the record
       fills in — an axis window, not fabricated data. */
    var x0 = Math.min(firstDay, lastDay - (MIN_WINDOW_DAYS - 1));
    var x1 = Math.max(targetDay, lastDay);
    var xSpan = Math.max(1, x1 - x0);

    var vals = [];
    SERIES.forEach(function (sr) {
      var a = analyses[sr.key];
      a.points.forEach(function (p) { vals.push(p.value); });
      (a.projection || []).forEach(function (p) {
        vals.push(p.value);
        if (Number.isFinite(p.low)) vals.push(p.low);
        if (Number.isFinite(p.high)) vals.push(p.high);
      });
    });
    if (!vals.length) return null;
    var yMin = Math.min.apply(null, vals), yMax = Math.max.apply(null, vals);
    var pad = Math.max((yMax - yMin) * 0.12, 20);
    yMin -= pad; yMax += pad;

    var X = function (day) { return M.left + ((day - x0) / xSpan) * plotW; };
    var Y = function (v) { return M.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH; };

    var fs = vp.fs;
    var xTickCount = vp.xTicks;
    var yTickCount = vp.yTicks;

    var svg = s("svg", {
      class: "fc-chart", viewBox: "0 0 " + VB_W + " " + VB_H,
      preserveAspectRatio: "xMidYMid meet", role: "img",
      "aria-label": "Line chart of recorded and forecast Mythic+ cutoff scores"
    });

    /* ── Y grid + labels ── */
    for (var i = 0; i <= yTickCount; i++) {
      var v = yMin + ((yMax - yMin) * i) / yTickCount;
      var y = Y(v);
      svg.appendChild(s("line", {
        class: "fc-grid-line", x1: M.left, x2: M.left + plotW, y1: y, y2: y
      }));
      svg.appendChild(s("text", {
        class: "fc-tick", x: M.left - 10, y: y + fs * 0.35,
        "text-anchor": "end", "font-size": fs, text: fmtScore(v)
      }));
    }

    /* ── X labels ── */
    var xStep = Math.max(1, Math.round(xSpan / xTickCount));
    for (var d = x0; d <= x1; d += xStep) {
      svg.appendChild(s("text", {
        class: "fc-tick", x: X(d), y: M.top + plotH + fs + 10,
        "text-anchor": "middle", "font-size": fs,
        text: fmtShortDate(Core.dateFromDayNumber(d))
      }));
    }
    /* Guarantee the target date is labelled. */
    if ((x1 - x0) % xStep !== 0) {
      svg.appendChild(s("text", {
        class: "fc-tick", x: X(x1), y: M.top + plotH + fs + 10,
        "text-anchor": "end", "font-size": fs,
        text: fmtShortDate(Core.dateFromDayNumber(x1))
      }));
    }

    svg.appendChild(s("line", {
      class: "fc-axis-line", x1: M.left, x2: M.left + plotW,
      y1: M.top + plotH, y2: M.top + plotH
    }));

    /* ── "Today" divider: the boundary between recorded and forecast ── */
    svg.appendChild(s("line", {
      class: "fc-today-line", x1: X(lastDay), x2: X(lastDay), y1: M.top, y2: M.top + plotH
    }));
    svg.appendChild(s("text", {
      class: "fc-today-label", x: X(lastDay) + 6, y: M.top + fs,
      "font-size": Math.round(fs * 0.85), text: "Today"
    }));

    /* ── Confidence bands (drawn first, behind the lines) ── */
    SERIES.forEach(function (sr) {
      var a = analyses[sr.key];
      var proj = a.projection || [];
      if (proj.length < 1 || !Number.isFinite(a.current)) return;
      var top = [[X(lastDay), Y(a.current)]];
      var bot = [[X(lastDay), Y(a.current)]];
      proj.forEach(function (p) {
        var day = Core.dayNumber(p.date);
        top.push([X(day), Y(p.high)]);
        bot.push([X(day), Y(p.low)]);
      });
      var pts = top.concat(bot.reverse())
        .map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
      svg.appendChild(s("polygon", {
        class: "fc-band", points: pts, fill: "var(" + sr.colorVar + ")"
      }));
    });

    /* ── Recorded (solid) and forecast (dashed) lines ── */
    SERIES.forEach(function (sr) {
      var a = analyses[sr.key];
      if (!a.points.length) return;
      var color = "var(" + sr.colorVar + ")";

      var recorded = a.points.map(function (p) {
        return X(Core.dayNumber(p.date)).toFixed(1) + "," + Y(p.value).toFixed(1);
      }).join(" ");
      if (a.points.length > 1) {
        svg.appendChild(s("polyline", { class: "fc-line", points: recorded, stroke: color }));
      }

      var proj = a.projection || [];
      if (proj.length) {
        var fc = [[X(lastDay), Y(a.current)]].concat(proj.map(function (p) {
          return [X(Core.dayNumber(p.date)), Y(p.value)];
        })).map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" ");
        svg.appendChild(s("polyline", {
          class: "fc-line-forecast", points: fc, stroke: color
        }));
      }

      a.points.forEach(function (p) {
        svg.appendChild(s("circle", {
          class: "fc-dot", cx: X(Core.dayNumber(p.date)), cy: Y(p.value),
          r: 4, fill: color
        }));
      });
      if (proj.length) {
        var end = proj[proj.length - 1];
        svg.appendChild(s("circle", {
          class: "fc-dot-target", cx: X(Core.dayNumber(end.date)), cy: Y(end.value),
          r: 5, stroke: color
        }));
      }
    });

    /* ── Hover layer ── */
    var hoverLine = s("line", {
      class: "fc-hover-line", x1: 0, x2: 0, y1: M.top, y2: M.top + plotH, opacity: 0
    });
    svg.appendChild(hoverLine);
    var hoverDots = SERIES.map(function (sr) {
      var c = s("circle", {
        class: "fc-hover-dot", r: 5.5, fill: "var(" + sr.colorVar + ")", opacity: 0
      });
      svg.appendChild(c);
      return c;
    });
    var capture = s("rect", {
      x: M.left, y: M.top, width: plotW, height: plotH, fill: "transparent"
    });
    svg.appendChild(capture);

    return {
      svg: svg, X: X, Y: Y, x0: x0, x1: x1, lastDay: lastDay, vbW: VB_W,
      hoverLine: hoverLine, hoverDots: hoverDots, capture: capture, plotH: plotH
    };
  }

  /* ── Tooltip wiring ─────────────────────────────────────────────────────── */
  function wireTooltip(chart, analyses, wrap, tip) {
    /* Unified day → value lookup across both series. */
    var byDay = {};
    SERIES.forEach(function (sr) {
      var a = analyses[sr.key];
      a.points.forEach(function (p) {
        var d = Core.dayNumber(p.date);
        (byDay[d] = byDay[d] || {})[sr.key] = { value: p.value, kind: "recorded" };
      });
      (a.projection || []).forEach(function (p) {
        var d = Core.dayNumber(p.date);
        (byDay[d] = byDay[d] || {})[sr.key] = { value: p.value, kind: "forecast" };
      });
    });
    var days = Object.keys(byDay).map(Number).sort(function (a, b) { return a - b; });
    if (!days.length) return;

    function hide() {
      tip.classList.remove("fc-on");
      chart.hoverLine.setAttribute("opacity", 0);
      chart.hoverDots.forEach(function (c) { c.setAttribute("opacity", 0); });
    }

    function move(evt) {
      var rect = chart.svg.getBoundingClientRect();
      if (!rect.width) return;
      var px = ((evt.clientX - rect.left) / rect.width) * chart.vbW;

      var best = days[0], bestDist = Infinity;
      days.forEach(function (d) {
        var dist = Math.abs(chart.X(d) - px);
        if (dist < bestDist) { bestDist = dist; best = d; }
      });

      var entry = byDay[best];
      var dateStr = Core.dateFromDayNumber(best);
      var isForecast = SERIES.some(function (sr) {
        return entry[sr.key] && entry[sr.key].kind === "forecast";
      });

      chart.hoverLine.setAttribute("x1", chart.X(best));
      chart.hoverLine.setAttribute("x2", chart.X(best));
      chart.hoverLine.setAttribute("opacity", 1);

      var rows = [];
      SERIES.forEach(function (sr, idx) {
        var v = entry[sr.key];
        var dot = chart.hoverDots[idx];
        if (!v) { dot.setAttribute("opacity", 0); return; }
        dot.setAttribute("cx", chart.X(best));
        dot.setAttribute("cy", chart.Y(v.value));
        dot.setAttribute("opacity", 1);
        rows.push(
          '<div class="fc-tip-row">' +
            '<span class="fc-tip-chip" style="background:var(' + sr.colorVar + ')"></span>' +
            '<span class="fc-tip-key">' + sr.label + '</span>' +
            '<span class="fc-tip-val">' + fmtScore(v.value) + '</span>' +
          '</div>'
        );
      });

      tip.innerHTML =
        '<div class="fc-tip-date">' + escapeHtml(fmtLongDate(dateStr)) + '</div>' +
        rows.join("") +
        '<div class="fc-tip-kind">' + (isForecast ? "Forecast · estimate" : "Recorded") + '</div>';

      /* Position within the wrapper, flipping before it can overflow. */
      var wrapRect = wrap.getBoundingClientRect();
      var xPx = (chart.X(best) / chart.vbW) * rect.width + (rect.left - wrapRect.left);
      var tipW = tip.offsetWidth || 150;
      var left = xPx + 14;
      if (left + tipW > wrapRect.width - 4) left = xPx - tipW - 14;
      if (left < 4) left = 4;
      tip.style.left = left + "px";
      tip.style.top = Math.max(4, (evt.clientY - wrapRect.top) - 16) + "px";
      tip.classList.add("fc-on");
    }

    chart.capture.addEventListener("pointermove", move);
    chart.capture.addEventListener("pointerdown", move);
    chart.svg.addEventListener("pointerleave", hide);
  }

  /* ── Legend + methodology + disclaimer ──────────────────────────────────── */
  function buildLegend() {
    var items = [];
    SERIES.forEach(function (sr) {
      items.push(h("div", { class: "fc-legend-item" }, [
        h("span", { class: "fc-swatch", style: "border-top-color:var(" + sr.colorVar + ")" }),
        h("span", { text: sr.label + " — recorded" })
      ]));
      items.push(h("div", { class: "fc-legend-item" }, [
        h("span", {
          class: "fc-swatch", "data-style": "dashed",
          style: "border-top-color:var(" + sr.colorVar + ")"
        }),
        h("span", { text: sr.label + " — forecast" })
      ]));
    });
    items.push(h("div", { class: "fc-legend-item" }, [
      h("span", { class: "fc-swatch", "data-style": "band", style: "background:var(--fc-muted)" }),
      h("span", { text: "Confidence range (~80%)" })
    ]));
    return h("div", { class: "fc-legend" }, items);
  }

  function buildMethodology(analyses, sourceLabel) {
    var a = analyses.p990;
    var det = h("details", { class: "fc-method" });
    det.appendChild(h("summary", { text: "How this forecast is calculated" }));
    det.appendChild(h("div", { class: "fc-method-body", html:
      "<p>History source: <strong>" + escapeHtml(sourceLabel) + "</strong>. Raider.IO's " +
      "season-cutoffs response carries its own daily series for each percentile, going " +
      "back to the start of the season — nothing here is estimated backwards. Where that " +
      "series is unavailable, this site falls back to snapshots it records itself: one per " +
      "day, per season, per region, updated rather than duplicated on repeat visits.</p>" +
      "<p><strong>Only the last " + (a.windowDays || Core.ANALYSIS_WINDOW_DAYS) +
      " days are fitted</strong>" +
      (a.nAvailable > a.n
        ? " (" + a.n + " of " + a.nAvailable + " available days)"
        : "") +
      ". Cutoffs climb steeply in the opening weeks of a season and flatten towards the " +
      "end; fitting the whole season would roughly triple the apparent rate and badly " +
      "overshoot. The earlier data is kept and counted, just not fitted.</p>" +
      "<p>Each threshold is projected to " + escapeHtml(fmtLongDate(TARGET_DATE)) +
      " from three independent estimates of the daily rate of increase:</p>" +
      "<ol>" +
        "<li><strong>Ordinary linear regression</strong> over every recorded day " +
        "(weight <code>" + Math.round(0.30 * 100) + "%</code>) — the long-run slope, " +
        "insensitive to a single odd day.</li>" +
        "<li><strong>Recency-weighted regression</strong> (weight <code>45%</code>), where a " +
        "day's influence halves every " + Core.HALF_LIFE_DAYS + " days, so the current pace " +
        "dominates without discarding the earlier record.</li>" +
        "<li><strong>Recent rate</strong> over the last " + Core.RECENT_DAYS + " days " +
        "(weight <code>25%</code>) — the raw short-term climb.</li>" +
      "</ol>" +
      "<p><strong>Acceleration</strong> is measured by comparing the recent rate against the " +
      "rate over the earlier half of the record. Only <code>" +
      Math.round(Core.ACCEL_DAMPING * 100) + "%</code> of it is carried forward, and each " +
      "projected day is clamped to non-negative and to twice the observed pace — cutoffs " +
      "do not fall, and they rarely double their speed. The projection then accumulates " +
      "day by day across the " + (a.daysRemaining != null ? a.daysRemaining : "remaining") +
      " days to the target date rather than multiplying one rate by the horizon.</p>" +
      "<p>The <strong>confidence range</strong> adds two things: how far the recorded points " +
      "scatter around the regression line, propagated over the horizon, and how much the " +
      "three rate estimates disagree with each other. It is widened further when few " +
      "snapshots exist, and it never narrows below <code>" +
      Math.round((a.bandFloorFrac || 0) * 100) + "%</code> of the predicted move — a few " +
      "points that happen to line up perfectly must not advertise an exact answer. " +
      "It is an ~80% range, not a guarantee.</p>" +
      "<p><strong>Known limits.</strong> The fit assumes the current regime holds to the " +
      "target date; a patch, a season ending, or a title push can break it. Raider.IO " +
      "samples roughly once a day at varying times, so a \"day\" is a sample, not a fixed " +
      "24-hour boundary. Treat every forecast figure as an estimate.</p>"
    }));
    return det;
  }

  function buildWarnings(analyses) {
    var seen = {}, msgs = [];
    SERIES.forEach(function (sr) {
      (analyses[sr.key].warnings || []).forEach(function (w) {
        if (!seen[w]) { seen[w] = true; msgs.push(w); }
      });
    });
    if (!msgs.length) return null;
    var unreliable = SERIES.some(function (sr) { return !analyses[sr.key].sufficient; });
    return h("div", { class: "fc-note", "data-kind": unreliable ? "warn" : "warn" }, [
      h("span", { class: "fc-note-icon", text: "⚠" }),
      h("div", {}, [
        h("strong", {
          text: unreliable
            ? "Not enough data for a reliable forecast yet."
            : "Caveats on this forecast."
        }),
        h("ul", {}, msgs.map(function (m) { return h("li", { text: m }); }))
      ])
    ]);
  }

  /* ── Full render ────────────────────────────────────────────────────────── */
  var current = null; // {analyses, season, sourceLabel, liveError}

  function render(state) {
    current = state;
    clear(body);

    var analyses = state.analyses;
    var a990 = analyses.p990;
    setHeadNote(
      state.season + " · " + REGION.toUpperCase() + " · " +
      (a990.nAvailable > a990.n
        ? "last " + a990.n + " of " + a990.nAvailable + " days"
        : a990.n + " day" + (a990.n === 1 ? "" : "s")) +
      " · to " + fmtShortDate(TARGET_DATE)
    );

    if (state.liveError) {
      body.appendChild(h("div", { class: "fc-note", "data-kind": "error" }, [
        h("span", { class: "fc-note-icon", text: "!" }),
        h("div", {}, [
          h("strong", { text: "Today's cutoff could not be read from Raider.IO. " }),
          document.createTextNode(
            state.liveError + " The chart below shows previously recorded days only; " +
            "no value has been invented for today."
          )
        ])
      ]));
    }

    var warn = buildWarnings(analyses);
    if (warn) body.appendChild(warn);

    body.appendChild(h("div", { class: "fc-cards" }, SERIES.map(function (sr) {
      return buildCard(sr, analyses[sr.key]);
    })));

    var wrap = h("div", { class: "fc-chart-wrap" });
    var tip = h("div", { class: "fc-tip", role: "status", "aria-live": "polite" });
    body.appendChild(wrap);

    function drawChart() {
      clear(wrap);
      var chart = buildChart(analyses, wrap.clientWidth || 960);
      if (!chart) {
        wrap.appendChild(h("div", { class: "fc-state", text: "Nothing to plot yet." }));
        return;
      }
      wrap.appendChild(chart.svg);
      wrap.appendChild(tip);
      wrap.appendChild(buildLegend());
      wireTooltip(chart, analyses, wrap, tip);
    }
    drawChart();

    /* Redraw on width change so tick density and label size stay legible —
       always when the viewBox bucket changes, otherwise only on a real move. */
    if (window.ResizeObserver) {
      var last = wrap.clientWidth;
      var lastBox = viewport(last).W;
      var timer = null;
      var ro = new ResizeObserver(function () {
        var w = wrap.clientWidth;
        var box = viewport(w).W;
        if (box === lastBox && Math.abs(w - last) < 40) return;
        last = w; lastBox = box;
        clearTimeout(timer);
        timer = setTimeout(drawChart, 120);
      });
      ro.observe(wrap);
    }

    body.appendChild(buildMethodology(analyses, state.sourceLabel));
    body.appendChild(h("div", {
      class: "fc-disclaimer",
      html: "Recorded values come from Raider.IO. The dashed lines are " +
            "<strong>estimates calculated by this site</strong> — Raider.IO and Blizzard " +
            "publish no forecast."
    }));
  }

  /* ── Boot ───────────────────────────────────────────────────────────────── */
  function boot() {
    renderLoading();

    fetchCurrentCutoffs().then(function (live) {
      return finish(live, null);
    }, function (err) {
      /* Live read failed. We may still have a stored history to plot. */
      return finish(null, err.message || "Network error");
    });
  }

  function finish(live, liveError) {
    var season = live ? live.season : lastKnownSeason();
    if (!season) {
      renderError(liveError || "No season data available.", boot);
      return;
    }

    var today = Store.todayKey();
    var record = live ? {
      date: today, season: season, region: REGION,
      p990: live.p990, p999: live.p999,
      updatedAt: new Date().toISOString(), source: "client"
    } : null;

    /* localStorage tier: always available, always upserted (never duplicated). */
    var localList = localRead(season, REGION);
    if (record) {
      var res = Store.upsert(localList, record);
      localList = res.list;
      localWrite(season, REGION, localList);
    }

    var published = live && live.history ? live.history : [];

    /* Server tier: a fallback for seasons Raider.IO does not graph. */
    serverRead(season, REGION).then(function (serverList) {
      var snapshots = serverList === null
        ? localList
        : Store.merge(serverList, localList);
      if (serverList !== null && record) serverWrite(record); // fire and forget

      /* Raider.IO's own series wins wherever it covers a day. */
      var merged = Store.filterSeasonRegion(
        Store.merge(published, snapshots), season, REGION
      );

      var sourceLabel = published.length
        ? "Raider.IO's published daily series (" + published.length + " days)"
        : serverList === null
          ? "this site's own snapshots, recorded in this browser"
          : "this site's own shared daily snapshots";

      if (!merged.length) { renderEmpty(season, !!record); return; }

      render({
        analyses: Core.analyseSnapshots(merged, { targetDate: TARGET_DATE }),
        season: season,
        sourceLabel: sourceLabel,
        liveError: liveError,
        published: published.length
      });
    });
  }

  /** Recover a season slug from whatever bucket this browser already holds. */
  function lastKnownSeason() {
    try {
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (k && k.indexOf(Store.KEY_PREFIX + ":") === 0) {
          var parts = k.split(":");
          if (parts[2] === REGION) return parts[1];
        }
      }
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  /* Never let this section break the page it is attached to. */
  try {
    mount();
    boot();
  } catch (e) {
    if (root.parentNode) root.parentNode.removeChild(root);
    if (window.console) console.warn("Cutoff Forecast disabled:", e);
  }

  window.MPlusForecast = {
    reload: boot,
    state: function () { return current; }
  };
})();
