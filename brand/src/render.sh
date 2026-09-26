#!/bin/zsh
# Rasterise the Tokenstreak brand: app-icon master + iconset + .icns, menu-bar template PNGs, logo PNGs.
# Needs: rsvg-convert (librsvg), python3 with Pillow, iconutil (macOS).
# The 1024 master is built from a generated render (brand/src/icon-render.png, Codex imagegen, ours to MIT-license),
# masked to our squircle. Small sizes (16/32 px) use the simplified vector (app-icon-small.svg) for legibility.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 src/build_brand.py > /dev/null
TMP=$(mktemp -d)

rsvg-convert -w 1024 app-icon/squircle-mask.svg -o "$TMP/mask.png"

python3 - "$TMP" <<'EOF'
import sys
from PIL import Image, ImageChops
tmp = sys.argv[1]
src = Image.open('src/icon-render.png').convert('RGB')
body = src.crop((114, 112, 910, 889)).resize((820, 820), Image.LANCZOS)   # the render's squircle body
canvas = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
layer = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0)); layer.paste(body, (102, 102))
mask = Image.open(f'{tmp}/mask.png').convert('RGBA').split()[3]
layer.putalpha(mask)
from PIL import ImageFilter
sa = Image.new('L', (1024, 1024), 0); sa.paste(mask, (0, 12)); sa = sa.filter(ImageFilter.GaussianBlur(14)).point(lambda v: int(v * .35))
sa = ImageChops.subtract(sa, mask)   # keep only the shadow outside the body
shadow = Image.new('RGBA', (1024, 1024), (42, 20, 51, 255)); shadow.putalpha(sa)
canvas.alpha_composite(shadow); canvas.alpha_composite(layer)
# hairline inner border for crisp edges on light wallpapers
canvas.save('app-icon/app-icon-1024.png')
print('master ok')
EOF

# --- iconset (Apple naming) and .icns
SET=app-icon/Tokenstreak.iconset; rm -rf "$SET"; mkdir -p "$SET"
for s in 16 32; do
  rsvg-convert -w $s app-icon/app-icon-small.svg -o "$SET/icon_${s}x${s}.png"
done
rsvg-convert -w 64 app-icon/app-icon-small.svg -o "$SET/icon_32x32@2x.png"
rsvg-convert -w 32 app-icon/app-icon-small.svg -o "$SET/icon_16x16@2x.png"
python3 - <<'EOF'
from PIL import Image
m = Image.open('app-icon/app-icon-1024.png')
for name, px in [('icon_128x128', 128), ('icon_128x128@2x', 256), ('icon_256x256', 256), ('icon_256x256@2x', 512), ('icon_512x512', 512), ('icon_512x512@2x', 1024)]:
    m.resize((px, px), Image.LANCZOS).save(f'app-icon/Tokenstreak.iconset/{name}.png')
EOF
iconutil -c icns "$SET" -o app-icon/Tokenstreak.icns
rsvg-convert -w 1024 app-icon/app-icon.svg -o app-icon/app-icon-vector-1024.png

# --- menu-bar template icons: 18pt @1x (18px) and @2x (36px), black + alpha
for f in menubar/trayTemplate.svg menubar/progress/*.svg; do
  b=${f%.svg}
  rsvg-convert -w 18 "$f" -o "$b.png"
  rsvg-convert -w 36 "$f" -o "$b@2x.png"
done

# --- logo PNGs
rsvg-convert -w 512 logo-mark.svg -o logo-mark-512.png
rsvg-convert -w 1200 logo-lockup.svg -o logo-lockup-1200.png
rsvg-convert -w 1200 logo-lockup-light.svg -o logo-lockup-light-1200.png
rm -rf "$TMP"
echo "brand rendered"
