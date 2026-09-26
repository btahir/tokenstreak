#!/usr/bin/env python3
"""Generate Tokenstreak brand SVGs (logo mark, wordmark, lockups, app icon, menu-bar template icons).

Run from anywhere:  python3 brand/src/build_brand.py
Then rasterise with:  brand/src/render.sh   (needs rsvg-convert and iconutil)

Everything here is original artwork, MIT licensed with the repo. The wordmark outlines come from
Instrument Serif (SIL Open Font License 1.1), converted to paths so no font is needed to display it.
"""
import json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)

DUSK = [("0", "#8B6CF0"), (".55", "#F0728C"), ("1", "#FFB27A")]
INK = "#231D33"
CREAM = "#FFF3E0"


def bez(p0, p1, p2, p3, t):
    u = 1 - t
    return (u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
            u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1])


def ribbon(p0, p1, p2, p3, w0, w1, n=64, ease=1.6):
    """Tapered filled ribbon along a cubic bezier: width grows from w0 (tail) to w1 (head)."""
    pts = [bez(p0, p1, p2, p3, i / n) for i in range(n + 1)]
    left, right = [], []
    for i, (x, y) in enumerate(pts):
        a = pts[max(0, i - 1)]; b = pts[min(n, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy) or 1
        nx, ny = -dy / L, dx / L
        t = i / n
        w = w0 + (w1 - w0) * (t ** ease)
        left.append((x + nx * w / 2, y + ny * w / 2)); right.append((x - nx * w / 2, y - ny * w / 2))
    poly = left + right[::-1]
    d = "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in poly) + "Z"
    return d, pts


def polyline(pts):
    return "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in pts)


def star4(x, y, r, k=0.14):
    return (f"M{x} {y - r}Q{x + r * k:.2f} {y - r * k:.2f} {x + r} {y}Q{x + r * k:.2f} {y + r * k:.2f} {x} {y + r}"
            f"Q{x - r * k:.2f} {y + r * k:.2f} {x - r} {y}Q{x - r * k:.2f} {y - r * k:.2f} {x} {y - r}Z")


def grad(id_, stops, x1=0, y1=1, x2=1, y2=0, units=None):
    u = f' gradientUnits="{units}"' if units else ""
    s = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in stops)
    return f'<linearGradient id="{id_}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"{u}>{s}</linearGradient>'


def squircle(cx, cy, size, radius_ratio=0.2237, smooth=0.6):
    """Rounded square with smoothed (continuous-curvature-like) corners, macOS icon proportions."""
    h = size / 2; r = size * radius_ratio; x0, y0, x1, y1 = cx - h, cy - h, cx + h, cy + h
    e = r * (1 + smooth * 0.35)  # corner extent along each edge
    k = r * 0.62                  # control handle length
    return (f"M{x0 + e:.2f} {y0:.2f}H{x1 - e:.2f}C{x1 - e + k:.2f} {y0:.2f} {x1:.2f} {y0 + e - k:.2f} {x1:.2f} {y0 + e:.2f}"
            f"V{y1 - e:.2f}C{x1:.2f} {y1 - e + k:.2f} {x1 - e + k:.2f} {y1:.2f} {x1 - e:.2f} {y1:.2f}"
            f"H{x0 + e:.2f}C{x0 + e - k:.2f} {y1:.2f} {x0:.2f} {y1 - e + k:.2f} {x0:.2f} {y1 - e:.2f}"
            f"V{y0 + e:.2f}C{x0:.2f} {y0 + e - k:.2f} {x0 + e - k:.2f} {y0:.2f} {x0 + e:.2f} {y0:.2f}Z")


