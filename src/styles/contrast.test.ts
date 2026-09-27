// WCAG contrast for every text/background token pair, in both themes. Reads
// tokens.css directly so a palette change that breaks AA fails the build.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");

function block(selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error(`no ${selector}`);
  const open = css.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === "{") depth++;
    if (css[j] === "}" && --depth === 0) return css.slice(open + 1, j);
  }
  throw new Error("unbalanced");
}

function vars(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const light = vars(block(":root {"));
const dark = { ...light, ...vars(block(':root[data-theme="dark"]')) };
const autoDark = { ...light, ...vars(block(':root:not([data-theme="light"])')) };

function rgb(c: string): [number, number, number] {
  const h = /^#([0-9a-f]{6})$/i.exec(c);
  if (!h) throw new Error(`not a hex colour: ${c}`);
  return [0, 2, 4].map((i) => parseInt(h[1]!.slice(i, i + 2), 16)) as [number, number, number];
}
function lum(c: string): number {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const TEXT = ["ink", "ink-2", "ink-3", "accent"];
const BACKGROUNDS = ["bg", "bg-sunken", "surface", "surface-hover"];

describe.each([
  ["light", light],
  ["dark", dark],
  ["dark (system)", autoDark],
] as const)("%s theme", (_name, t) => {
  for (const fg of TEXT)
    for (const bg of BACKGROUNDS)
      it(`--${fg} on --${bg} is at least 4.5:1`, () => {
        expect(ratio(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
      });
  it("--accent-ink on --accent is at least 4.5:1", () => {
    expect(ratio(t["accent-ink"]!, t.accent!)).toBeGreaterThanOrEqual(4.5);
  });
  it("toggles and found marks read as UI (3:1 on surface)", () => {
    expect(ratio(t.on!, t.surface!)).toBeGreaterThanOrEqual(3);
    expect(ratio(t.ok!, t.surface!)).toBeGreaterThanOrEqual(4.5);
  });
  it("empty heatmap cells are visible (1.3:1 on the card)", () => {
    expect(ratio(t["heat-0"]!, t.surface!)).toBeGreaterThanOrEqual(1.3);
  });
});

describe("gradient buttons", () => {
  it("white text keeps 4.5:1 on every stop of --gradient-action", () => {
    const stops = [...light["gradient-action"]!.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]);
    expect(stops.length).toBeGreaterThanOrEqual(3);
    for (const s of stops) expect(ratio("#FFFFFF", s), s).toBeGreaterThanOrEqual(4.5);
  });
});
