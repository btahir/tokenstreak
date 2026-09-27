// Chart primitives as typed SVG components (no library). Rules from the design
// system: rounded bar tops, stacking Claude → Codex → Gemini bottom to top, a
// dashed goal line with a label chip, no borders, at most 3 grid lines,
// tabular numbers, and a dot above goal days.

import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Tool } from "../api/types";
import { niceTicks, type BarRow, type HeatCell } from "../lib/derive";
import { formatDate, formatTokens, formatUsd, monthShort, TOOL_SHORT, TOOLS, weekdayShort } from "../lib/format";

const COL: Record<Tool, string> = { claude: "var(--tool-claude)", codex: "var(--tool-codex)", gemini: "var(--tool-gemini)" };

/** The element's width in CSS px, so SVGs draw 1:1 and text is never stretched. */
function useWidth<T extends HTMLElement>(fallback: number): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  // measure before paint so the first frame is already the right size
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w || fallback];
}

/* ---------------- tooltip ---------------- */

export function Tip({ x, y, children, align = "center" }: { x: number; y: number; children: ReactNode; align?: "center" | "left" | "right" }) {
  const tx = align === "center" ? "-50%" : align === "left" ? "0" : "-100%";
  return (
    <div className="tip tip--float" style={{ left: x, top: y, transform: `translate(${tx}, calc(-100% - 10px))` }} role="tooltip">
      {children}
    </div>
  );
}

/* ---------------- stacked bars ---------------- */

export interface BarChartProps {
  rows: BarRow[];
  height?: number;
  goal?: number | null;
  labelEvery?: number;
  /** Tooltip heading for a row. */
  heading?: (r: BarRow) => string;
  testId?: string;
}

export function BarChart({ rows, height = 200, goal, labelEvery = 1, heading, testId }: BarChartProps) {
  const [wrap, W] = useWidth<HTMLDivElement>(640);
  const [hover, setHover] = useState<number | null>(null);
  const H = height;
  const [pt, pr, pb, pl] = [12, 44, 22, 2];
  const iw = W - pl - pr;
  const ih = H - pt - pb;
  const scale = niceTicks(Math.max(goal ?? 0, ...rows.map((r) => r.total), 1));
  const max = scale.top;
  const bw = iw / Math.max(1, rows.length);
  const gap = Math.max(2, bw * 0.28);
  const w = Math.max(1, bw - gap);
  const rad = Math.min(4, w / 2);
  const y = (v: number) => pt + ih - (ih * v) / max;
  const hovered = hover !== null ? rows[hover] : null;
  // never let axis labels crowd: at least ~56 px per label
  const every = Math.max(labelEvery, Math.ceil(56 / Math.max(1, bw)));

  return (
    <div
      className="chart"
      ref={wrap}
      data-testid={testId}
      onMouseLeave={() => setHover(null)}
      tabIndex={0}
      aria-label={`${rows.length} bars. Use the arrow keys to read each one.`}
      onFocus={() => hover === null && setHover(rows.length - 1)}
      onBlur={() => setHover(null)}
      onKeyDown={(e) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        setHover((h) => Math.max(0, Math.min(rows.length - 1, (h ?? rows.length - 1) + d)));
      }}
    >
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ overflow: "visible" }} role="img" aria-label="Tokens per period, stacked by agent">
        {scale.ticks.map((v) => {
          const yy = y(v);
          return (
            <g key={v}>
              <line x1={pl} x2={pl + iw} y1={yy} y2={yy} stroke="var(--chart-grid)" />
              {!(goal && Math.abs(y(goal) - yy) < 14) && (
                <text x={pl + iw + 6} y={yy + 3.5} className="chart__tick">
                  {formatTokens(v)}
                </text>
              )}
            </g>
          );
        })}
        {rows.map((r, i) => {
          const x = pl + i * bw + gap / 2;
          let top = pt + ih;
          const present = TOOLS.filter((k) => r[k] > 0);
          const dim = hover !== null && hover !== i;
          return (
            <g key={r.key} opacity={dim ? 0.45 : 1} style={{ transition: "opacity 160ms" }}>
              {present.map((k, ki) => {
                const hh = (ih * r[k]) / max;
                top -= hh;
                const isTop = ki === present.length - 1;
                return isTop ? (
                  <path
                    key={k}
                    d={`M${x} ${top + hh}V${top + Math.min(rad, hh)}Q${x} ${top} ${x + rad} ${top}H${x + w - rad}Q${x + w} ${top} ${x + w} ${top + Math.min(rad, hh)}V${top + hh}Z`}
                    fill={COL[k]}
                  />
                ) : (
                  <rect key={k} x={x} y={top} width={w} height={hh + 0.5} fill={COL[k]} />
                );
              })}
              {r.met && <circle cx={x + w / 2} cy={top - 5} r={1.9} fill="var(--success)" />}
              {r.isCurrent && !r.total && <rect x={x} y={pt + ih - 2} width={w} height={2} rx={1} fill="var(--line-strong)" />}
              {r.label && (rows.length - 1 - i) % every === 0 && (
                <text x={x + w / 2} y={H - 6} textAnchor="middle" className="chart__tick">
                  {r.label}
                </text>
              )}
              <rect x={pl + i * bw} y={pt} width={bw} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          );
        })}
        {goal ? (
          <g pointerEvents="none">
            <line x1={pl} x2={pl + iw} y1={y(goal)} y2={y(goal)} stroke="var(--accent)" strokeDasharray="3 4" strokeWidth={1.2} />
            <rect x={pl + iw + 3} y={y(goal) - 8} width={32} height={16} rx={8} fill="var(--accent)" />
            <text x={pl + iw + 19} y={y(goal) + 3.5} textAnchor="middle" className="chart__goal">
              goal
            </text>
          </g>
        ) : null}
      </svg>
      {hovered && hover !== null && (
        <Tip x={pl + hover * bw + bw / 2} y={y(hovered.total) - 6}>
          <div className="tip__h">{heading ? heading(hovered) : hovered.key}</div>
          <b className="tip__num">{formatTokens(hovered.total)}</b>
          <div className="tip__rows">
            {TOOLS.filter((k) => hovered[k] > 0).map((k) => (
              <span key={k}>
                <i className={`glyph glyph--${k}`} />
                {TOOL_SHORT[k]} {formatTokens(hovered[k])}
              </span>
            ))}
          </div>
          {hovered.goal ? <div className="tip__foot">{hovered.met ? "Goal lit" : `${Math.round((hovered.total / hovered.goal) * 100)}% of goal`}</div> : null}
        </Tip>
      )}
    </div>
  );
}

