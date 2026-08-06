"""
WoW Mythic+ EU Cutoffs Viewer
Data provided by Raider.IO (https://raider.io)
"""

import tkinter as tk
from tkinter import messagebox
import urllib.request
import urllib.error
import json
import threading
from datetime import datetime

SEASON_SLUGS = ["season-mn-1", "season-tww-3", "season-tww-2"]
REGION = "eu"

def build_api_url(season):
    return f"https://raider.io/api/v1/mythic-plus/season-cutoffs?season={season}&region={REGION}"

BG      = "#1a1a2e"
SURFACE = "#16213e"
CARD    = "#0f3460"
ACCENT  = "#e94560"
TEXT    = "#eaeaea"
MUTED   = "#8892a4"

# (label, cutoffs_key, score_field, colour, subtitle_override)
TIERS = [
    ("All Stars",        "p999",             "quantileMinValue", "#ffd700", "Top 0.1%  •  seasonal title"),
    ("Top 1%",           "p990",             "quantileMinValue", "#f472b6", "Top 1%"),
    ("Top 10%",          "p900",             "quantileMinValue", "#a78bfa", "Top 10%"),
    ("Keystone Myth",    "keystoneMyth",     "score",            "#e94560", "Fixed score threshold"),
    ("Keystone Legend",  "keystoneLegend",   "score",            "#f97316", "Fixed score threshold"),
    ("Keystone Hero",    "keystoneHero",     "score",            "#60a5fa", "Fixed score threshold"),
    ("Keystone Master",  "keystoneMaster",   "score",            "#4ade80", "Fixed score threshold"),
    ("Keystone Conqueror","keystoneConqueror","score",           "#a3e635", "Fixed score threshold"),
]


class CutoffsApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("M+ EU Cutoffs — Raider.IO")
        self.configure(bg=BG)
        self.resizable(False, False)
        self._widgets = {}
        self._build_ui()
        self.after(100, self._start_fetch)

    def _build_ui(self):
        hdr = tk.Frame(self, bg=ACCENT, pady=12)
        hdr.pack(fill="x")
        tk.Label(hdr, text="⚔  Mythic+ EU Cutoffs",
                 font=("Segoe UI", 18, "bold"), bg=ACCENT, fg="white").pack()
        self._season_label = tk.Label(hdr, text="Season: loading…",
                 font=("Segoe UI", 10), bg=ACCENT, fg="#ffd0d0")
        self._season_label.pack()

        bar = tk.Frame(self, bg=SURFACE, pady=6)
        bar.pack(fill="x")
        self._status_var = tk.StringVar(value="Connecting…")
        tk.Label(bar, textvariable=self._status_var,
                 font=("Segoe UI", 9), bg=SURFACE, fg=MUTED).pack(side="left", padx=12)
        self._refresh_btn = tk.Button(bar, text="↻ Refresh",
                 font=("Segoe UI", 9, "bold"), bg=CARD, fg=TEXT,
                 relief="flat", padx=10, pady=2, cursor="hand2",
                 command=self._start_fetch)
        self._refresh_btn.pack(side="right", padx=12)

        cards = tk.Frame(self, bg=BG, padx=18, pady=10)
        cards.pack(fill="both", expand=True)

        # Separator labels
        def section(text):
            tk.Label(cards, text=text, font=("Segoe UI", 8, "bold"),
                     bg=BG, fg=MUTED).pack(anchor="w", pady=(8, 2))

        section("PERCENTILE CUTOFFS")
        for i, (label, key, _, color, subtitle) in enumerate(TIERS[:3]):
            self._make_card(cards, i, label, color, subtitle)

        section("ACHIEVEMENT THRESHOLDS")
        for i, (label, key, _, color, subtitle) in enumerate(TIERS[3:], start=3):
            self._make_card(cards, i, label, color, subtitle)

        footer = tk.Frame(self, bg=SURFACE, pady=6)
        footer.pack(fill="x", side="bottom")
        tk.Label(footer, text="Data provided by Raider.IO  •  raider.io",
                 font=("Segoe UI", 8), bg=SURFACE, fg=MUTED).pack()

    def _make_card(self, parent, idx, label, color, subtitle):
        card = tk.Frame(parent, bg=CARD, pady=8, padx=14)
        card.pack(fill="x", pady=3)

        left = tk.Frame(card, bg=CARD)
        left.pack(side="left")
        tk.Label(left, text=label, font=("Segoe UI", 11, "bold"),
                 bg=CARD, fg=color).pack(anchor="w")
        tk.Label(left, text=subtitle, font=("Segoe UI", 8),
                 bg=CARD, fg=MUTED).pack(anchor="w")

        score_lbl = tk.Label(card, text="—", font=("Segoe UI", 15, "bold"),
                             bg=CARD, fg=MUTED)
        score_lbl.pack(side="right")
        self._widgets[idx] = (score_lbl, color)

    def _start_fetch(self):
        self._refresh_btn.config(state="disabled")
        self._status_var.set("Fetching from Raider.IO…")
        for idx, (lbl, _) in self._widgets.items():
            lbl.config(text="—", fg=MUTED)
        threading.Thread(target=self._fetch_worker, daemon=True).start()

    def _fetch_worker(self):
        for slug in SEASON_SLUGS:
            try:
                req = urllib.request.Request(build_api_url(slug), headers={
                    "User-Agent": "MplusCutoffsViewer/3.0",
                    "Accept": "application/json",
                })
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                self.after(0, lambda d=data, s=slug: self._apply(d, s))
                return
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    continue
                self.after(0, lambda e=e: self._err(f"HTTP {e.code}"))
                return
            except Exception as e:
                self.after(0, lambda e=e: self._err(str(e)))
                return
        self.after(0, lambda: self._err("No active season found"))

    def _apply(self, data: dict, slug: str):
        self._refresh_btn.config(state="normal")
        cutoffs = data.get("cutoffs", {})

        self._season_label.config(text=f"Season: {slug}")

        for idx, (label, key, score_field, color, _) in enumerate(TIERS):
            lbl, clr = self._widgets[idx]
            entry = cutoffs.get(key)
            if entry is None:
                continue

            if score_field == "score":
                # Fixed threshold — score is at root of entry
                val = entry.get("score")
                if val is not None:
                    lbl.config(text=f"{val:,.0f}", fg=clr)
            else:
                # Percentile — score is nested under .all.quantileMinValue
                all_data = entry.get("all", {})
                val = all_data.get("quantileMinValue")
                if val is not None:
                    lbl.config(text=f"{val:,.2f}", fg=clr)

        updated = cutoffs.get("updatedAt")
        if updated:
            try:
                # Format: "Sat Jun 27 2026 09:48:03 GMT+0000 ..."
                ts_part = updated.split(" GMT")[0]
                dt = datetime.strptime(ts_part, "%a %b %d %Y %H:%M:%S")
                self._status_var.set(f"Raider.IO updated: {dt.strftime('%d %b %Y  %H:%M')} UTC")
                return
            except Exception:
                pass
        self._status_var.set(f"Fetched at {datetime.now().strftime('%d %b %Y  %H:%M:%S')}")

    def _err(self, msg):
        self._refresh_btn.config(state="normal")
        self._status_var.set(f"Error: {msg}")
        messagebox.showerror("Error", f"Failed to load data:\n{msg}")


if __name__ == "__main__":
    app = CutoffsApp()
    app.mainloop()