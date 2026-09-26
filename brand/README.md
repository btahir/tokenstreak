# Tokenstreak brand

Direction "Afterglow": your streak, drawn as a streak of light. All artwork here is original and MIT licensed with the repo.

| Asset | Files |
|---|---|
| Logo mark (colour, mono) | `logo-mark.svg`, `logo-mark-mono.svg`, `logo-mark-512.png` |
| Wordmark | `wordmark.svg` (ink), `wordmark-light.svg` (on dark), `wordmark-mono.svg` (currentColor) |
| Lockup | `logo-lockup.svg`, `logo-lockup-light.svg`, `*-1200.png` |
| macOS app icon | `app-icon/app-icon-1024.png` (master), `app-icon/Tokenstreak.iconset/`, `app-icon/Tokenstreak.icns`, vector sources `app-icon/app-icon.svg` and `app-icon/app-icon-small.svg` (16 and 32 px) |
| Menu-bar icon | `menubar/trayTemplate.png` / `@2x` (18 pt template image), progress variants `menubar/progress/tray-{000,025,050,075,100}Template.png` |
| Open Graph image | `og-image.png` (1200 × 630) |

## Rules
- Dusk gradient: `#8B6CF0 → #F0728C → #FFB27A` (violet, rose, apricot). Ink `#231D33`, cream `#FFF8F1`, night `#17132A`.
- The wordmark is Instrument Serif (SIL Open Font License 1.1), converted to outlines, so no font is needed to display it.
- Leave clear space around the mark equal to the head's diameter. Minimum size is 16 px for the mark and 72 px wide for the lockup.
- Tool identities use our own neutral glyphs: a circle for Claude Code, a rounded square for Codex, a triangle for Gemini. Never use vendor logos.
- Menu-bar PNGs are template images (black plus alpha). Load them with `iconAsTemplate: true` in Tauri so macOS tints them for light and dark menu bars. The head of the glyph fills as today's goal approaches, and it gains rays once the goal is lit.

## Regenerate
```sh
python3 brand/src/build_brand.py   # SVGs
brand/src/render.sh                # PNGs, iconset, .icns (needs rsvg-convert, Pillow, iconutil)
```
The raster app-icon master comes from `src/icon-render.png`, a generated render (ours), masked to the squircle in `app-icon/squircle-mask.svg`.
