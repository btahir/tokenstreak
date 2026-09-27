// React host for the Trail engine. Creates one engine per canvas, feeds it
// data/theme, triggers celebrate/reveal by key changes, and pauses it when the
// host says so (popover hidden) or when the canvas scrolls out of view.
//
// HUD safe zones: any element inside the canvas's parent marked
// `data-trail-avoid` is measured (on resize and DOM changes) and passed to the
// engine, which routes the path around it.

import { useEffect, useRef } from "react";
import "../styles/trail.css";
import { Trail } from "./Trail";
import type { TrailData, TrailHover, TrailLayout, TrailLayoutInfo, TrailTheme, TrailVariant } from "./types";

export interface TrailCanvasProps {
  data: TrailData | null;
  theme: TrailTheme;
  variant: TrailVariant;
  layout?: Partial<TrailLayout>;
  seed?: number;
  /** Increment to play the goal-hit celebration. */
  celebrateKey?: number;
  /** Increment to replay the first-run draw-in. */
  revealKey?: number;
  paused?: boolean;
  reducedMotion?: boolean;
  onHover?: (h: TrailHover | null) => void;
  onReady?: (t: Trail) => void;
  ariaLabel: string;
  className?: string;
  /** Keyboard stepping through days (full variant). */
  keyboard?: boolean;
  /** During a reveal: the share of history tokens the light has drawn (0..1). */
  onRevealProgress?: (p: number) => void;
  /** After each layout: what the Trail shows (for a legend that tells the truth). */
  onLayout?: (info: TrailLayoutInfo) => void;
  /** Measure `[data-trail-avoid]` HUD elements and route around them (default true). */
  avoidHud?: boolean;
}

/** Rectangles of `[data-trail-avoid]` elements inside `host`, relative to `canvas`. */
export function measureAvoid(canvas: HTMLElement, host: HTMLElement): { x: number; y: number; w: number; h: number }[] {
  const cr = canvas.getBoundingClientRect();
  if (!cr.width || !cr.height) return [];
  const out: { x: number; y: number; w: number; h: number }[] = [];
  const add = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    out.push({ x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height });
  };
  // data-trail-avoid="children" measures each child separately (a row of pills, a text stack)
  host.querySelectorAll<HTMLElement>("[data-trail-avoid]").forEach((el) => {
    if (el.dataset.trailAvoid === "children") Array.from(el.children).forEach(add);
    else add(el);
  });
  return out;
}

export function TrailCanvas(p: TrailCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Trail | null>(null);
  const visible = useRef(true);
  const hoverCb = useRef(p.onHover);
  hoverCb.current = p.onHover;
  const revealCb = useRef(p.onRevealProgress);
  revealCb.current = p.onRevealProgress;
  const layoutCb = useRef(p.onLayout);
  layoutCb.current = p.onLayout;
  const avoidHud = p.avoidHud ?? true;
  const layoutKey = JSON.stringify(p.layout ?? {});

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const t = new Trail(c, { theme: p.theme, variant: p.variant, layout: p.layout, seed: p.seed, reducedMotion: p.reducedMotion });
    engine.current = t;
    const off = t.onHover((h) => hoverCb.current?.(h));
    t.onReveal((x) => revealCb.current?.(x));
    t.onLayout((info) => layoutCb.current?.(info));
    // HUD safe zones
    const host = c.parentElement;
    let measureRaf = 0;
    const measure = () => {
      cancelAnimationFrame(measureRaf);
      measureRaf = requestAnimationFrame(() => host && t.setAvoid(measureAvoid(c, host)));
    };
    let hudRo: ResizeObserver | null = null;
    let mo: MutationObserver | null = null;
    if (host && avoidHud) {
      t.setAvoid(measureAvoid(c, host));
      hudRo = new ResizeObserver(measure);
      hudRo.observe(host);
      host.querySelectorAll("[data-trail-avoid]").forEach((el) => hudRo!.observe(el));
      mo = new MutationObserver(() => {
        host.querySelectorAll("[data-trail-avoid]").forEach((el) => hudRo!.observe(el));
        measure();
      });
      mo.observe(host, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-trail-avoid", "class"] });
      void document.fonts?.ready.then(measure);
    }
    if (p.data) t.setData(p.data);
    if (p.paused) t.pause();
    p.onReady?.(t);
    (window as unknown as { __trails?: Trail[] }).__trails = [...((window as unknown as { __trails?: Trail[] }).__trails ?? []), t];
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        if (!e) return;
        visible.current = e.isIntersecting;
        if (!e.isIntersecting) t.pause();
        else if (!pausedRef.current) t.resume();
      },
      { threshold: 0 },
    );
    io.observe(c);
    return () => {
      off();
      io.disconnect();
      hudRo?.disconnect();
      mo?.disconnect();
      cancelAnimationFrame(measureRaf);
      t.destroy();
      const all = (window as unknown as { __trails?: Trail[] }).__trails;
      if (all) (window as unknown as { __trails?: Trail[] }).__trails = all.filter((x) => x !== t);
      engine.current = null;
    };
    // The engine is rebuilt only when its variant or layout changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.variant, layoutKey, p.seed, avoidHud]);

  const pausedRef = useRef(!!p.paused);
  pausedRef.current = !!p.paused;

  useEffect(() => {
    if (p.data) engine.current?.setData(p.data);
  }, [p.data]);

  useEffect(() => {
    engine.current?.setTheme(p.theme);
  }, [p.theme]);

  useEffect(() => {
    if (p.reducedMotion !== undefined) engine.current?.setReducedMotion(p.reducedMotion);
  }, [p.reducedMotion]);

  useEffect(() => {
    const t = engine.current;
    if (!t) return;
    if (p.paused) t.pause();
    else if (visible.current) t.resume();
  }, [p.paused]);

  useEffect(() => {
    if (p.celebrateKey) engine.current?.celebrate();
  }, [p.celebrateKey]);

  useEffect(() => {
    if (p.revealKey) engine.current?.reveal();
  }, [p.revealKey]);

  const onKey = (e: React.KeyboardEvent) => {
    const t = engine.current;
    if (!t || !p.keyboard) return;
    const cur = t.hoveredIndex ?? t.dayCount - 1;
    if (e.key === "ArrowLeft") {
      t.hoverIndex(cur - (e.shiftKey ? 7 : 1));
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      t.hoverIndex(cur + (e.shiftKey ? 7 : 1));
      e.preventDefault();
    } else if (e.key === "Home") {
      t.hoverIndex(0);
      e.preventDefault();
    } else if (e.key === "End") {
      t.hoverIndex(t.dayCount - 1);
      e.preventDefault();
    } else if (e.key === "Escape") t.hoverIndex(null);
  };

  return (
    <canvas
      ref={ref}
      className={p.className}
      role="img"
      aria-label={p.ariaLabel}
      tabIndex={p.keyboard ? 0 : undefined}
      onKeyDown={p.keyboard ? onKey : undefined}
      onFocus={p.keyboard ? () => engine.current?.hoverIndex(engine.current.hoveredIndex ?? engine.current.dayCount - 1) : undefined}
      onBlur={p.keyboard ? () => engine.current?.hoverIndex(null) : undefined}
      data-testid={`trail-${p.variant}`}
    />
  );
}
