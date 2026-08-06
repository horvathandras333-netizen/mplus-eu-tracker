/* ═══════════════════════════════════════════════════════════════════════════
   Regression tests: the existing tracker must be untouched.

   `tests/fixtures/index.baseline.html` is the byte-for-byte copy of
   site/index.html as it was before the Cutoff Forecast work (taken from git).
   The first test proves the live file differs from it by exactly the two
   documented insertions and nothing else — so no existing feature, layout,
   style, route, API call or handler can have been altered without failing.

   The remaining tests guard the isolation contract from the other direction:
   the new CSS and JS must not be able to reach the existing page.
   ═══════════════════════════════════════════════════════════════════════════ */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8").replace(/\r\n/g, "\n");

/* Comments describe the isolation contract in prose; scanners must look at
   code only, or they trip over the very names they exist to forbid. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const baseline = read("tests/fixtures/index.baseline.html");
const current = read("site/index.html");
const forecastCss = read("site/forecast.css");
const forecastJs = read("site/forecast.js");

/* The two insertions, verbatim. Nothing else may differ. */
const INSERTED_HEAD =
  '<!-- Cutoff Forecast section (isolated add-on; scoped to #fc-forecast / .fc-*) -->\n' +
  '<link rel="stylesheet" href="forecast.css">\n';

const INSERTED_BODY =
  '\n<!-- Cutoff Forecast section: self-mounting add-on. Loads after everything\n' +
  '     above; if it fails, the page behaves exactly as it did before. -->\n' +
  '<script defer src="forecast-core.js"></script>\n' +
  '<script defer src="snapshot-store.js"></script>\n' +
  '<script defer src="forecast.js"></script>\n';

/* ── The headline guarantee ─────────────────────────────────────────────── */

test("index.html differs from its pre-feature baseline by the two insertions only", () => {
  assert.ok(current.includes(INSERTED_HEAD), "stylesheet insertion not found verbatim");
  assert.ok(current.includes(INSERTED_BODY), "script insertion not found verbatim");

  const stripped = current
    .replace(INSERTED_HEAD, "")
    .replace(INSERTED_BODY, "");

  assert.equal(
    stripped.replace(/\s+$/, ""),
    baseline.replace(/\s+$/, ""),
    "index.html has changes beyond the two documented insertions"
  );
});

test("exactly eight lines were added to index.html", () => {
  assert.equal(current.split("\n").length - baseline.split("\n").length, 8);
});

test("nothing was removed from index.html", () => {
  const baseLines = baseline.split("\n").filter((l) => l.trim());
  const curLines = new Set(current.split("\n").filter((l) => l.trim()));
  const missing = baseLines.filter((l) => !curLines.has(l));
  assert.deepEqual(missing, [], "these original lines are gone");
});

/* ── Existing feature surface still present ─────────────────────────────── */

test("every element id the existing tracker depends on is still in the document", () => {
  const ids = [
    "nav", "navSeason", "navStatus",
    "heroBg", "heroScore", "heroName", "heroRank", "heroRule",
    "heroAvatarWrap", "heroAvatar",
    "nameInput", "realmInput", "lookupBtn",
    "dungLeft", "dungRight", "cutsPct", "cutsFixed"
  ];
  for (const id of ids) {
    assert.ok(current.includes(`id="${id}"`), `missing id="${id}"`);
  }
});

test("every existing script function is still defined", () => {
  const fns = [
    "mmss", "pips", "relDate", "setStatus", "onScroll", "observeReveals",
    "buildCutoffCards", "cardHTML", "fetchCutoffs", "applyCutoffs",
    "fetchChar", "applyChar", "showAvatarFallback", "updateGaps",
    "buildDungeons", "loadRoster", "roleIcon", "renderRoster", "dungHTML",
    "animateNumber"
  ];
  for (const fn of fns) {
    assert.ok(
      new RegExp(`function\\s+${fn}\\s*\\(`).test(current) ||
      new RegExp(`(const|let)\\s+${fn}\\s*=`).test(current),
      `missing function ${fn}`
    );
  }
});

test("existing Raider.IO calls are byte-identical", () => {
  const calls = [
    'fetch(`https://raider.io/api/v1/mythic-plus/season-cutoffs?season=${slug}&region=${REGION}`)',
    'fetch(`https://raider.io/api/v1/characters/profile?region=${REGION}&realm=${realm}&name=${encodeURIComponent(name)}&fields=${fields}`)',
    'fetch(`https://raider.io/api/v1/mythic-plus/run-details?season=${season}&id=${runId}`)'
  ];
  for (const call of calls) {
    assert.ok(current.includes(call), `Raider.IO call changed: ${call}`);
  }
});

test("existing configuration constants are unchanged", () => {
  assert.ok(current.includes('const REGION="eu", DEFAULT_NAME="Memfx", DEFAULT_REALM="ragnaros";'));
  assert.ok(current.includes('const SEASONS=["season-mn-1","season-tww-3","season-tww-2"];'));
  assert.ok(current.includes('{label:"All Stars",key:"p999"'));
  assert.ok(current.includes('{label:"Top 1%",key:"p990"'));
});