/* ---------------- line / sparkline ---------------- */

export function Sparkline({ values, height = 34, color = "var(--moon)", fill = true, dots = true, min, max }: { values: number[]; height?: number; color?: string; fill?: boolean; dots?: boolean; min?: number; max?: number }) {
  const id = useId().replace(/:/g, "");
  const W = 300;
  const H = height;
  const pad = 4;
  if (values.length < 2) return <div style={{ height }} />;
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const X = (i: number) => pad + (i / (values.length - 1)) * (W - pad * 2);
  const Y = (v: number) => pad + (1 - (v - lo) / (hi - lo || 1)) * (H - pad * 2);
  const d = values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join("");
  const last = values[values.length - 1]!;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ overflow: "visible", display: "block" }} aria-hidden>
      <defs>
        <linearGradient id={`lg${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={`${d}L${X(values.length - 1)} ${H}L${X(0)} ${H}Z`} fill={`url(#lg${id})`} />}
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {dots && <circle cx={X(values.length - 1)} cy={Y(last)} r={3.5} fill={color} stroke="var(--surface)" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/** A line chart with an area fill, value ticks and hover (used on Stats). */
export function AreaChart({ points, height = 160, color = "var(--accent)", format = formatUsd, label }: { points: { key: string; value: number }[]; height?: number; color?: string; format?: (n: number) => string; label: string }) {
  const id = useId().replace(/:/g, "");
  const [wrap, W] = useWidth<HTMLDivElement>(640);
  const [hover, setHover] = useState<number | null>(null);
  const H = height;
  const [pt, pr, pb, pl] = [12, 48, 22, 2];
  const iw = W - pl - pr;
  const ih = H - pt - pb;
  const n = points.length;
  const scale = niceTicks(Math.max(...points.map((p) => p.value), 0.0001));
  const max = scale.top;
  const X = (i: number) => pl + (n > 1 ? (i / (n - 1)) * iw : iw / 2);
  const Y = (v: number) => pt + ih - (ih * v) / max;
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(p.value).toFixed(1)}`).join("");
  const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(iw / 70))));
  const hp = hover !== null ? points[hover] : null;
  return (
    <div className="chart" ref={wrap} onMouseLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        style={{ overflow: "visible" }}
        role="img"
        aria-label={label}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const fx = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(n - 1, Math.round(((fx - pl) / iw) * (n - 1)))));
        }}
      >
        <defs>
          <linearGradient id={`ag${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity=".28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {scale.ticks.map((v) => {
          const yy = Y(v);
          return (
            <g key={v}>
              <line x1={pl} x2={pl + iw} y1={yy} y2={yy} stroke="var(--chart-grid)" />
              <text x={pl + iw + 6} y={yy + 3.5} className="chart__tick">
                {format === formatUsd ? formatUsd(v, { cents: !Number.isInteger(v) }) : format(v)}
              </text>
            </g>
          );
        })}
        {n > 1 && <path d={`${d}L${X(n - 1)} ${pt + ih}L${X(0)} ${pt + ih}Z`} fill={`url(#ag${id})`} />}
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {points.map((p, i) =>
          i % every === 0 ? (
            <text key={p.key} x={X(i)} y={H - 6} textAnchor="middle" className="chart__tick">
              {p.key.length === 10 ? formatDate(p.key) : p.key}
            </text>
          ) : null,
        )}
        {hp && hover !== null && (
          <g pointerEvents="none">
            <line x1={X(hover)} x2={X(hover)} y1={pt} y2={pt + ih} stroke="var(--line-strong)" strokeDasharray="3 4" />
            <circle cx={X(hover)} cy={Y(hp.value)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>
      {hp && hover !== null && (
        <Tip x={X(hover)} y={Y(hp.value)}>
          <div className="tip__h">{hp.key.length === 10 ? formatDate(hp.key) : hp.key}</div>
          <b className="tip__num">{format(hp.value)}</b>
        </Tip>
      )}
    </div>
  );
}

/** Simple vertical bars (hour of day, weekday). */
export function MiniBars({ values, labels, height = 120, highlight, format = formatTokens, label, color = "var(--accent)" }: { values: number[]; labels: string[]; height?: number; highlight?: number; format?: (n: number) => string; label: string; color?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...values, 1);
  const peak = values.indexOf(Math.max(...values));
  return (
    <div className="minibars" style={{ height }} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
      {values.map((v, i) => (
        <div key={i} className={`minibars__col${i === (highlight ?? peak) && v > 0 ? " is-peak" : ""}${hover === i ? " is-hover" : ""}`} onMouseEnter={() => setHover(i)}>
          <div className="minibars__bar" style={{ height: `${Math.max(v > 0 ? 3 : 1.5, (v / max) * 100)}%`, background: v > 0 ? color : undefined }} />
          <span className="minibars__lab">{labels[i]}</span>
          {hover === i && <span className="minibars__val">{format(v)}</span>}
        </div>
      ))}
    </div>
  );
}

/* ---------------- heatmap ---------------- */

export function Heatmap({ columns: all, gap: gapMax = 3, minCell = 9, maxCell = 17, weekStartsOn = "monday" }: { columns: HeatCell[][]; gap?: number; minCell?: number; maxCell?: number; weekStartsOn?: "monday" | "sunday" }) {
  const [wrap, avail] = useWidth<HTMLDivElement>(0);
  const [hover, setHover] = useState<{ c: HeatCell; x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const LABEL_W = 28;
  const room = Math.max(0, avail - LABEL_W);
  const gap = room && room / all.length < 12 ? 2 : gapMax;
  // fit the grid to the card: shrink cells, then drop the oldest weeks if needed
  const fitCols = room ? Math.min(all.length, Math.floor((room + gap) / (minCell + gap))) : all.length;
  const columns = fitCols < all.length ? all.slice(all.length - fitCols) : all;
  const n = Math.max(1, columns.length);
  const cell = room ? Math.max(minCell, Math.min(maxCell, (room - gap * (n - 1)) / n)) : 12;
  const months = useMemo(() => {
    const out: { label: string; col: number }[] = [];
    let prev = "";
    columns.forEach((col, i) => {
      const first = col[0]!;
      const m = monthShort(first.date);
      if (m !== prev) {
        if (i > 0 || col.every((c) => c.date.slice(8) <= "07")) out.push({ label: m, col: i });
        prev = m;
      }
    });
    return out.filter((m, i, a) => i === 0 || m.col - a[i - 1]!.col >= 3);
  }, [columns]);
  const width = columns.length * (cell + gap) - gap;
  function focusCell(ci: number, ri: number) {
    const c = columns[ci]?.[ri];
    if (c) setHover({ c, x: LABEL_W + ci * (cell + gap) + cell / 2, y: ri * (cell + gap) + 18 });
  }
  // Mon, Wed, Fri rows
  const dayRows = weekStartsOn === "monday" ? [0, 2, 4] : [1, 3, 5];
  const dayName = (r: number) => weekdayShort(columns[0]?.[r]?.date ?? "2026-09-21");
  return (
    <div
      className="heat-wrap"
      ref={wrap}
      onMouseLeave={() => setHover(null)}
      tabIndex={0}
      aria-label="A year of daily tokens. Use the arrow keys to step through days."
      onFocus={() => {
        const ci = columns.length - 1;
        const ri = Math.max(0, columns[ci]?.findIndex((c) => c.today) ?? 0);
        setCursor([ci, ri]);
        focusCell(ci, ri);
      }}
      onBlur={() => {
        setCursor(null);
        setHover(null);
      }}
      onKeyDown={(e) => {
        if (!cursor) return;
        const [dc, dr] = e.key === "ArrowRight" ? [1, 0] : e.key === "ArrowLeft" ? [-1, 0] : e.key === "ArrowDown" ? [0, 1] : e.key === "ArrowUp" ? [0, -1] : [0, 0];
        if (!dc && !dr) return;
        e.preventDefault();
        let ci = cursor[0] + dc;
        let ri = cursor[1] + dr;
        if (ri > 6) [ci, ri] = [ci + 1, 0];
        if (ri < 0) [ci, ri] = [ci - 1, 6];
        ci = Math.max(0, Math.min(columns.length - 1, ci));
        const c = columns[ci]?.[ri];
        if (!c || c.future) return;
        setCursor([ci, ri]);
        focusCell(ci, ri);
      }}
    >
      <div className="heat-months" style={{ width, marginLeft: LABEL_W }}>
        {months.map((m) => (
          <span key={`${m.label}${m.col}`} style={{ left: m.col * (cell + gap) }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="heat-body">
        <div className="heat-days" style={{ width: LABEL_W, gridTemplateRows: `repeat(7, ${cell}px)`, rowGap: gap }} aria-hidden>
          {Array.from({ length: 7 }, (_, r) => (
            <span key={r}>{dayRows.includes(r) ? dayName(r) : ""}</span>
          ))}
        </div>
        <div className="heat" style={{ gridTemplateRows: `repeat(7, ${cell}px)`, gridAutoColumns: `${cell}px`, gap }} role="img" aria-label={`Daily tokens for the last ${columns.length} weeks`}>
          {columns.flatMap((col, ci) =>
            col.map((c, ri) => (
              <i
                key={c.date}
                data-l={c.level}
                data-goal={c.met ? "" : undefined}
                data-frozen={c.frozen ? "" : undefined}
                data-today={c.today ? "" : undefined}
                data-future={c.future ? "" : undefined}
                data-pad={c.pad && !c.future ? "" : undefined}
                data-cursor={cursor && cursor[0] === ci && cursor[1] === ri ? "" : undefined}
                style={{ gridColumn: ci + 1, gridRow: ri + 1 }}
                onMouseEnter={() => !c.future && !c.pad && setHover({ c, x: LABEL_W + ci * (cell + gap) + cell / 2, y: ri * (cell + gap) + 18 })}
              />
            )),
          )}
        </div>
      </div>
      {hover && (
        <Tip x={hover.x} y={hover.y} align={hover.x < 80 ? "left" : hover.x > width - 80 ? "right" : "center"}>
          <div className="tip__h" aria-live={cursor ? "polite" : undefined}>{formatDate(hover.c.date)}</div>
          <b className="tip__num">{hover.c.total ? formatTokens(hover.c.total) : "No tokens"}</b>
          <div className="tip__foot">{hover.c.met ? "Goal lit" : hover.c.frozen ? (hover.c.freeze ? "Streak freeze · streak kept" : "Rest day") : hover.c.total ? "Under goal" : hover.c.today ? "Today" : "Day off"}</div>
        </Tip>
      )}
    </div>
  );
}

/* ---------------- ranked list ---------------- */

export interface ListRow {
  key: string;
  label: ReactNode;
  value: number;
  display: string;
  color: string;
  glyph?: Tool | null;
  mono?: boolean;
  opacity?: number;
  title?: string;
}

export function RankList({ rows, testId }: { rows: ListRow[]; testId?: string }) {
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  return (
    <div className="list" data-testid={testId}>
      {rows.map((r) => (
        <div className="li" key={r.key} title={r.title}>
          <span className={`li__n${r.mono ? " mono" : ""}`}>
            {r.glyph && <i className={`glyph glyph--${r.glyph}`} />}
            <span className="li__t">{r.label}</span>
          </span>
          <span className="li__bar">
            <i style={{ width: `${(r.value / max) * 100}%`, background: r.color, opacity: r.opacity ?? 1 }} />
          </span>
          <span className="li__v">{r.display}</span>
        </div>
      ))}
    </div>
  );
}
