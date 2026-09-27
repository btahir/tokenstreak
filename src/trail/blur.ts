// Canvas blur that works in every engine. `ctx.filter = "blur()"` is the fast
// path, but some WebKit builds accept the property without applying it, so we
// test that it really blurs and otherwise run a small premultiplied box blur
// (three passes ≈ Gaussian) on the already-downscaled cache canvases.

let works: boolean | null = null;

/** True when ctx.filter blur visibly spreads pixels (checked once). */
export function filterBlurWorks(): boolean {
  if (works !== null) return works;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const x = c.getContext("2d", { willReadFrequently: true });
    if (!x) return (works = false);
    x.filter = "blur(4px)";
    if (x.filter !== "blur(4px)") return (works = false);
    x.fillStyle = "#fff";
    x.fillRect(12, 12, 8, 8);
    const a = x.getImageData(9, 16, 1, 1).data[3] ?? 0;
    works = a > 8;
  } catch {
    works = false;
  }
  return works;
}

function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean): void {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4;
  const inv = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * w * 4 : l * 4;
    for (let ch = 0; ch < 4; ch++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += src[base + Math.min(len - 1, Math.max(0, i)) * step + ch]!;
      for (let i = 0; i < len; i++) {
        dst[base + i * step + ch] = acc * inv;
        const add = Math.min(len - 1, i + r + 1);
        const sub = Math.max(0, i - r);
        acc += src[base + add * step + ch]! - src[base + sub * step + ch]!;
      }
    }
  }
}

/** Blurs a canvas in place by roughly `radius` device pixels (software path). */
export function softwareBlur(canvas: HTMLCanvasElement, radius: number): void {
  const w = canvas.width;
  const h = canvas.height;
  const r = Math.max(1, Math.round(radius / 1.7));
  if (!w || !h) return;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const a = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const al = d[i + 3]! / 255;
    a[i] = d[i]! * al;
    a[i + 1] = d[i + 1]! * al;
    a[i + 2] = d[i + 2]! * al;
    a[i + 3] = d[i + 3]!;
  }
  const b = new Float32Array(d.length);
  for (let pass = 0; pass < 3; pass++) {
    boxPass(a, b, w, h, r, true);
    boxPass(b, a, w, h, r, false);
  }
  for (let i = 0; i < d.length; i += 4) {
    const al = a[i + 3]!;
    d[i + 3] = al;
    if (al > 0.5) {
      const k = 255 / al;
      d[i] = a[i]! * k;
      d[i + 1] = a[i + 1]! * k;
      d[i + 2] = a[i + 2]! * k;
    }
  }
  ctx.putImageData(img, 0, 0);
}
