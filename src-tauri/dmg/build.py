#!/usr/bin/env python3
"""Builds the .dmg window background (660 x 400 pt, rendered at 2x with
144 dpi so Finder shows it sharp on Retina displays).

Icons sit at (180, 190) and (480, 190) (see bundle.macOS.dmg in
tauri.conf.json). Needs rsvg-convert and sips.

    python3 src-tauri/dmg/build.py
"""
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
BRAND = os.path.join(HERE, "..", "..", "brand")
W, H = 660, 400


def wordmark(x, y, width):
    svg = open(os.path.join(BRAND, "wordmark.svg")).read()
    vb = re.search(r'viewBox="([^"]+)"', svg).group(1)
    inner = svg[svg.index(">") + 1: svg.rindex("</svg>")]
    vx, vy, vw, vh = map(float, vb.split())
    height = width * vh / vw
    return f'<svg x="{x - width / 2:.1f}" y="{y:.1f}" width="{width}" height="{height:.1f}" viewBox="{vb}">{inner}</svg>'


def main():
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <defs>
    <radialGradient id="glowA" cx="0.92" cy="0.05" r="0.75">
      <stop offset="0" stop-color="#FFB27A" stop-opacity="0.30"/>
      <stop offset="0.5" stop-color="#F0728C" stop-opacity="0.10"/>
      <stop offset="1" stop-color="#F0728C" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="0.05" cy="1.0" r="0.7">
      <stop offset="0" stop-color="#8B6CF0" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#8B6CF0" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="streak" x1="262" y1="0" x2="392" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#8B6CF0" stop-opacity="0"/>
      <stop offset="0.35" stop-color="#8B6CF0"/>
      <stop offset="0.7" stop-color="#F0728C"/>
      <stop offset="1" stop-color="#FFB27A"/>
    </linearGradient>
    <radialGradient id="halo">
      <stop offset="0.35" stop-color="#FFB27A" stop-opacity="0.65"/>
      <stop offset="1" stop-color="#FFB27A" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-20%" y="-50%" width="140%" height="200%">
      <feGaussianBlur stdDeviation="3"/>
    </filter>
  </defs>
  <rect width="{W}" height="{H}" fill="#FFF8F1"/>
  <rect width="{W}" height="{H}" fill="url(#glowA)"/>
  <rect width="{W}" height="{H}" fill="url(#glowB)"/>
  {wordmark(W / 2, 34, 150)}
  <!-- A streak of light from the app to Applications. -->
  <path d="M262 204 C 300 176, 350 170, 392 186" fill="none" stroke="url(#streak)" stroke-width="7"
        stroke-linecap="round" opacity="0.35" filter="url(#soft)"/>
  <path d="M262 204 C 300 176, 350 170, 392 186" fill="none" stroke="url(#streak)" stroke-width="3.2"
        stroke-linecap="round"/>
  <circle cx="394" cy="187" r="13" fill="url(#halo)"/>
  <circle cx="394" cy="187" r="4.6" fill="#FFB27A"/>
  <circle cx="394" cy="187" r="2.2" fill="#FFF8F1" opacity="0.9"/>
  <text x="{W / 2}" y="352" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial, sans-serif"
        font-size="13" letter-spacing="0.2" fill="#231D33" fill-opacity="0.62">Drag Tokenstreak into Applications to install</text>
</svg>
'''
    src = os.path.join(HERE, "background.svg")
    out = os.path.join(HERE, "background.png")
    with open(src, "w") as f:
        f.write(svg)
    subprocess.run(["rsvg-convert", "-w", str(W * 2), "-h", str(H * 2), "-o", out, src], check=True)
    subprocess.run(["sips", "-s", "dpiWidth", "144", "-s", "dpiHeight", "144", out], check=True,
                   stdout=subprocess.DEVNULL)
    print("wrote", out)


if __name__ == "__main__":
    main()