def write(name, svg):
    path = os.path.join(OUT, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(svg.strip() + "\n")
    print("wrote", os.path.relpath(path, OUT))


# ---------------------------------------------------------------- logo mark (64 x 64)
MARK_CURVE = ((6, 56), (24, 55), (27, 25), (49.5, 17.5))
MARK_HEAD = (49.5, 17.5)


def mark_group(mono=None, prefix="m"):
    d, pts = ribbon(*MARK_CURVE, 1.2, 10.5)
    hx, hy = MARK_HEAD
    if mono:
        return (f'<path d="{d}" fill="{mono}"/>'
                f'<circle cx="{hx}" cy="{hy}" r="8.2" fill="{mono}"/>')
    return (f'<path d="{d}" fill="url(#{prefix}g)"/>'
            f'<path d="{polyline(pts[18:])}" fill="none" stroke="#FFF6EA" stroke-opacity=".75" stroke-width="1.1" stroke-linecap="round"/>'
            f'<circle cx="{hx}" cy="{hy}" r="7.4" fill="{CREAM}"/>'
            f'<circle cx="{hx}" cy="{hy}" r="7.4" fill="none" stroke="#FFB27A" stroke-width="1.6"/>'
            f'<circle cx="{hx - 2}" cy="{hy - 2}" r="2.3" fill="#fff"/>')


def mark_defs(prefix="m"):
    return (grad(f"{prefix}g", DUSK, 7, 55, 49, 17, "userSpaceOnUse") +
            f'<radialGradient id="{prefix}h"><stop offset=".55" stop-color="#FFB27A" stop-opacity=".55"/><stop offset="1" stop-color="#FFB27A" stop-opacity="0"/></radialGradient>')


write("logo-mark.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Tokenstreak"><defs>{mark_defs()}</defs>{mark_group()}</svg>')
write("logo-mark-mono.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Tokenstreak">{mark_group(mono="currentColor")}</svg>')

# ---------------------------------------------------------------- wordmark + lockups
W = json.load(open(os.path.join(HERE, "wordmark-outline.json")))
WD, WW = W["d"], W["width"]  # drawn at size 100, baseline y=80, cap height 72


def wordmark(fill):
    # tight box: x 0..WW, y 6..83
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 4 {WW + 4:.1f} 82" width="{(WW + 4) * .5:.0f}" height="41" role="img" aria-label="Tokenstreak"><path d="{WD}" fill="{fill}"/></svg>'


write("wordmark.svg", wordmark(INK))
write("wordmark-light.svg", wordmark("#FFF4EA"))
write("wordmark-mono.svg", wordmark("currentColor"))


def lockup(fill, name):
    s = 1.45  # mark scale so the head sits near cap height
    gap = 18
    mw = 64 * s
    total = mw + gap + WW
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total:.1f} 96" width="{total * .5:.0f}" height="48" role="img" aria-label="Tokenstreak">'
           f'<defs>{mark_defs("L")}</defs><g transform="translate(0 2) scale({s})">{mark_group(prefix="L")}</g>'
           f'<g transform="translate({mw + gap:.1f} 4)"><path d="{WD}" fill="{fill}"/></g></svg>')
    write(name, svg)


lockup(INK, "logo-lockup.svg")
lockup("#FFF4EA", "logo-lockup-light.svg")

# ---------------------------------------------------------------- app icon (1024, macOS squircle grid)


def app_icon(small=False):
    S = 1024; body = 824; off = (S - body) / 2; cx = cy = S / 2
    sq = squircle(cx, cy, body)
    # trail across the icon
    head = (off + 628, off + 222)
    curve = ((off + 60, off + 648), (off + 330, off + 650), (off + 360, off + 262), head)
    w0, w1 = (18, 130) if small else (3, 100)
    d, pts = ribbon(*curve, w0, w1, n=120, ease=1.35)
    dglow, _ = ribbon(*curve, w0 * 3, w1 * 2.6, n=120, ease=1.35)
    hx, hy = head
    stars = ""
    if not small:
        for (x, y, r, o) in [(250, 250, 3.2, .9), (330, 190, 2.2, .7), (420, 300, 2.6, .8), (560, 150, 2.0, .6), (770, 420, 2.4, .7), (220, 420, 1.8, .55), (860, 250, 2.8, .8), (700, 520, 1.6, .5), (480, 420, 1.6, .5)]:
            stars += f'<circle cx="{x}" cy="{y}" r="{r}" fill="#FFF6EE" opacity="{o}"/>'
        pass
    strands = ""
    if not small:
        for k, (dx, op) in enumerate([(-9, .55), (7, .45)]):
            sp = [(x, y + dx * (i / len(pts)) ** 1.2) for i, (x, y) in enumerate(pts)]
            strands += f'<path d="{polyline(sp[30:])}" fill="none" stroke="#FFF1E4" stroke-opacity="{op}" stroke-width="3" stroke-linecap="round"/>'
    hills = (f'<path d="M{off} {off + 680} C {off + 180} {off + 630}, {off + 330} {off + 700}, {off + 520} {off + 660} S {off + 760} {off + 610}, {off + body} {off + 650} V {off + body} H {off} Z" fill="url(#hill1)"/>'
             f'<path d="M{off} {off + 740} C {off + 220} {off + 700}, {off + 420} {off + 770}, {off + 600} {off + 735} S {off + 780} {off + 715}, {off + body} {off + 735} V {off + body} H {off} Z" fill="url(#hill2)"/>')
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1E1742"/><stop offset=".38" stop-color="#43275F"/><stop offset=".66" stop-color="#9C4775"/><stop offset=".86" stop-color="#E98672"/><stop offset="1" stop-color="#FFC08A"/></linearGradient>
  <radialGradient id="horizon" cx=".72" cy=".95" r=".7"><stop offset="0" stop-color="#FFC690" stop-opacity=".75"/><stop offset="1" stop-color="#FFC690" stop-opacity="0"/></radialGradient>
  <linearGradient id="hill1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4A2A57"/><stop offset="1" stop-color="#2A1A3D"/></linearGradient>
  <linearGradient id="hill2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B1B3E"/><stop offset="1" stop-color="#170F26"/></linearGradient>
  {grad("trail", [("0", "#8B6CF0"), (".45", "#F0728C"), (".85", "#FFB27A"), ("1", "#FFD7A8")], curve[0][0], curve[0][1], hx, hy, "userSpaceOnUse")}
  <linearGradient id="core" x1="{curve[0][0]}" y1="0" x2="{hx}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFF6EE" stop-opacity="0"/><stop offset=".45" stop-color="#FFF6EE" stop-opacity=".85"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient>
  <radialGradient id="orbGlow"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".18" stop-color="#FFF3E0"/><stop offset=".4" stop-color="#FFB27A" stop-opacity=".75"/><stop offset=".7" stop-color="#F0728C" stop-opacity=".22"/><stop offset="1" stop-color="#F0728C" stop-opacity="0"/></radialGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".16"/><stop offset=".42" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>
  <filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="{22 if not small else 16}"/></filter>
  <filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="3"/></filter>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#2A1433" flood-opacity=".35"/></filter>
  <clipPath id="clip"><path d="{sq}"/></clipPath>
</defs>
<g filter="url(#shadow)"><path d="{sq}" fill="url(#sky)"/></g>
<g clip-path="url(#clip)">
  <rect x="0" y="0" width="{S}" height="{S}" fill="url(#horizon)"/>
  {stars}
  {hills}
  <path d="{dglow}" fill="url(#trail)" opacity=".55" filter="url(#blur)"/>
  <path d="{d}" fill="url(#trail)" filter="url(#soft)"/>
  <path d="{d}" fill="url(#trail)" opacity=".9"/>
  {strands}
  <path d="{polyline(pts[20:])}" fill="none" stroke="url(#core)" stroke-width="{16 if small else 9}" stroke-linecap="round"/>
  <circle cx="{hx}" cy="{hy}" r="{210 if small else 190}" fill="url(#orbGlow)"/>
  <circle cx="{hx}" cy="{hy}" r="{70 if small else 58}" fill="#FFF6EC"/>
  <circle cx="{hx}" cy="{hy}" r="{70 if small else 58}" fill="none" stroke="#FFD2A6" stroke-width="{10 if small else 6}"/>
  {'' if small else f'<path d="M{hx - 175} {hy}L{hx} {hy - 3.5}L{hx + 175} {hy}L{hx} {hy + 3.5}Z" fill="#FFFFFF" opacity=".8"/><path d="M{hx} {hy - 95}L{hx + 2.5} {hy}L{hx} {hy + 95}L{hx - 2.5} {hy}Z" fill="#FFFFFF" opacity=".55"/>'}
  {'' if small else f'<ellipse cx="{hx}" cy="{hy}" rx="150" ry="9" fill="#FFE6CC" opacity=".35" filter="url(#soft)"/>'}
  <path d="{sq}" fill="url(#glass)"/>
</g>
<path d="{sq}" fill="none" stroke="#FFFFFF" stroke-opacity=".14" stroke-width="2"/>
</svg>'''
    return svg


write("app-icon/app-icon.svg", app_icon())
write("app-icon/app-icon-small.svg", app_icon(small=True))

# ---------------------------------------------------------------- menu-bar template icons (18 x 18 pt)
# Template images: black + alpha only; macOS tints them for light/dark menu bars.
# Name files *Template.png so NSImage/Tauri treats them as templates (tauri: iconAsTemplate: true).


def menubar(progress):
    hx, hy, r = 12.6, 5.2, 3.5
    trail = "M1.2 15.4C4.6 15 6.4 12.6 7.8 10.2 8.8 8.5 9.6 7.4 10.4 6.8"
    trail2 = "M7.4 16.9C9.6 16.4 11 15 12 13.2"
    circ = 2 * math.pi * r
    if progress >= 1:
        head = (f'<circle cx="{hx}" cy="{hy}" r="{r + .55}" fill="#000"/>'
                f'<path d="M{hx + 4.5} {hy}h.9M{hx} {hy - 4.5}v-.6M{hx + 3.3} {hy - 3.3}l.6-.6M{hx + 3.3} {hy + 3.3}l.6.6" stroke="#000" stroke-width="1" stroke-linecap="round"/>')
    else:
        head = f'<circle cx="{hx}" cy="{hy}" r="{r}" fill="none" stroke="#000" stroke-opacity=".38" stroke-width="1.3"/>'
        if progress > 0:
            head += (f'<circle cx="{hx}" cy="{hy}" r="{r}" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" '
                     f'stroke-dasharray="{circ * progress:.2f} {circ:.2f}" transform="rotate(-90 {hx} {hy})"/>')
            head += f'<circle cx="{hx}" cy="{hy}" r="{max(0.0, r - 2.1) * progress + .6:.2f}" fill="#000"/>'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">'
            f'<path d="{trail}" fill="none" stroke="#000" stroke-width="1.7" stroke-linecap="round"/>'
            f'<path d="{trail2}" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="1.1" stroke-linecap="round"/>{head}</svg>')


write("menubar/trayTemplate.svg", menubar(0.0).replace("stroke-opacity=\".38\"", "stroke-opacity=\"1\""))
for p in (0, 25, 50, 75, 100):
    write(f"menubar/progress/tray-{p:03d}Template.svg", menubar(p / 100))

# ---------------------------------------------------------------- squircle mask (used by render.sh for the raster master)
write("app-icon/squircle-mask.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><path d="{squircle(512, 512, 820)}" fill="#fff"/></svg>')
