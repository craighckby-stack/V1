#!/usr/bin/env python3
"""LOOP Build Record — chart generation from data.json.

Follows typesetting/charts.md: no internal titles (external captions exist),
top/right spines deleted, dashed grid 20% opacity (or none when values are
labeled), donut default for pie, horizontal bars for long labels,
first/last/max labelling on lines, legend outside with no border.
Colors come from the cascade palette (same family, lightness variants).
"""
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = "/home/z/my-project"
D = json.load(open(os.path.join(ROOT, "build-guide", "data.json"), encoding="utf-8"))
OUTDIR = os.path.join(ROOT, "build-guide", "charts")
os.makedirs(OUTDIR, exist_ok=True)

# cascade palette (seed 42) — same values as generate.py
ACCENT = "#1f9259"
HEADER_FILL = "#324e40"
ICON = "#4ba478"
BORDER = "#acc5b9"
TEXT_PRIMARY = "#131514"
TEXT_MUTED = "#747e79"

plt.rcParams.update({
    "font.size": 11,
    "text.color": TEXT_PRIMARY,
    "axes.edgecolor": TEXT_MUTED,
    "axes.labelcolor": TEXT_PRIMARY,
    "xtick.color": TEXT_MUTED,
    "ytick.color": TEXT_MUTED,
    "axes.linewidth": 0.6,
})


def strip_spines(ax):
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)


# ── Figure 1: repository anatomy donut ─────────────────────────
b = D["buckets"]
labels = ["platform", "environment", "stock UI", "LOOP core"]
vals = [b["platform"]["files"], b["environment"]["files"], b["stock_ui"]["files"], b["core"]["files"]]
colors = [BORDER, ICON, HEADER_FILL, ACCENT]  # biggest area = lightest shade
total = sum(vals)

fig, ax = plt.subplots(figsize=(7.4, 3.4))
wedges, _ = ax.pie(
    vals, colors=colors, startangle=90, counterclock=False,
    wedgeprops=dict(width=0.35, edgecolor="white", linewidth=1.4),
)
ax.text(0, 0.08, f"{total:,}", ha="center", va="center", fontsize=22, fontweight="bold", color=TEXT_PRIMARY)
ax.text(0, -0.24, "tracked files", ha="center", va="center", fontsize=10, color=TEXT_MUTED)
legend_labels = [
    f"Platform skills library — {b['platform']['files']:,} files ({b['platform']['files']/total:.0%})",
    f"Environment (configs, scripts, records) — {b['environment']['files']} ({b['environment']['files']/total:.0%})",
    f"Stock shadcn/ui — {b['stock_ui']['files']} ({b['stock_ui']['files']/total:.0%})",
    f"LOOP core — {b['core']['files']} ({b['core']['files']/total:.0%})",
]
ax.legend(wedges, legend_labels, loc="center left", bbox_to_anchor=(1.02, 0.5),
          frameon=False, fontsize=10, handlelength=1.0, handleheight=1.0, labelspacing=1.1)
ax.set_aspect("equal")
fig.tight_layout()
fig.savefig(os.path.join(OUTDIR, "fig1-anatomy-donut.png"), dpi=200, transparent=True)
plt.close(fig)

# ── Figure 2: cumulative commits (the growth curve) ────────────
cum = D["git"]["cumulative"]
xs = list(range(len(cum)))
ys = [c["total"] for c in cum]
dates = [c["date"][5:] for c in cum]

fig, ax = plt.subplots(figsize=(7.4, 3.1))
ax.plot(xs, ys, color=ACCENT, linewidth=2.5, zorder=3)
ax.fill_between(xs, ys, color=ACCENT, alpha=0.14, zorder=2)
# markers + labels: first, last (=max, monotonic) only
ax.scatter([xs[0], xs[-1]], [ys[0], ys[-1]], s=26, color=HEADER_FILL, zorder=4)
ax.annotate(f"{ys[0]}", (xs[0], ys[0]), textcoords="offset points", xytext=(2, 9),
            fontsize=10, color=TEXT_PRIMARY, fontweight="bold")
ax.annotate(f"{ys[-1]} commits", (xs[-1], ys[-1]), textcoords="offset points", xytext=(-8, 9),
            fontsize=10, color=TEXT_PRIMARY, fontweight="bold", ha="right")
ax.set_xticks(xs)
ax.set_xticklabels(dates, fontsize=9)
ax.set_ylim(0, ys[-1] * 1.18)
ax.set_ylabel("Cumulative commits", fontsize=10)
ax.grid(axis="y", linestyle="--", linewidth=0.5, alpha=0.2)
strip_spines(ax)
fig.tight_layout()
fig.savefig(os.path.join(OUTDIR, "fig2-growth-curve.png"), dpi=200, transparent=True)
plt.close(fig)

# ── Figure 3: accepted mutations by file (top 12) ──────────────
import re
norm = {}
for target, n in D["git"]["mutations_by_file"].items():
    clean = re.sub(r"\s*\(LLM refactor.*\)$", "", target).strip()
    norm[clean] = norm.get(clean, 0) + n
top = sorted(norm.items(), key=lambda kv: kv[1], reverse=True)[:12][::-1]
names = [os.path.basename(k) for k, _ in top]
counts = [v for _, v in top]

fig, ax = plt.subplots(figsize=(7.4, 4.0))
bars = ax.barh(names, counts, color=ACCENT, height=0.62, zorder=3)
bars[-1].set_color(HEADER_FILL)  # most-mutated file emphasised
for bar, c in zip(bars, counts):
    ax.text(bar.get_width() + 0.25, bar.get_y() + bar.get_height() / 2,
            str(c), va="center", fontsize=10, color=TEXT_PRIMARY)
ax.set_xlim(0, max(counts) * 1.14)
ax.tick_params(axis="y", labelsize=10)
ax.spines["left"].set_visible(False)
ax.set_xticks([])  # values labelled directly -> no grid, no x axis clutter
strip_spines(ax)
fig.tight_layout()
fig.savefig(os.path.join(OUTDIR, "fig3-mutations-by-file.png"), dpi=200, transparent=True)
plt.close(fig)

print("charts written:", os.listdir(OUTDIR))
