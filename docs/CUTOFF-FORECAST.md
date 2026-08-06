# Cutoff Forecast

An isolated section appended to the bottom of the tracker page. It charts the
EU Mythic+ **Top 1%** (`p990`) and **Top 0.1%** (`p999`) cutoffs daily and
projects both to the **EU weekly reset: Wednesday 12 August 2026, 04:00 UTC**.

## The deadline

Blizzard [permanently moved the EU weekly reset to 05:00 CET in November
2022](https://eu.forums.blizzard.com/en/wow/t/weekly-reset-time-changing-to-0500-cet-on-16-november/398498).
That is a fixed wall clock, so it is **04:00 UTC year round** — 06:00 CEST
during summer time. Scores stop climbing there.

Note this is a **Wednesday**. Tuesday is the *US* reset day; the two regions are
a day apart, so an EU season deadline is never a Tuesday.

Raider.IO samples the cutoffs each evening (observed 20:30–23:45 UTC), which
means the last reading before the reset lands roughly seven hours before it. The
horizon is therefore measured from the actual reading timestamp to the reset
instant — about **5.3 days** on 6 Aug, not the 6.0 a midnight-to-midnight grid
would imply. The projection walks whole days and then takes a part-day final
step so it lands exactly on the reset.

`TARGET_INSTANT`, `TARGET_DATE` and `TARGET_LABEL` in
[`site/forecast-core.js`](../site/forecast-core.js) are the only places the
deadline is defined.

## Where the history comes from

Raider.IO's `season-cutoffs` response — the same request the tracker already
makes — carries a `graphData` block holding its own daily series for every
percentile, back to the start of the season:

```jsonc
cutoffs.graphData.p990 = {
  "type": "spline", "name": "Top 1%",
  "data": [ { "x": 1786050027552, "y": 3972.16, "total": 16062 }, ... ]
}
```

As of 6 August 2026 that is **135 daily points per threshold, from 25 March**.
So the history is real and published, not reconstructed, and the chart is
populated from the first page load rather than filling in over a week.

`historyFromGraphData()` in [`site/forecast.js`](../site/forecast.js) folds the
`p990` and `p999` series into one record per UTC day.

### The snapshot system is the fallback

The daily snapshot service below still exists for seasons or regions where
`graphData` is absent, and as a hedge if Raider.IO ever truncates the series.
Raider.IO's series always wins where the two overlap.

## Storage

Two independent tiers, both keyed by `(season, region)` so records from
different seasons or regions can never mix:

| Tier | Where | Scope | Needs |
|---|---|---|---|
| `localStorage` | the visitor's browser | that browser only | nothing — works on a drag-and-drop deploy |
| Netlify Blobs | the site | shared by all visitors | functions deployed (below) |

The browser reads both, merges them (server wins on a shared date), and plots
the result. If the functions are not deployed the server read 404s and the
section falls back to the local tier silently.

Storage key / blob key: `mplus-cutoff-history:<season>:<region>`

Record shape:

```json
{
  "date": "2026-08-06",
  "season": "season-mn-1",
  "region": "eu",
  "p990": 3204.6,
  "p999": 3861.2,
  "updatedAt": "2026-08-06T06:10:04.113Z",
  "source": "scheduled"
}
```

**The HTTP endpoint is read-only.** `cutoff-history` serves `GET`/`HEAD` and
answers everything else with `405`. It briefly accepted `POST` so a visitor's
browser could contribute a snapshot, which meant an unauthenticated write anyone
on the internet could reach — a way to create unbounded blobs and burn function
invocations. `graphData` made it redundant, so the route was removed rather than
guarded. `recordSnapshot()` is the only writer, and only the scheduled job calls
it.

**Duplicates are impossible by construction.** Every write goes through
`upsert()` in [`site/snapshot-store.js`](../site/snapshot-store.js), which
matches on the date and replaces in place. Day keys are UTC, so a visitor's
timezone cannot split one day into two records.

## Deploying the snapshot service

The site works without this. It is what makes the history *shared* rather than
per-browser, and what keeps recording on days nobody visits.

1. **Link the repo to Netlify** — Site settings → Build & deploy → Link
   repository. `netlify.toml` already sets `publish = "site"` and
   `functions = "netlify/functions"`, and there is no build command.
2. **Install dependencies** — Netlify runs `npm install` automatically from
   `package.json`. The only dependency is `@netlify/blobs`.
3. **Deploy.** Netlify Blobs needs no provisioning, no migration and no
   connection string; the store is created on first write.

### Database migrations

None. There is no database and no schema to migrate. Blob payloads carry a
`version` field (currently `1`); `parse()` accepts a bare array, a versioned
envelope, or a JSON string, so a future format change stays backward compatible.

### Environment variables

None are required. One is optional:

| Variable | Default | Effect |
|---|---|---|
| `SNAPSHOT_REGIONS` | `eu` | Comma-separated regions the scheduled job records, e.g. `eu,us` |

### Scheduling

Already declared in code — no dashboard configuration needed:

```js
// netlify/functions/snapshot-cutoffs.mjs
export const config = { schedule: "10 6 * * *" };  // 06:10 UTC daily
```

Netlify registers the cron on deploy. To take a snapshot by hand:

```bash
curl -X POST https://mplus-eu-tracker.netlify.app/.netlify/functions/snapshot-cutoffs
```

Running it any number of times a day is safe — repeat runs update the existing
record and skip the blob write entirely when nothing changed.

## How the forecast works

**Only the trailing 21 days are fitted** (`ANALYSIS_WINDOW_DAYS`). This matters
more than any other choice here. Measured on the live EU season on 6 Aug 2026:

| Window fitted | Implied rate | Projected gain by the reset |
|---|---|---|
| last 7 days | 3.75 /day | +18.8 |
| last 21 days | 3.02 /day | +15.1 |
| last 30 days | 2.67 /day | +13.4 |
| **all 135 days** | **9.47 /day** | **+47.4** |

Cutoffs climb steeply in the opening weeks and flatten towards season end, so
fitting the whole season overstates the rate roughly threefold. Trailing windows
between 7 and 30 days agree closely; 21 is the default. Earlier data is still
counted and reported ("22 of 135"), just not fitted.

Within that window, three independent estimates of the daily rate are blended:

| Estimator | Weight | Purpose |
|---|---|---|
| Ordinary least squares over every recorded day | 30% | long-run slope, insensitive to one odd day |
| Recency-weighted least squares (weight halves every 3 days) | 45% | lets the current pace dominate without discarding history |
| Raw rate over the last 3 days | 25% | short-term climb |

**Acceleration** compares the recent rate against the rate over the earlier half
of the record. Only 35% of it is carried forward, and each projected day is
clamped to non-negative and to twice the observed pace — cutoffs do not fall,
and they rarely double their speed. The projection then accumulates day by day
to the target date rather than multiplying one rate by the horizon.

**Confidence range (~80%)** combines the scatter of recorded points around the
regression line (propagated over the horizon) with the disagreement between the
three estimators, widened when few snapshots exist. It never narrows below
`0.5/√(n−1)` of the predicted move, so a handful of points that happen to fall
on a straight line cannot advertise an exact answer.

**Reliability.** Below 4 snapshots or a 3-day span the section shows a warning
instead of quietly presenting a confident number. Gaps in the record are
reported rather than smoothed over.

## Known limitations

- The fit assumes the current regime holds to the target date. A patch, a
  season ending, or an end-of-season title push can break it.
- Raider.IO samples roughly once a day at a varying hour, so a "day" is a
  sample, not a fixed 24-hour boundary. Two samples can occasionally land on one
  UTC date, in which case the later one wins.
- `graphData` is not a documented part of the public API. It is present today
  for every percentile; if Raider.IO removes it, the section falls back to the
  snapshot record automatically — but that record only covers days since deploy.
- Regions other than EU are snapshotted only if `SNAPSHOT_REGIONS` lists them;
  the page itself displays EU.

## Security posture

The site is static and CDN-served, so there is no origin to overwhelm and no
login to attack. What hardening exists:

| Measure | Where |
|---|---|
| No unauthenticated write path | `cutoff-history` is `GET`/`HEAD` only; the scheduled job is the sole writer |
| Blob growth capped | `MAX_RECORDS = 400` per season+region bucket |
| Input validation | date format, region allowlist, score range 0–100000, rejected before storage |
| CSP, HSTS, nosniff, frame denial, referrer + permissions policy | `netlify.toml`, applied to `/*` |

The CSP allows exactly the hosts the page uses — `fonts.googleapis.com`,
`fonts.gstatic.com`, `raider.io`, `*.worldofwarcraft.com` (portraits) and
`*.raiderio.net` (dungeon art). It requires `'unsafe-inline'` for scripts and
styles because `index.html` inlines both, so it is not an XSS backstop;
`frame-ancestors`, `object-src`, `base-uri`, `img-src` and `connect-src` are
where it earns its place. Verified in a headless browser against the real page,
including a control request to a disallowed host to confirm the policy is
actually enforced rather than silently absent.

**Not covered.** Rate limiting is a Netlify plan feature (Web security →
Firewall Traffic Rules), not something the code can do. On the free tier the
realistic damage from a flood is bandwidth exhaustion — set a usage alert.

**Known, unfixed.** The original `renderRoster()` and `dungHTML()` interpolate
Raider.IO strings into `innerHTML` without escaping. WoW character names are
alphanumeric and the rest is Raider.IO's fixed vocabulary, so it is not
practically exploitable, but it is the one XSS-shaped thing in the codebase. It
was left alone because the brief was not to modify existing behaviour.

## Tests

```bash
npm test
```

- `tests/forecast-core.test.mjs` — forecast maths, guardrails, reliability
- `tests/snapshot-store.test.mjs` — duplicate handling, season/region separation
- `tests/cutoff-history-endpoint.test.mjs` — the API contract against a fake store
- `tests/regression-existing-site.test.mjs` — proves `index.html` differs from
  its pre-feature baseline by the two documented insertions and nothing else