test("the existing design tokens and stylesheet are untouched", () => {
  const tokenBlock = baseline.slice(baseline.indexOf(":root{"), baseline.indexOf("}", baseline.indexOf(":root{")) + 1);
  assert.ok(tokenBlock.includes("--blue:#1428A0"), "fixture sanity check");
  assert.ok(current.includes(tokenBlock), ":root design tokens were modified");

  const styleBlocks = current.match(/<style>/g) || [];
  assert.equal(styleBlocks.length, 1, "a second inline <style> block appeared");
});

test("existing layout containers and their breakpoints survive", () => {
  for (const rule of [
    "@media(min-width:980px){",
    ".grid-3{display:grid;grid-template-columns:1fr;gap:40px}",
    "@media(max-width:979px){",
    ".col-dung-l{order:2}.col-cutoffs{order:1}.col-dung-r{order:3}"
  ]) {
    assert.ok(current.includes(rule), `layout rule changed: ${rule}`);
  }
});

/* ── Isolation contract: the new CSS cannot escape its section ──────────── */

test("every rule in forecast.css is scoped to #fc-forecast", () => {
  const css = forecastCss
    .replace(/\/\*[\s\S]*?\*\//g, "")                                   // comments
    .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");    // keyframes

  const selectors = [...css.matchAll(/([^{}]*)\{/g)]
    .map((m) => m[1].trim())
    .filter((sel) => sel && !sel.startsWith("@"));

  assert.ok(selectors.length > 20, "sanity: expected many rules to check");
  for (const sel of selectors) {
    for (const part of sel.split(",")) {
      assert.ok(
        part.includes("#fc-forecast"),
        `unscoped selector would leak into the existing page: "${part.trim()}"`
      );
    }
  }
});

test("forecast.css never redefines a global or an existing token", () => {
  assert.ok(!/:root\s*\{/.test(forecastCss), "forecast.css must not touch :root");
  assert.ok(!/^\s*\*/m.test(forecastCss.replace(/\/\*[\s\S]*?\*\//g, "")),
    "forecast.css must not use the universal selector");
  for (const token of ["--blue:", "--pink:", "--gold:", "--ink:", "--text:", "--border:"]) {
    assert.ok(!forecastCss.includes(token), `forecast.css redefines ${token}`);
  }
});

test("the existing inline stylesheet contains no forecast classes", () => {
  const inline = baseline.slice(baseline.indexOf("<style>"), baseline.indexOf("</style>"));
  assert.ok(!inline.includes("fc-"), "name collision between old and new CSS");
});

/* ── Isolation contract: the new JS cannot reach existing elements ──────── */

test("forecast.js touches no element owned by the existing tracker", () => {
  const existingIds = [
    "navSeason", "navStatus", "heroBg", "heroScore", "heroName", "heroRank",
    "heroRule", "heroAvatarWrap", "heroAvatar", "nameInput", "realmInput",
    "lookupBtn", "dungLeft", "dungRight", "cutsPct", "cutsFixed"
  ];
  for (const id of existingIds) {
    assert.ok(!forecastJs.includes(id), `forecast.js references existing element "${id}"`);
  }
  assert.ok(!forecastJs.includes("getElementById"),
    "forecast.js should never look existing elements up by id");
});

test("forecast.js queries the existing DOM only to find its mount point", () => {
  const queries = [...forecastJs.matchAll(/querySelector(?:All)?\(\s*["'`]([^"'`]+)["'`]/g)]
    .map((m) => m[1]);
  for (const q of queries) {
    assert.ok(
      q === "footer.site-footer" || q.includes("fc-"),
      `forecast.js queries outside its own section: "${q}"`
    );
  }
  assert.ok(queries.includes("footer.site-footer"), "mount point query is missing");
});

test("forecast.js does not reassign or wrap existing globals", () => {
  const code = stripComments(forecastJs);
  for (const global of [
    "fetchCutoffs", "fetchChar", "applyChar", "applyCutoffs", "updateGaps",
    "buildDungeons", "buildCutoffCards", "cutoffScores", "charScore", "TIERS"
  ]) {
    assert.ok(
      !new RegExp(`\\b${global}\\b`).test(code),
      `forecast.js touches the existing global "${global}"`
    );
  }
});

test("forecast.js exposes exactly one new global", () => {
  const assigned = [...forecastJs.matchAll(/window\.(\w+)\s*=/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(assigned)], ["MPlusForecast"]);
});

test("the new section mounts above the existing footer, not inside the layout", () => {
  assert.ok(forecastJs.includes('insertBefore(root, footer)'));
  assert.ok(!forecastJs.includes(".main"), "must not inject into the existing grid");
});

/* ── Isolation contract: the shared modules stay side-effect free ───────── */

test("forecast-core.js and snapshot-store.js touch no DOM and no network", () => {
  for (const file of ["site/forecast-core.js", "site/snapshot-store.js"]) {
    const code = stripComments(read(file));
    for (const forbidden of ["document.", "window.", "fetch(", "XMLHttpRequest", "localStorage"]) {
      assert.ok(!code.includes(forbidden), `${file} uses ${forbidden}`);
    }
  }
});
