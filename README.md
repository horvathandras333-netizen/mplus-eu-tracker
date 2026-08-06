# M+ EU Cutoffs

Mythic+ season cutoff tracker for the EU region. Data from [Raider.IO](https://raider.io).

Two front ends over the same Raider.IO data:

## Web

`site/index.html` — the season tracker deployed at
<https://mplus-eu-tracker.netlify.app/>. A single self-contained page; all CSS
and JS are inline, the only external dependency is Google Fonts. Deploy by
uploading the file to Netlify.

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
