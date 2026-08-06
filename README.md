# M+ EU Cutoffs

Mythic+ season cutoff tracker for the EU region. Data from [Raider.IO](https://raider.io).

Two front ends over the same Raider.IO data:

## Web

`site/index.html` — the season tracker deployed at
<https://mplus-eu-tracker.netlify.app/>. The page itself is self-contained; all
its CSS and JS are inline and the only external dependency is Google Fonts.

Alongside it sits the **Cutoff Forecast** section, added as an isolated add-on
in separate files (`forecast*.js`, `forecast.css`, `snapshot-store.js`) that
`index.html` only links to. It charts Raider.IO's published daily series for the
Top 1% and Top 0.1% cutoffs and projects both to 11 August 2026 — see
[docs/CUTOFF-FORECAST.md](docs/CUTOFF-FORECAST.md) for how it stores data, how
the forecast is calculated, and how to deploy the daily snapshot service.

Deploying `site/` to Netlify is enough for the page. Linking the repo (so
`netlify.toml` and `netlify/functions/` are picked up) additionally gives the
forecast a shared, scheduled snapshot record instead of a per-browser one.

```
npm test    # forecast maths, snapshot storage, and existing-site regression
```

## Desktop

Tkinter dashboards showing dungeon breakdown, season cutoffs, and character
score side by side.

| File | Notes |
| --- | --- |
| `mythic cut off v3.py` | Current version — 3-column dashboard |
| `mythic cut off with mem.py` | Earlier version with saved character memory |
| `mythic cut off.py` | Original |

Run with `python "mythic cut off v3.py"` (standard library only).

`MPlus EU Cutoffs.spec` builds a windowed Windows executable:

```
pyinstaller "MPlus EU Cutoffs.spec"
```
