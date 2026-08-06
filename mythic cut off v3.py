"""
M+ EU Cutoffs — Raider.IO
3-column dashboard: dungeon breakdown | cutoffs + character | dungeon breakdown
Data provided by Raider.IO (https://raider.io)
"""

import tkinter as tk
from tkinter import font as tkfont
import urllib.request
import urllib.error
import json
import threading
from datetime import datetime

# ═══════════════════════════════════════════════════════════════════════════════
# LAYOUT CONSTANTS
# ═══════════════════════════════════════════════════════════════════════════════

COL_SIDE  = 220   # width of each dungeon panel
COL_MID   = 460   # width of center panel
WIN_W     = COL_SIDE + COL_MID + COL_SIDE   # 900
WIN_H     = 940

MID_X     = COL_SIDE          # center panel starts here
RIGHT_X   = COL_SIDE + COL_MID

PAD       = 16
TB_H      = 40    # title bar height

DEFAULT_REGION = "eu"
DEFAULT_REALM  = "ragnaros"
DEFAULT_NAME   = "Memfx"

SEASON_SLUGS = ["season-mn-1", "season-tww-3", "season-tww-2"]

def cutoffs_api(season):
    return (f"https://raider.io/api/v1/mythic-plus/season-cutoffs"
            f"?season={season}&region={DEFAULT_REGION}")

def char_api(region, realm, name):
    fields = ("mythic_plus_scores_by_season:current"
              ",mythic_plus_ranks"
              ",mythic_plus_best_runs"
              ",mythic_plus_highest_level_runs")
    return (f"https://raider.io/api/v1/characters/profile"
            f"?region={region}&realm={realm}&name={name}&fields={fields}")

# ═══════════════════════════════════════════════════════════════════════════════
# PALETTE
# ═══════════════════════════════════════════════════════════════════════════════

C = {
    # Backgrounds
    "bg":         "#0d1117",
    "surface":    "#161b22",
    "raised":     "#1f2937",
    "border":     "#30363d",
    "border_hi":  "#444c56",

    # Text
    "text":       "#e6edf3",
    "muted":      "#7d8590",
    "dim":        "#3d444d",

    # Accents / tiers
    "gold":       "#ffd700",
    "pink":       "#e879a0",
    "purple":     "#a78bfa",
    "blue":       "#60a5fa",
    "orange":     "#fb923c",
    "green":      "#4ade80",
    "lime":       "#a3e635",
    "red":        "#f87171",

    # Functional
    "push":       "#fbbf24",   # "push this" highlight
    "achieved":   "#4ade80",
    "depleted":   "#6b7280",
    "danger":     "#ef4444",
    "titlebar":   "#0d1117",
    "divider":    "#21262d",
}

TIER_COLORS = {
    "p999":              C["gold"],
    "p990":              C["pink"],
    "p900":              C["purple"],
    "keystoneMyth":      C["red"],
    "keystoneLegend":    C["orange"],
    "keystoneHero":      C["blue"],
    "keystoneMaster":    C["green"],
    "keystoneConqueror": C["lime"],
}

TIERS = [
    ("All Stars",          "p999",              "pct",   "Top 0.1%  ·  Seasonal title",  True),
    ("Top 1%",             "p990",              "pct",   "Top 1%",                        True),
    ("Top 10%",            "p900",              "pct",   "Top 10%",                       False),
    ("Keystone Myth",      "keystoneMyth",      "fixed", "Fixed threshold",               False),
    ("Keystone Legend",    "keystoneLegend",    "fixed", "Fixed threshold",               False),
    ("Keystone Hero",      "keystoneHero",      "fixed", "Fixed threshold",               False),
    ("Keystone Master",    "keystoneMaster",    "fixed", "Fixed threshold",               False),
    ("Keystone Conqueror", "keystoneConqueror", "fixed", "Fixed threshold",               False),
]

ANIM_MS  = 700
ANIM_FPS = 60

# ═══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def ease_out(t):
    return 1 - (1 - t) ** 3

def rr(canvas, x1, y1, x2, y2, r=6, **kw):
    """Filled rounded rect."""
    pts = [x1+r,y1, x2-r,y1, x2,y1, x2,y1+r,
           x2,y2-r, x2,y2, x2-r,y2, x1+r,y2,
           x1,y2, x1,y2-r, x1,y1+r, x1,y1, x1+r,y1]
    return canvas.create_polygon(pts, smooth=True, **kw)

def rr_outline(canvas, x1, y1, x2, y2, r=6, color="#30363d", width=1):
    """Rounded rect border only."""
    pts = [x1+r,y1, x2-r,y1, x2,y1, x2,y1+r,
           x2,y2-r, x2,y2, x2-r,y2, x1+r,y2,
           x1,y2, x1,y2-r, x1,y1+r, x1,y1, x1+r,y1]
    return canvas.create_polygon(pts, smooth=True, fill="", outline=color, width=width)

def pick_font():
    for fam in ["Segoe UI", "Helvetica Neue", "Arial"]:
        try:
            f = tkfont.Font(family=fam, size=10)
            if "courier" not in f.actual("family").lower():
                return fam
        except Exception:
            pass
    return "TkDefaultFont"

def ms_to_mmss(ms):
    s = ms // 1000
    return f"{s//60}:{s%60:02d}"

