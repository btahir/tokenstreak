// Small design-system primitives (Afterglow). Styles live in styles/components.css.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Tool } from "../api/types";
import { Spark } from "./icons";
import { playCue } from "../lib/sound";

export function Glyph({ tool, lg }: { tool: Tool | "other"; lg?: boolean }) {
  return <i className={`glyph glyph--${tool}${lg ? " glyph--lg" : ""}`} aria-hidden />;
}

export function Chip({ children, solid, off, onClick, active, title }: { children: ReactNode; solid?: boolean; off?: boolean; onClick?: () => void; active?: boolean; title?: string }) {
  const cls = `chip${solid ? " chip--solid" : ""}${off ? " chip--off" : ""}${active ? " chip--active" : ""}${onClick ? " chip--btn" : ""}`;
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} aria-pressed={active} title={title}>
      {children}
    </button>
  ) : (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

export function Tile({ label, value, unit, children, className, badge }: { label: ReactNode; value: ReactNode; unit?: string; children?: ReactNode; className?: string; badge?: ReactNode }) {
  return (
    <div className={`tile${className ? ` ${className}` : ""}`}>
      <div className="tile__label">
        {label}
        {badge}
      </div>
      <div className="tile__value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {children}
    </div>
  );
}

export function Delta({ children, lean, warm }: { children: ReactNode; lean?: boolean; warm?: boolean }) {
  return <span className={`tile__delta${lean ? " tile__delta--lean" : ""}${warm ? " tile__delta--warm" : ""}`}>{children}</span>;
}

export function Progress({ value, lit, label, className }: { value: number; lit?: boolean; label?: string; className?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={`progress${lit ? " progress--lit" : ""}${pct <= 0 ? " progress--empty" : ""}${className ? ` ${className}` : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-label={label}
    >
      <div className="progress__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Ring({ value, size = 64, stroke = 7, label }: { value: number; size?: number; stroke?: number; label?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden>
        <defs>
          <linearGradient id="ts-ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#A9D8F5" />
            <stop offset="1" stopColor="#8B6CF0" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <circle
          className="ring__arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="url(#ts-ring-grad)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * v} ${c}`}
        />
      </svg>
      <div className="ring__val" style={{ fontSize: size * 0.34 }}>
        {label ?? Math.round(v * 100)}
      </div>
    </div>
  );
}

export type StreakTone = "lit" | "risk" | "frozen" | "rest" | "none";

/**
 * The streak pill. `days` null hides the number (no "0-day streak"); `sub`
 * stacks a small second line under the label ("light it tonight").
 */
export function StreakPill({ days, tone = "lit", children, sub, onDark }: { days: number | null; tone?: StreakTone; children?: ReactNode; sub?: ReactNode; onDark?: boolean }) {
  const label = children ?? "day streak";
  return (
    <span className={`streak streak--${tone}${sub ? " streak--stack" : ""}`} data-testid="streak-pill">
      <span className="streak__spark">
        <Spark size={14} from={onDark ? "#FFF6EA" : "#FFB27A"} to={onDark ? "#FFD6A8" : "#F0728C"} />
      </span>
      {days !== null && <b>{days.toLocaleString("en-US")}</b>}
      {sub ? (
        <span className="streak__lines">
          <span>{label}</span>
          <small>{sub}</small>
        </span>
      ) : (
        label
      )}
    </span>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`toggle${on ? " on" : ""}`}
      onClick={() => {
        playCue("tick");
        onChange(!on);
      }}
    />
  );
}

export function Seg<T extends string | number>({ options, value, onChange, label, size }: { options: { value: T; label: ReactNode; title?: string }[]; value: T | T[]; onChange: (v: T) => void; label: string; size?: "sm" }) {
  const multi = Array.isArray(value);
  // radio groups: one tab stop, arrow keys move and select (WAI-ARIA radiogroup)
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (multi) return;
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = Math.max(0, options.findIndex((o) => o.value === value));
    const next = (i + dir + options.length) % options.length;
    onChange(options[next]!.value);
    const btns = e.currentTarget.querySelectorAll<HTMLButtonElement>("button");
    btns[next]?.focus();
  };
  return (
    <div className={`seg${size ? ` seg--${size}` : ""}`} role={multi ? "group" : "radiogroup"} aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o) => {
        const on = multi ? (value as T[]).includes(o.value) : value === o.value;
        return (
          <button
            key={String(o.value)}
            type="button"
            className={on ? "on" : ""}
            role={multi ? undefined : "radio"}
            aria-checked={multi ? undefined : on}
            aria-pressed={multi ? on : undefined}
            tabIndex={multi || on ? 0 : -1}
            title={o.title}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Card({ title, sub, action, children, className, id }: { title?: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`card${className ? ` ${className}` : ""}`} id={id}>
      {(title || action) && (
        <div className="card__head">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {sub && <div className="card__sub">{sub}</div>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** Horizontal share meter (tool mix). */
export function Meter({ parts }: { parts: { key: string; value: number; color?: string }[] }) {
  const tot = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div className="meter" aria-hidden>
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <i key={p.key} style={{ flex: p.value / tot, background: p.color ?? `var(--tool-${p.key})` }} />
        ))}
    </div>
  );
}

/** Counts up to `value` when it changes (respecting reduced motion). */
export function useCountUp(value: number, ms = 700): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const raf = useRef(0);
  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    const tick = (now: number) => {
      const f = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - f, 4);
      setShown(a + (value - a) * e);
      if (f < 1) raf.current = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf.current);
      from.current = value;
    };
  }, [value, ms]);
  return shown;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="eyebrow">{children}</div>;
}
