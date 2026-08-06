"""
WoW Mythic+ EU Cutoffs + Character Tracker
Data provided by Raider.IO (https://raider.io)
"""

import tkinter as tk
from tkinter import messagebox
import urllib.request
import urllib.error
import json
import threading
from datetime import datetime

# ── defaults ──────────────────────────────────────────────────────────────────
DEFAULT_REGION = "eu"
DEFAULT_REALM  = "ragnaros"
DEFAULT_NAME   = "Memfx"

SEASON_SLUGS = ["season-mn-1", "season-tww-3", "season-tww-2"]

def cutoffs_url(season):
    return f"https://raider.io/api/v1/mythic-plus/season-cutoffs?season={season}&region={DEFAULT_REGION}"

def char_url(region, realm, name, season):
    fields = "mythic_plus_scores_by_season:current,mythic_plus_ranks"
    return (f"https://raider.io/api/v1/characters/profile"
            f"?region={region}&realm={realm}&name={name}&fields={fields}")

# ── colours ───────────────────────────────────────────────────────────────────
BG        = "#1a1a2e"
SURFACE   = "#16213e"
CARD      = "#0f3460"
CARD2     = "#0d2d52"
ACCENT    = "#e94560"
TEXT      = "#eaeaea"
MUTED     = "#8892a4"
BAR_BG    = "#0a1628"
BAR_FILL  = "#e94560"
BAR_DONE  = "#4ade80"

# ── tier definitions ──────────────────────────────────────────────────────────
# (label, cutoffs_key, score_field, colour, subtitle, is_target)
TIERS = [
    ("All Stars",         "p999",              "pct",   "#ffd700", "Top 0.1%  •  Seasonal title",    True),
    ("Top 1%",            "p990",              "pct",   "#f472b6", "Top 1%",                          True),
    ("Top 10%",           "p900",              "pct",   "#a78bfa", "Top 10%",                         False),
    ("Keystone Myth",     "keystoneMyth",      "fixed", "#e94560", "Fixed score threshold",           False),
    ("Keystone Legend",   "keystoneLegend",    "fixed", "#f97316", "Fixed score threshold",           False),
    ("Keystone Hero",     "keystoneHero",      "fixed", "#60a5fa", "Fixed score threshold",           False),
    ("Keystone Master",   "keystoneMaster",    "fixed", "#4ade80", "Fixed score threshold",           False),
    ("Keystone Conqueror","keystoneConqueror", "fixed", "#a3e635", "Fixed score threshold",           False),
]


class CutoffsApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("M+ EU Cutoffs — Raider.IO")
        self.configure(bg=BG)
        self.resizable(False, False)

        self._cutoff_scores  = {}   # key → score value
        self._char_score     = None
        self._char_rank      = None
        self._char_name_var  = tk.StringVar(value=DEFAULT_NAME)
        self._char_realm_var = tk.StringVar(value=DEFAULT_REALM)

        self._tier_widgets   = {}   # idx → (score_lbl, bar_canvas, gap_lbl)

        self._build_ui()
        self.after(100, self._start_fetch_all)

    # ══════════════════════════════════════════════════════════════════════════
    # UI BUILD
    # ══════════════════════════════════════════════════════════════════════════

    def _build_ui(self):
        # ── header ────────────────────────────────────────────────────────────
        hdr = tk.Frame(self, bg=ACCENT, pady=10)
        hdr.pack(fill="x")
        tk.Label(hdr, text="⚔  Mythic+ EU Cutoffs",
                 font=("Segoe UI", 18, "bold"), bg=ACCENT, fg="white").pack()
        self._season_lbl = tk.Label(hdr, text="Season: loading…",
                 font=("Segoe UI", 10), bg=ACCENT, fg="#ffd0d0")
        self._season_lbl.pack()

        # ── character panel ───────────────────────────────────────────────────
        char_frame = tk.Frame(self, bg=CARD2, padx=16, pady=10)
        char_frame.pack(fill="x", padx=0)

        top_row = tk.Frame(char_frame, bg=CARD2)
        top_row.pack(fill="x")

        tk.Label(top_row, text="👤 Character", font=("Segoe UI", 9, "bold"),
                 bg=CARD2, fg=MUTED).pack(side="left")

        # name / realm inputs
        input_row = tk.Frame(char_frame, bg=CARD2)
        input_row.pack(fill="x", pady=(4, 0))

        tk.Label(input_row, text="Name:", font=("Segoe UI", 9),
                 bg=CARD2, fg=MUTED).pack(side="left")
        name_entry = tk.Entry(input_row, textvariable=self._char_name_var,
                 font=("Segoe UI", 9), bg=SURFACE, fg=TEXT,
                 insertbackground=TEXT, relief="flat", width=14)
        name_entry.pack(side="left", padx=(4, 10))

        tk.Label(input_row, text="Realm:", font=("Segoe UI", 9),
                 bg=CARD2, fg=MUTED).pack(side="left")
        realm_entry = tk.Entry(input_row, textvariable=self._char_realm_var,
                 font=("Segoe UI", 9), bg=SURFACE, fg=TEXT,
                 insertbackground=TEXT, relief="flat", width=14)
        realm_entry.pack(side="left", padx=(4, 10))

        tk.Button(input_row, text="Look up", font=("Segoe UI", 9, "bold"),
                 bg=ACCENT, fg="white", relief="flat", padx=8, pady=1,
                 cursor="hand2", command=self._start_fetch_char).pack(side="left")

        # score display row
        score_row = tk.Frame(char_frame, bg=CARD2)
        score_row.pack(fill="x", pady=(8, 0))

        self._char_score_lbl = tk.Label(score_row, text="Score: —",
                 font=("Segoe UI", 13, "bold"), bg=CARD2, fg=TEXT)
        self._char_score_lbl.pack(side="left")

        self._char_rank_lbl = tk.Label(score_row, text="",
                 font=("Segoe UI", 9), bg=CARD2, fg=MUTED)
        self._char_rank_lbl.pack(side="left", padx=(12, 0))

        self._char_status_lbl = tk.Label(score_row, text="",
                 font=("Segoe UI", 9, "italic"), bg=CARD2, fg=MUTED)
        self._char_status_lbl.pack(side="right")

        # ── status bar ────────────────────────────────────────────────────────
        bar = tk.Frame(self, bg=SURFACE, pady=5)
        bar.pack(fill="x")
        self._status_var = tk.StringVar(value="Connecting…")
        tk.Label(bar, textvariable=self._status_var,
                 font=("Segoe UI", 9), bg=SURFACE, fg=MUTED).pack(side="left", padx=12)
        self._refresh_btn = tk.Button(bar, text="↻ Refresh",
                 font=("Segoe UI", 9, "bold"), bg=CARD, fg=TEXT,
                 relief="flat", padx=10, pady=2, cursor="hand2",
                 command=self._start_fetch_all)
        self._refresh_btn.pack(side="right", padx=12)

        # ── tier cards ────────────────────────────────────────────────────────
        cards = tk.Frame(self, bg=BG, padx=16, pady=8)
        cards.pack(fill="both", expand=True)

        def section(text):
            tk.Label(cards, text=text, font=("Segoe UI", 8, "bold"),
                     bg=BG, fg=MUTED).pack(anchor="w", pady=(6, 2))

        section("PERCENTILE CUTOFFS")
        for i in range(3):
            self._make_card(cards, i)

        section("ACHIEVEMENT THRESHOLDS")
        for i in range(3, len(TIERS)):
            self._make_card(cards, i)

        # ── footer ────────────────────────────────────────────────────────────
        footer = tk.Frame(self, bg=SURFACE, pady=5)
        footer.pack(fill="x", side="bottom")
        tk.Label(footer, text="Data provided by Raider.IO  •  raider.io",
                 font=("Segoe UI", 8), bg=SURFACE, fg=MUTED).pack()

    def _make_card(self, parent, idx):
        label, key, kind, color, subtitle, is_target = TIERS[idx]

        card = tk.Frame(parent, bg=CARD, pady=8, padx=14)
        card.pack(fill="x", pady=3)

        # top row: label left, score right
        top = tk.Frame(card, bg=CARD)
        top.pack(fill="x")

        left = tk.Frame(top, bg=CARD)
        left.pack(side="left")
        tk.Label(left, text=label, font=("Segoe UI", 11, "bold"),
                 bg=CARD, fg=color).pack(anchor="w")
        tk.Label(left, text=subtitle, font=("Segoe UI", 8),
                 bg=CARD, fg=MUTED).pack(anchor="w")

        right = tk.Frame(top, bg=CARD)
        right.pack(side="right", anchor="e")

        gap_lbl = tk.Label(right, text="", font=("Segoe UI", 8),
                           bg=CARD, fg=MUTED)
        gap_lbl.pack(anchor="e")

        score_lbl = tk.Label(right, text="—", font=("Segoe UI", 15, "bold"),
                             bg=CARD, fg=MUTED)
        score_lbl.pack(anchor="e")

        # progress bar (only for target tiers)
        bar_canvas = None
        if is_target:
            bar_canvas = tk.Canvas(card, height=5, bg=BAR_BG,
                                   highlightthickness=0)
            bar_canvas.pack(fill="x", pady=(6, 0))

        self._tier_widgets[idx] = (score_lbl, bar_canvas, gap_lbl)

    # ══════════════════════════════════════════════════════════════════════════
    # FETCH ORCHESTRATION
    # ══════════════════════════════════════════════════════════════════════════

    def _start_fetch_all(self):
        self._refresh_btn.config(state="disabled")
        self._status_var.set("Fetching cutoffs…")
        self._char_status_lbl.config(text="fetching…")
        for idx, (slbl, bar, glbl) in self._tier_widgets.items():
            slbl.config(text="—", fg=MUTED)
            glbl.config(text="")
            if bar:
                bar.delete("all")
        threading.Thread(target=self._fetch_cutoffs_worker, daemon=True).start()
        threading.Thread(target=self._fetch_char_worker, daemon=True).start()

    def _start_fetch_char(self):
        self._char_status_lbl.config(text="fetching…")
        self._char_score_lbl.config(text="Score: —", fg=TEXT)
        self._char_rank_lbl.config(text="")
        for idx, (_, bar, glbl) in self._tier_widgets.items():
            glbl.config(text="")
            if bar:
                bar.delete("all")
        threading.Thread(target=self._fetch_char_worker, daemon=True).start()

    # ══════════════════════════════════════════════════════════════════════════
    # CUTOFFS FETCH
    # ══════════════════════════════════════════════════════════════════════════

    def _fetch_cutoffs_worker(self):
        for slug in SEASON_SLUGS:
            try:
                req = urllib.request.Request(cutoffs_url(slug), headers={
                    "User-Agent": "MplusCutoffsViewer/4.0", "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    data = json.loads(r.read().decode())
                self.after(0, lambda d=data, s=slug: self._apply_cutoffs(d, s))
                return
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    continue
                self.after(0, lambda e=e: self._err(f"Cutoffs HTTP {e.code}"))
                return
            except Exception as e:
                self.after(0, lambda e=e: self._err(str(e)))
                return
        self.after(0, lambda: self._err("No active season found"))

    def _apply_cutoffs(self, data, slug):
        self._season_lbl.config(text=f"Season: {slug}")
        cutoffs = data.get("cutoffs", {})

        for idx, (label, key, kind, color, subtitle, _) in enumerate(TIERS):
            slbl, bar, glbl = self._tier_widgets[idx]
            entry = cutoffs.get(key)
            if entry is None:
                continue

            if kind == "fixed":
                val = entry.get("score")
            else:
                val = entry.get("all", {}).get("quantileMinValue")

            if val is not None:
                self._cutoff_scores[key] = float(val)
                slbl.config(text=f"{val:,.2f}" if kind == "pct" else f"{val:,.0f}", fg=color)

        updated = cutoffs.get("updatedAt", "")
        try:
            ts = datetime.strptime(updated.split(" GMT")[0], "%a %b %d %Y %H:%M:%S")
            self._status_var.set(f"Updated: {ts.strftime('%d %b %Y  %H:%M')} UTC")
        except Exception:
            self._status_var.set(f"Fetched at {datetime.now().strftime('%d %b %Y  %H:%M:%S')}")

        self._refresh_btn.config(state="normal")
        self._update_gaps()

    # ══════════════════════════════════════════════════════════════════════════
    # CHARACTER FETCH
    # ══════════════════════════════════════════════════════════════════════════

    def _fetch_char_worker(self):
        region = DEFAULT_REGION
        realm  = self._char_realm_var.get().strip().lower()
        name   = self._char_name_var.get().strip()

        # Try each season slug until we get scores
        for slug in SEASON_SLUGS:
            url = char_url(region, realm, name, slug)
            try:
                req = urllib.request.Request(url, headers={
                    "User-Agent": "MplusCutoffsViewer/4.0", "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    data = json.loads(r.read().decode())

                scores_list = data.get("mythic_plus_scores_by_season", [])
                ranks_obj   = data.get("mythic_plus_ranks", {})
                score = None
                for s in scores_list:
                    if s.get("season") == slug:
                        score = s.get("scores", {}).get("all")
                        break
                if score is None and scores_list:
                    score = scores_list[0].get("scores", {}).get("all")

                rank_overall = ranks_obj.get("overall", {}).get("realm") if ranks_obj else None

                self.after(0, lambda sc=score, rk=rank_overall, n=name: self._apply_char(sc, rk, n))
                return

            except urllib.error.HTTPError as e:
                if e.code == 400 or e.code == 404:
                    self.after(0, lambda: self._char_status_lbl.config(
                        text=f"Character not found", fg=ACCENT))
                    self.after(0, lambda: self._char_score_lbl.config(text="Score: —", fg=MUTED))
                    return
                continue
            except Exception as e:
                self.after(0, lambda e=e: self._char_status_lbl.config(
                    text=f"Error: {e}", fg=ACCENT))
                return

    def _apply_char(self, score, rank, name):
        if score is None:
            self._char_score_lbl.config(text="Score: —", fg=MUTED)
            self._char_status_lbl.config(text="No score yet this season", fg=MUTED)
            return

        self._char_score = float(score)
        self._char_rank  = rank

        score_color = "#ffd700" if score >= 4000 else \
                      "#f472b6" if score >= 3800 else \
                      "#a78bfa" if score >= 3400 else TEXT

        self._char_score_lbl.config(
            text=f"{name}  —  {score:,.2f}", fg=score_color)

        if rank:
            self._char_rank_lbl.config(text=f"Realm rank #{rank}", fg=MUTED)
        self._char_status_lbl.config(text="✓ up to date", fg="#4ade80")

        self._update_gaps()

    # ══════════════════════════════════════════════════════════════════════════
    # GAP / PROGRESS BAR UPDATE
    # ══════════════════════════════════════════════════════════════════════════

    def _update_gaps(self):
        if self._char_score is None:
            return

        for idx, (label, key, kind, color, subtitle, is_target) in enumerate(TIERS):
            slbl, bar, glbl = self._tier_widgets[idx]
            cutoff = self._cutoff_scores.get(key)
            if cutoff is None:
                continue

            diff = cutoff - self._char_score

            if diff <= 0:
                glbl.config(text="✓ achieved!", fg="#4ade80")
            else:
                glbl.config(text=f"−{diff:,.0f} pts to go", fg=ACCENT if is_target else MUTED)

            if bar and is_target:
                self._draw_bar(bar, self._char_score, cutoff, diff <= 0)

    def _draw_bar(self, canvas, char_score, cutoff, achieved):
        canvas.update_idletasks()
        w = canvas.winfo_width()
        if w < 10:
            w = 360

        if achieved:
            canvas.delete("all")
            canvas.create_rectangle(0, 0, w, 5, fill=BAR_DONE, outline="")
            return

        # start from a reasonable baseline (cutoff - 1500 or 0)
        baseline = max(0, cutoff - 1500)
        span     = cutoff - baseline
        if span <= 0:
            return
        fill_w = max(0, min(w, int((char_score - baseline) / span * w)))

        canvas.delete("all")
        canvas.create_rectangle(0, 0, w,      5, fill=BAR_BG,   outline="")
        canvas.create_rectangle(0, 0, fill_w, 5, fill=BAR_FILL, outline="")

    # ══════════════════════════════════════════════════════════════════════════
    # ERROR
    # ══════════════════════════════════════════════════════════════════════════

    def _err(self, msg):
        self._refresh_btn.config(state="normal")
        self._status_var.set(f"Error: {msg}")
        messagebox.showerror("Error", f"Failed to load data:\n{msg}")


if __name__ == "__main__":
    app = CutoffsApp()
    app.mainloop()