def upgrade_pips(n):
    """0=depleted, 1=timed, 2=+2, 3=+3"""
    if n == 0:   return "✗"
    if n == 1:   return "+"
    if n == 2:   return "++"
    return "+++"

# ═══════════════════════════════════════════════════════════════════════════════
# MAIN APP
# ═══════════════════════════════════════════════════════════════════════════════

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self._fam       = pick_font()
        self._jobs      = []
        self._cutoffs   = {}
        self._char_score = None
        self._best_runs  = []    # timed
        self._high_runs  = []    # highest (incl depleted)
        self._name_var   = tk.StringVar(value=DEFAULT_NAME)
        self._realm_var  = tk.StringVar(value=DEFAULT_REALM)

        self._tooltip    = None   # Toplevel window, created on demand

        self.overrideredirect(True)
        self.configure(bg=C["bg"])
        self.geometry(f"{WIN_W}x{WIN_H}")
        self._center()
        self.attributes("-alpha", 0.0)

        # Windows 11 rounded corners
        try:
            from ctypes import windll, c_int, byref
            windll.dwmapi.DwmSetWindowAttribute(
                self.winfo_id(), 33, byref(c_int(2)), 4)
        except Exception:
            pass

        self._cv = tk.Canvas(self, bg=C["bg"], highlightthickness=0,
                             width=WIN_W, height=WIN_H)
        self._cv.pack(fill="both", expand=True)

        # outer border
        rr_outline(self._cv, 1, 1, WIN_W-1, WIN_H-1, r=10,
                   color=C["border"], width=1)

        self._build_titlebar()
        self._build_center()
        self._build_side_panels()
        self._build_footer()

        self.after(50,  self._fade_in)
        self.after(120, self._fetch_all)

    # ── window helpers ────────────────────────────────────────────────────────

    def _center(self):
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        self.geometry(f"{WIN_W}x{WIN_H}+{(sw-WIN_W)//2}+{(sh-WIN_H)//2}")

    def _fade_in(self, s=0, steps=18):
        self.attributes("-alpha", min(s/steps, 1.0))
        if s < steps:
            self.after(14, lambda: self._fade_in(s+1, steps))

    # ── drag ─────────────────────────────────────────────────────────────────

    def _drag_start(self, e):
        self._dx = e.x_root - self.winfo_x()
        self._dy = e.y_root - self.winfo_y()

    def _drag_move(self, e):
        self.geometry(f"+{e.x_root-self._dx}+{e.y_root-self._dy}")

    # ─────────────────────────────────────────────────────────────────────────
    # TITLE BAR
    # ─────────────────────────────────────────────────────────────────────────

    def _build_titlebar(self):
        c = self._cv
        rr(c, 2, 2, WIN_W-2, TB_H, r=10, fill=C["titlebar"], outline="")
        c.create_line(0, TB_H, WIN_W, TB_H, fill=C["divider"], width=1)

        c.create_text(PAD, TB_H//2, text="M+  EU  Cutoffs",
                      font=(self._fam, 10, "bold"),
                      fill=C["text"], anchor="w")

        c.bind("<ButtonPress-1>", self._drag_start)
        c.bind("<B1-Motion>",     self._drag_move)

        # status text (center of titlebar)
        self._tb_status = c.create_text(WIN_W//2, TB_H//2, text="",
                                         font=(self._fam, 8),
                                         fill=C["muted"], anchor="center")

        self._add_tb_btn(WIN_W-18, "✕", C["danger"],  self.destroy)
        self._add_tb_btn(WIN_W-42, "—", C["border_hi"],
                         lambda: (self.overrideredirect(False),
                                  self.iconify(),
                                  self.bind("<Map>", lambda e: (
                                      self.overrideredirect(True),
                                      self.unbind("<Map>")))))

    def _add_tb_btn(self, cx, glyph, hover_col, cmd):
        c   = self._cv
        r   = 9
        bg  = c.create_oval(cx-r, TB_H//2-r, cx+r, TB_H//2+r,
                             fill=C["raised"], outline=C["border"])
        txt = c.create_text(cx, TB_H//2, text=glyph,
                             font=(self._fam, 8, "bold"), fill=C["muted"])
        for tag in (bg, txt):
            c.tag_bind(tag, "<Enter>",
                       lambda e, b=bg, t=txt, col=hover_col:
                           (c.itemconfig(b, fill=col),
                            c.itemconfig(t, fill=C["text"])))
            c.tag_bind(tag, "<Leave>",
                       lambda e, b=bg, t=txt:
                           (c.itemconfig(b, fill=C["raised"]),
                            c.itemconfig(t, fill=C["muted"])))
            c.tag_bind(tag, "<ButtonPress-1>", lambda e, fn=cmd: fn())

    # ─────────────────────────────────────────────────────────────────────────
    # CENTER PANEL
    # ─────────────────────────────────────────────────────────────────────────

    def _build_center(self):
        c   = self._cv
        x0  = MID_X
        x1  = MID_X + COL_MID
        y   = TB_H

        # vertical separator lines
        c.create_line(x0, TB_H+1, x0, WIN_H-1, fill=C["divider"], width=1)
        c.create_line(x1, TB_H+1, x1, WIN_H-1, fill=C["divider"], width=1)

        # ── Hero block ───────────────────────────────────────────────────────
        cx = x0 + COL_MID // 2   # center of middle column

        c.create_text(x0+PAD, y+18, text="YOUR SCORE",
                      font=(self._fam, 8, "bold"),
                      fill=C["muted"], anchor="w")

        self._hero_score = c.create_text(x0+PAD, y+62,
                                          text="—",
                                          font=(self._fam, 44, "bold"),
                                          fill=C["text"], anchor="w")

        self._hero_name  = c.create_text(x0+PAD, y+108,
                                          text="Loading…",
                                          font=(self._fam, 13, "bold"),
                                          fill=C["text"], anchor="w")

        self._hero_sub   = c.create_text(x0+PAD, y+126,
                                          text="",
                                          font=(self._fam, 10),
                                          fill=C["muted"], anchor="w")

        # accent rule
        self._hero_rule  = c.create_line(x0+PAD, y+142, x0+PAD, y+142,
                                          fill=C["pink"], width=2)

        # ── Character input ──────────────────────────────────────────────────
        iy = y + 160

        c.create_text(x0+PAD, iy, text="CHARACTER",
                      font=(self._fam, 8, "bold"),
                      fill=C["muted"], anchor="w")

        # Name entry
        nf = tk.Frame(self, bg=C["raised"],
                      highlightbackground=C["border"], highlightthickness=1)
        self._name_entry = tk.Entry(nf, textvariable=self._name_var,
                                    font=(self._fam, 10),
                                    bg=C["raised"], fg=C["text"],
                                    insertbackground=C["text"],
                                    relief="flat", bd=5, width=11)
        self._name_entry.pack()
        c.create_window(x0+PAD, iy+14, window=nf, anchor="nw")

        # Realm entry
        rf = tk.Frame(self, bg=C["raised"],
                      highlightbackground=C["border"], highlightthickness=1)
        self._realm_entry = tk.Entry(rf, textvariable=self._realm_var,
                                     font=(self._fam, 10),
                                     bg=C["raised"], fg=C["text"],
                                     insertbackground=C["text"],
                                     relief="flat", bd=5, width=11)
        self._realm_entry.pack()
        c.create_window(x0+PAD+148, iy+14, window=rf, anchor="nw")

        # Look up button
        bx1, by1 = x1-PAD-72, iy+12
        bx2, by2 = x1-PAD,    iy+38
        bb  = rr(c, bx1, by1, bx2, by2, r=5, fill=C["raised"], outline="")
        rr_outline(c, bx1, by1, bx2, by2, r=5, color=C["border"])
        bt  = c.create_text((bx1+bx2)//2, (by1+by2)//2,
                             text="Look up",
                             font=(self._fam, 9, "bold"),
                             fill=C["text"])
        for tag in (bb, bt):
            c.tag_bind(tag, "<Enter>",
                       lambda e, b=bb, t=bt:
                           (c.itemconfig(b, fill=C["border_hi"]),
                            c.itemconfig(t, fill=C["text"])))
            c.tag_bind(tag, "<Leave>",
                       lambda e, b=bb, t=bt:
                           (c.itemconfig(b, fill=C["raised"]),
                            c.itemconfig(t, fill=C["text"])))
            c.tag_bind(tag, "<ButtonPress-1>",
                       lambda e: self._fetch_char())

        self._name_entry.bind("<Return>",  lambda e: self._fetch_char())
        self._realm_entry.bind("<Return>", lambda e: self._fetch_char())

        # ── Divider + refresh ────────────────────────────────────────────────
        dy = iy + 52
        c.create_line(x0+PAD, dy, x1-PAD, dy, fill=C["divider"], width=1)

        self._status_item = c.create_text(x0+PAD, dy+14, text="Connecting…",
                                           font=(self._fam, 8),
                                           fill=C["muted"], anchor="w")

        rx1, ry1 = x1-PAD-64, dy+4
        rx2, ry2 = x1-PAD,    dy+24
        rb  = rr(c, rx1, ry1, rx2, ry2, r=4, fill=C["raised"], outline="")
        rr_outline(c, rx1, ry1, rx2, ry2, r=4, color=C["border"])
        rt  = c.create_text((rx1+rx2)//2, (ry1+ry2)//2,
                             text="↻  Refresh",
                             font=(self._fam, 8), fill=C["muted"])
        for tag in (rb, rt):
            c.tag_bind(tag, "<Enter>",
                       lambda e, b=rb, t=rt:
                           (c.itemconfig(b, fill=C["border_hi"]),
                            c.itemconfig(t, fill=C["text"])))
            c.tag_bind(tag, "<Leave>",
                       lambda e, b=rb, t=rt:
                           (c.itemconfig(b, fill=C["raised"]),
                            c.itemconfig(t, fill=C["muted"])))
            c.tag_bind(tag, "<ButtonPress-1>",
                       lambda e: self._fetch_all())

        # ── Tier cards ───────────────────────────────────────────────────────
        self._tier_w = {}
        ty = dy + 36
        CARD_PAD  = 8
        H_TARGET  = 74
        H_FLAT    = 58
        CARD_GAP  = 8

        for idx, (label, key, kind, subtitle, is_target) in enumerate(TIERS):
            h   = H_TARGET if is_target else H_FLAT
            cx1 = x0 + CARD_PAD
            cy1 = ty
            cx2 = x1 - CARD_PAD
            cy2 = ty + h
            col = TIER_COLORS.get(key, C["text"])

            rr(c, cx1, cy1, cx2, cy2, r=6, fill=C["surface"], outline="")
            rr_outline(c, cx1, cy1, cx2, cy2, r=6, color=C["border"])

            # left color stripe
            stripe = c.create_line(cx1+2, cy1+8, cx1+2, cy2-8,
                                   fill=C["dim"], width=2)

            c.create_text(cx1+14, cy1+14, text=label,
                          font=(self._fam, 11, "bold"),
                          fill=col, anchor="w")
            c.create_text(cx1+14, cy1+28, text=subtitle,
                          font=(self._fam, 8),
                          fill=C["muted"], anchor="w")

            score_lbl = c.create_text(cx2-12, cy1+14, text="—",
                                       font=(self._fam, 17, "bold"),
                                       fill=C["dim"], anchor="e")
            gap_lbl   = c.create_text(cx2-12, cy1+30, text="",
                                       font=(self._fam, 8),
                                       fill=C["muted"], anchor="e")

            # progress bar for target tiers
            bar_bg = bar_fill = bar_pct = None
            if is_target:
                bx1 = cx1+14
                bx2 = cx2-50
                by1 = cy2-16
                by2 = cy2-8
                bar_bg   = rr(c, bx1, by1, bx2, by2, r=3,
                               fill=C["raised"], outline="")
                bar_fill = rr(c, bx1, by1, bx1, by2, r=3,
                               fill=col, outline="")
                bar_pct  = c.create_text(cx2-12, (by1+by2)//2, text="",
                                          font=(self._fam, 7),
                                          fill=C["muted"], anchor="e")

            self._tier_w[idx] = {
                "key": key, "kind": kind, "col": col,
                "is_target": is_target,
                "score_lbl": score_lbl, "gap_lbl": gap_lbl,
                "stripe": stripe,
                "bar_bg": bar_bg, "bar_fill": bar_fill, "bar_pct": bar_pct,
                "cx1": cx1, "cy1": cy1, "cx2": cx2, "cy2": cy2,
            }

            ty += h + CARD_GAP

        self._tiers_bottom = ty

    # ─────────────────────────────────────────────────────────────────────────
    # SIDE PANELS (dungeon breakdown)
    # ─────────────────────────────────────────────────────────────────────────

    def _build_side_panels(self):
        c = self._cv

        # Headers
        self._side_headers = {}
        for side, x0, label in [
            ("left",  0,       "DUNGEONS  ·  TIMED  /  HIGHEST"),
            ("right", RIGHT_X, "DUNGEONS  ·  TIMED  /  HIGHEST"),
        ]:
            c.create_text(x0 + PAD, TB_H + 14, text=label,
                          font=(self._fam, 7, "bold"),
                          fill=C["muted"], anchor="w")
            # small status line under header
            self._side_headers[side] = c.create_text(
                x0 + PAD, TB_H + 26, text="waiting for data…",
                font=(self._fam, 7), fill=C["dim"], anchor="w")

        # Placeholder rows — will be populated after data arrives
        self._dungeon_rows = {"left": [], "right": []}
        self._dungeon_canvas_items = []   # all items; rebuilt on data

    def _build_dungeon_rows(self, dungeons):
        """
        dungeons: list sorted by score contribution asc (weakest first).
        Left panel gets first 4, right panel gets last 4.
        """
        c = self._cv

        # Update header counters
        n_timed = sum(1 for d in dungeons if d["best_level"])
        n_high  = sum(1 for d in dungeons if d["high_level"])
        for side in ("left", "right"):
            c.itemconfig(self._side_headers[side],
                         text=f"{len(dungeons)} dungeons  ·  {n_timed} timed",
                         fill=C["muted"])
        if not dungeons:
            for side in ("left", "right"):
                c.itemconfig(self._side_headers[side],
                             text="no runs found this season",
                             fill=C["dim"])

        # Clear old rows
        for item in self._dungeon_canvas_items:
            try:
                c.delete(item)
            except Exception:
                pass
        self._dungeon_canvas_items = []

        panels = [
            (dungeons[:4], 0,       "left"),
            (dungeons[4:], RIGHT_X, "right"),
        ]

        ROW_H   = 98
        ROW_GAP = 8
        START_Y = TB_H + 44

        for dung_list, x0, side in panels:
            y = START_Y
            for dung in dung_list:
                self._draw_dungeon_row(x0, y, ROW_H, dung)
                y += ROW_H + ROW_GAP

    def _draw_dungeon_row(self, x0, y, h, d):
        c    = self._cv
        items= []
        x1   = x0 + PAD
        x2   = x0 + COL_SIDE - PAD
        y1   = y
        y2   = y + h
        col  = C["push"] if d["is_push"] else C["border"]
        bg   = C["surface"]

        ids = []
        ids.append(rr(c, x1, y1, x2, y2, r=6, fill=bg, outline=""))
        ids.append(rr_outline(c, x1, y1, x2, y2, r=6,
                               color=C["push"] if d["is_push"] else C["border"]))

        # push badge
        if d["is_push"]:
            ids.append(rr(c, x2-44, y1+4, x2-4, y1+18, r=3,
                           fill=C["push"], outline=""))
            ids.append(c.create_text(x2-24, y1+11, text="↑ PUSH",
                                     font=(self._fam, 7, "bold"),
                                     fill=C["bg"]))

        # dungeon short name
        ids.append(c.create_text(x1+8, y1+14,
                                  text=d["short"],
                                  font=(self._fam, 12, "bold"),
                                  fill=C["push"] if d["is_push"] else C["text"],
                                  anchor="w"))

        # full name (truncated)
        full = d["name"] if len(d["name"]) <= 20 else d["name"][:18]+"…"
        ids.append(c.create_text(x1+8, y1+28,
                                  text=full,
                                  font=(self._fam, 7),
                                  fill=C["muted"], anchor="w"))

        # ── Best (timed) run ─────────────────────────────────────
        ids.append(c.create_text(x1+8, y1+46,
                                  text="TIMED",
                                  font=(self._fam, 7, "bold"),
                                  fill=C["muted"], anchor="w"))

        if d["best_level"]:
            pip_col = C["green"] if d["best_pips"] >= 1 else C["depleted"]
            ids.append(c.create_text(x1+8, y1+60,
                                      text=f"+{d['best_level']}",
                                      font=(self._fam, 14, "bold"),
                                      fill=C["green"], anchor="w"))
            ids.append(c.create_text(x1+46, y1+60,
                                      text=upgrade_pips(d["best_pips"]),
                                      font=(self._fam, 9, "bold"),
                                      fill=pip_col, anchor="w"))
            ids.append(c.create_text(x2-6, y1+60,
                                      text=f"{d['best_score']:.0f} pts",
                                      font=(self._fam, 9),
                                      fill=C["text"], anchor="e"))
        else:
            ids.append(c.create_text(x1+8, y1+60, text="No timed run",
                                     font=(self._fam, 9),
                                     fill=C["dim"], anchor="w"))

        # ── Highest run (incl depleted) ───────────────────────────
        ids.append(c.create_text(x1+8, y1+76,
                                  text="HIGHEST",
                                  font=(self._fam, 7, "bold"),
                                  fill=C["muted"], anchor="w"))

        if d["high_level"]:
            depleted = d["high_pips"] == 0
            h_col = C["depleted"] if depleted else C["blue"]
            ids.append(c.create_text(x1+8, y1+88,
                                      text=f"+{d['high_level']}",
                                      font=(self._fam, 11, "bold"),
                                      fill=h_col, anchor="w"))
            dep_txt = "  (depleted)" if depleted else f"  {upgrade_pips(d['high_pips'])}"
            ids.append(c.create_text(x1+36, y1+88,
                                      text=dep_txt,
                                      font=(self._fam, 8),
                                      fill=C["muted"], anchor="w"))
        else:
            ids.append(c.create_text(x1+8, y1+88, text="No run",
                                     font=(self._fam, 9),
                                     fill=C["dim"], anchor="w"))

        # ── Transparent hover target over the whole card ──────────
        # An invisible rectangle on top captures hover events for the row.
        hit = c.create_rectangle(x1, y1, x2, y2, fill="", outline="")
        c.tag_bind(hit, "<Enter>",
                   lambda e, dd=d: self._tooltip_show(dd, e))
        c.tag_bind(hit, "<Motion>",
                   lambda e, dd=d: self._tooltip_move(e))
        c.tag_bind(hit, "<Leave>",
                   lambda e: self._tooltip_hide())
        ids.append(hit)

        self._dungeon_canvas_items.extend(ids)

    # ─────────────────────────────────────────────────────────────────────────
    # FOOTER
    # ─────────────────────────────────────────────────────────────────────────

    def _build_footer(self):
        c = self._cv
        y = WIN_H - 24
        c.create_line(PAD, y-6, WIN_W-PAD, y-6, fill=C["divider"], width=1)
        c.create_text(WIN_W//2, y+2,
                      text="Data provided by Raider.IO  ·  raider.io",
                      font=(self._fam, 7),
                      fill=C["muted"], anchor="center")

    # ─────────────────────────────────────────────────────────────────────────
    # FETCH
    # ─────────────────────────────────────────────────────────────────────────

    def _fetch_all(self):
        self._set_status("Fetching…")
        threading.Thread(target=self._worker_cutoffs, daemon=True).start()
        threading.Thread(target=self._worker_char,    daemon=True).start()

    def _fetch_char(self):
        self._set_status("Looking up character…")
        threading.Thread(target=self._worker_char, daemon=True).start()

    def _worker_cutoffs(self):
        for slug in SEASON_SLUGS:
            try:
                req = urllib.request.Request(cutoffs_api(slug), headers={
                    "User-Agent": "MplusDash/6.0", "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    data = json.loads(r.read().decode())
                self.after(0, lambda d=data, s=slug: self._apply_cutoffs(d, s))
                return
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    continue
                self.after(0, lambda: self._set_status("Cutoffs unavailable"))
                return
            except Exception:
                self.after(0, lambda: self._set_status("Network error"))
                return
        self.after(0, lambda: self._set_status("No active season found"))

    def _worker_char(self):
        region = DEFAULT_REGION
        realm  = self._realm_var.get().strip().lower()
        name   = self._name_var.get().strip()
        try:
            req = urllib.request.Request(char_api(region, realm, name), headers={
                "User-Agent": "MplusDash/6.0", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read().decode())
            self.after(0, lambda d=data, n=name: self._apply_char(d, n))
        except urllib.error.HTTPError as e:
            msg = "Character not found" if e.code in (400,404) else f"HTTP {e.code}"
            self.after(0, lambda m=msg: (
                self._cv.itemconfig(self._hero_name, text=m, fill=C["muted"]),
                self._cv.itemconfig(self._hero_score, text="—", fill=C["dim"])
            ))
        except Exception as e:
            self.after(0, lambda: self._set_status("Network error"))

    # ─────────────────────────────────────────────────────────────────────────
    # APPLY DATA
    # ─────────────────────────────────────────────────────────────────────────

    def _apply_cutoffs(self, data, slug):
        cutoffs = data.get("cutoffs", {})
        for idx, (label, key, kind, subtitle, is_target) in enumerate(TIERS):
            entry = cutoffs.get(key)
            if entry is None:
                continue
            val = entry.get("score") if kind == "fixed" \
                  else entry.get("all", {}).get("quantileMinValue")
            if val is not None:
                self._cutoffs[key] = float(val)
                w = self._tier_w[idx]
                fmt = f"{val:,.0f}"
                self._cv.itemconfig(w["score_lbl"], text=fmt,
                                    fill=TIER_COLORS.get(key, C["text"]))

        updated = cutoffs.get("updatedAt", "")
        try:
            ts = datetime.strptime(updated.split(" GMT")[0], "%a %b %d %Y %H:%M:%S")
            self._set_status(f"Updated {ts.strftime('%d %b %Y  %H:%M')} UTC  ·  {slug}")
        except Exception:
            self._set_status(f"Fetched {datetime.now().strftime('%H:%M:%S')}  ·  {slug}")

        self._update_gaps()

    def _apply_char(self, data, name):
        c = self._cv

        # Score
        scores_list = data.get("mythic_plus_scores_by_season", [])
        score = None
        for s in scores_list:
            sc = s.get("scores", {}).get("all")
            if sc:
                score = sc
                break
        if score is None and scores_list:
            score = scores_list[0].get("scores", {}).get("all", 0)

        # Rank
        ranks = data.get("mythic_plus_ranks") or {}
        rank  = ranks.get("overall", {}).get("realm")

        self._char_score = float(score) if score else None

        if self._char_score:
            self._anim_score(self._char_score, 0)
            self._anim_rule(0)
        else:
            c.itemconfig(self._hero_score, text="No data", fill=C["muted"])

        c.itemconfig(self._hero_name, text=name, fill=C["text"])
        sub = f"Realm rank #{rank}" if rank else ""
        c.itemconfig(self._hero_sub, text=sub, fill=C["muted"])

        # Runs
        self._best_runs = data.get("mythic_plus_best_runs") or []
        self._high_runs = data.get("mythic_plus_highest_level_runs") or []
        self._rebuild_dungeons()
        self._update_gaps()

    def _rebuild_dungeons(self):
        """Merge best_runs and highest_level_runs into a per-dungeon list."""
        # Index highest runs by dungeon name (dungeon is a plain string)
        high_by_name = {}
        for r in self._high_runs:
            name = r.get("dungeon", "")
            high_by_name[name] = r

        # Build dungeon list from best_runs (timed)
        dungeons = []
        for r in self._best_runs:
            name     = r.get("dungeon", "Unknown")
            short    = r.get("short_name") or _short_name(name)
            bl       = r.get("mythic_level", 0)
            bp       = r.get("num_keystone_upgrades", 0)
            bscore   = r.get("score", 0)

            hr       = high_by_name.get(name, {})
            hl       = hr.get("mythic_level", bl)
            hp       = hr.get("num_keystone_upgrades", bp)

            dungeons.append({
                "name":       name,
                "short":      short,
                "best_level": bl,
                "best_pips":  bp,
                "best_score": bscore,
                "high_level": hl,
                "high_pips":  hp,
                "score":      bscore,
                "is_push":    False,
                "best_raw":   r,     # full run dict for tooltip
                "high_raw":   hr,
            })

        # If no best_runs, fall back to highest_level_runs
        if not dungeons:
            for r in self._high_runs:
                name  = r.get("dungeon", "Unknown")
                short = r.get("short_name") or _short_name(name)
                hl    = r.get("mythic_level", 0)
                hp    = r.get("num_keystone_upgrades", 0)
                dungeons.append({
                    "name":       name,
                    "short":      short,
                    "best_level": None,
                    "best_pips":  0,
                    "best_score": 0,
                    "high_level": hl,
                    "high_pips":  hp,
                    "score":      0,
                    "is_push":    False,
                    "best_raw":   {},
                    "high_raw":   r,
                })

        # Sort by score ascending — weakest first
        dungeons.sort(key=lambda d: d["score"])

        # Mark bottom 2 as "push"
        for i in range(min(2, len(dungeons))):
            dungeons[i]["is_push"] = True

        # Re-sort: left panel = dungeons 0,2,4,6 (push ones on top per side)
        # Actually keep weakest-first order, split 4+4
        # Left: first 4 (weakest), Right: last 4 (strongest)
        self._build_dungeon_rows(dungeons)

    # ─────────────────────────────────────────────────────────────────────────
    # GAPS + BARS
    # ─────────────────────────────────────────────────────────────────────────

    def _update_gaps(self):
        if not self._cutoffs:
            return
        c = self._cv
        for idx, (label, key, kind, subtitle, is_target) in enumerate(TIERS):
            w      = self._tier_w[idx]
            cutoff = self._cutoffs.get(key)
            if cutoff is None:
                continue

            if self._char_score is None:
                c.itemconfig(w["gap_lbl"], text="")
                continue

            diff     = cutoff - self._char_score
            achieved = diff <= 0
            col      = TIER_COLORS.get(key, C["text"])

            if achieved:
                c.itemconfig(w["gap_lbl"], text="✓ achieved",
                             fill=C["achieved"])
                c.itemconfig(w["stripe"],  fill=C["achieved"])
            else:
                c.itemconfig(w["gap_lbl"],
                             text=f"−{diff:,.0f} pts to go",
                             fill=C["muted"])
                c.itemconfig(w["stripe"], fill=col)

            if is_target:
                baseline = max(0.0, cutoff - 1500.0)
                span     = cutoff - baseline
                frac     = max(0.0, min(1.0,
                    (self._char_score - baseline) / span)) if span > 0 else 0.0
                self._anim_bar(idx, frac, 0)

    # ─────────────────────────────────────────────────────────────────────────
    # ANIMATIONS
    # ─────────────────────────────────────────────────────────────────────────

    def _cancel_jobs(self):
        for j in self._jobs:
            try:
                self.after_cancel(j)
            except Exception:
                pass
        self._jobs = []

    def _anim_score(self, target, elapsed):
        t   = min(elapsed / ANIM_MS, 1.0)
        val = target * ease_out(t)
        self._cv.itemconfig(self._hero_score,
                             text=f"{val:,.2f}", fill=C["text"])
        if t < 1.0:
            j = self.after(1000//ANIM_FPS,
                           lambda: self._anim_score(target,
                                                    elapsed + 1000//ANIM_FPS))
            self._jobs.append(j)

    def _anim_rule(self, step, steps=22):
        x0  = MID_X + PAD
        x1  = x0 + int(180 * ease_out(step / steps))
        y   = TB_H + 142
        self._cv.coords(self._hero_rule, x0, y, x1, y)
        if step < steps:
            j = self.after(14, lambda: self._anim_rule(step+1, steps))
            self._jobs.append(j)

    def _anim_bar(self, idx, target_frac, elapsed):
        t    = min(elapsed / ANIM_MS, 1.0)
        frac = target_frac * ease_out(t)
        w    = self._tier_w[idx]
        c    = self._cv

        cx1, cy2 = w["cx1"], w["cy2"]
        bx1 = cx1 + 14
        bx2 = w["cx2"] - 50
        by1 = cy2 - 16
        by2 = cy2 - 8
        bar_w   = bx2 - bx1
        fill_x2 = bx1 + max(0, int(bar_w * frac))

        c.coords(w["bar_fill"], bx1, by1, fill_x2, by2)
        c.itemconfig(w["bar_pct"], text=f"{frac*100:.0f}%")
        col = w["col"] if frac > 0.02 else C["dim"]
        c.itemconfig(w["bar_fill"], fill=col)

        if t < 1.0:
            j = self.after(1000//ANIM_FPS,
                           lambda: self._anim_bar(idx, target_frac,
                                                  elapsed + 1000//ANIM_FPS))
            self._jobs.append(j)

    # ─────────────────────────────────────────────────────────────────────────
    # TOOLTIP
    # ─────────────────────────────────────────────────────────────────────────

    def _tooltip_show(self, d, event):
        self._tooltip_hide()

        tip = tk.Toplevel(self)
        tip.overrideredirect(True)
        tip.configure(bg=C["border"])
        try:
            tip.attributes("-topmost", True)
        except Exception:
            pass

        # Inner frame (1px border effect via outer bg)
        inner = tk.Frame(tip, bg=C["surface"])
        inner.pack(padx=1, pady=1)

        col = C["push"] if d["is_push"] else C["text"]

        def row(parent, text, fg=C["text"], font_size=9, bold=False, pady=(0,0)):
            f = (self._fam, font_size, "bold") if bold else (self._fam, font_size)
            tk.Label(parent, text=text, bg=C["surface"], fg=fg,
                     font=f, anchor="w", justify="left").pack(
                         anchor="w", padx=12, pady=pady)

        # Title
        title = f"{d['short']}  ·  {d['name']}"
        row(inner, title, fg=col, font_size=11, bold=True, pady=(10, 0))

        if d["is_push"]:
            row(inner, "↑ PUSH — your lowest scoring dungeon",
                fg=C["push"], font_size=8, pady=(0, 2))

        # separator
        tk.Frame(inner, bg=C["border"], height=1).pack(
            fill="x", padx=12, pady=(6, 6))

        best = d.get("best_raw") or {}
        high = d.get("high_raw") or {}

        # ── Timed run block ──
        if d["best_level"]:
            row(inner, "BEST TIMED RUN", fg=C["muted"], font_size=7, bold=True)
            pips = upgrade_pips(d["best_pips"])
            row(inner, f"+{d['best_level']}  {pips}    ·    {d['best_score']:.1f} pts",
                fg=C["green"], font_size=11, bold=True)

            ct  = best.get("clear_time_ms")
            par = best.get("par_time_ms")
            if ct and par:
                diff = par - ct
                sign = "under" if diff >= 0 else "over"
                row(inner,
                    f"Time {_mmss(ct)}  /  par {_mmss(par)}   "
                    f"({_mmss(abs(diff))} {sign})",
                    fg=C["text"], font_size=9)

            when = best.get("completed_at")
            if when:
                row(inner, f"Completed {_relative_date(when)}",
                    fg=C["muted"], font_size=8)

            role = best.get("role") or (best.get("spec") or {}).get("role")
            spec = (best.get("spec") or {}).get("name")
            if spec or role:
                txt = "  ".join(x for x in [spec, f"({role})" if role else ""] if x)
                row(inner, f"As {txt}", fg=C["muted"], font_size=8)
        else:
            row(inner, "No timed run yet", fg=C["dim"], font_size=9)

        # ── Highest run block ──
        if d["high_level"] and (d["high_level"] != d["best_level"]
                                 or d["high_pips"] != d["best_pips"]):
            tk.Frame(inner, bg=C["border"], height=1).pack(
                fill="x", padx=12, pady=(6, 6))
            row(inner, "HIGHEST RUN", fg=C["muted"], font_size=7, bold=True)
            depleted = d["high_pips"] == 0
            hl_col = C["depleted"] if depleted else C["blue"]
            tag = "depleted" if depleted else upgrade_pips(d["high_pips"])
            row(inner, f"+{d['high_level']}  ({tag})", fg=hl_col,
                font_size=10, bold=True)

        # ── Affixes ──
        affixes = best.get("affixes") or high.get("affixes") or []
        if affixes:
            tk.Frame(inner, bg=C["border"], height=1).pack(
                fill="x", padx=12, pady=(6, 6))
            row(inner, "AFFIXES", fg=C["muted"], font_size=7, bold=True)
            names = "  ·  ".join(a.get("name", "") for a in affixes)
            row(inner, names, fg=C["text"], font_size=8, pady=(0, 10))
        else:
            # bottom padding
            tk.Frame(inner, bg=C["surface"], height=8).pack()

        self._tooltip = tip
        self._tooltip_move(event)

    def _tooltip_move(self, event):
        if not self._tooltip:
            return
        # Offset from cursor; flip to left side if near right edge
        x = event.x_root + 16
        y = event.y_root + 12
        self._tooltip.update_idletasks()
        tw = self._tooltip.winfo_width()
        th = self._tooltip.winfo_height()
        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()
        if x + tw > sw - 8:
            x = event.x_root - tw - 16
        if y + th > sh - 8:
            y = event.y_root - th - 12
        self._tooltip.geometry(f"+{x}+{y}")

    def _tooltip_hide(self):
        if self._tooltip:
            try:
                self._tooltip.destroy()
            except Exception:
                pass
            self._tooltip = None

    # ─────────────────────────────────────────────────────────────────────────
    # HELPERS
    # ─────────────────────────────────────────────────────────────────────────

    def _set_status(self, msg):
        self._cv.itemconfig(self._status_item, text=msg)

# ═══════════════════════════════════════════════════════════════════════════════
# DUNGEON SHORT NAME
# ═══════════════════════════════════════════════════════════════════════════════

def _mmss(ms):
    """Milliseconds → M:SS string."""
    try:
        s = int(ms) // 1000
        return f"{s//60}:{s%60:02d}"
    except Exception:
        return "—"

def _relative_date(iso_str):
    """ISO timestamp → 'today' / 'yesterday' / 'N days ago'."""
    try:
        # e.g. "2026-06-26T19:06:33.000Z"
        clean = iso_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(clean)
        now = datetime.now(dt.tzinfo)
        delta = now - dt
        days = delta.days
        if days <= 0:
            hrs = delta.seconds // 3600
            if hrs <= 0:
                return "just now"
            if hrs == 1:
                return "1 hour ago"
            return f"{hrs} hours ago"
        if days == 1:
            return "yesterday"
        if days < 7:
            return f"{days} days ago"
        return dt.strftime("%d %b %Y")
    except Exception:
        return iso_str[:10] if iso_str else "—"


def _short_name(name):
    """Generate a 2-4 char abbreviation from a dungeon name."""
    if not name:
        return "??"
    # known abbreviations
    known = {
        "algeth'ar academy":      "AA",
        "magisters' terrace":     "MT",
        "maisara caverns":        "MC",
        "nexus-point xenas":      "NPX",
        "pit of saron":           "POS",
        "seat of the triumvirate":"SEAT",
        "skyreach":               "SR",
        "windrunner spire":       "WS",
        # common older dungeons
        "atal'dazar":             "AD",
        "blackrook hold":         "BRH",
        "darkheart thicket":      "DHT",
        "dawn of the infinite":   "DOTI",
        "the azure vault":        "AV",
        "brackenhide hollow":     "BH",
        "halls of infusion":      "HOI",
        "neltharus":              "NELT",
        "the nokhud offensive":   "NO",
        "ruby life pools":        "RLP",
        "court of stars":         "COS",
        "the everbloom":          "EB",
        "the necrotic wake":      "NW",
        "plaguefall":             "PF",
        "sanguine depths":        "SD",
        "spires of ascension":    "SOA",
        "the stone vault":        "TSV",
        "city of threads":        "COT",
        "ara-kara":               "AK",
        "the dawnbreaker":        "DB",
        "priory of the sacred flame": "PSF",
        "siege of boralus":       "SB",
        "grim batol":             "GB",
        "operation: mechagon":    "OM",
    }
    lower = name.lower()
    for k, v in known.items():
        if k in lower:
            return v
    # fallback: initials of words
    words = [w for w in name.split() if w not in ("of","the","a","an","'")]
    return "".join(w[0].upper() for w in words[:4]) or name[:3].upper()


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    app = App()
    app.mainloop()