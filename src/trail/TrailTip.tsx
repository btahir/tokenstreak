// Hover / keyboard tooltip for the full Trail. Measures itself and stays inside
// the hero: above the day when there is room, flipped below near the top, and
// clamped at both sides so it never covers the edge or gets clipped.

import { useLayoutEffect, useRef, useState } from "react";
import { formatDate, formatInt, formatPercent, formatTokens, TOOL_SHORT } from "../lib/format";
import { placeTip } from "./layout";
import { measureAvoid } from "./TrailCanvas";
import type { TrailHover } from "./types";

export function TrailTip({ hover }: { hover: TrailHover }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const d = hover.day;
  const goal = d.goal ?? 0;
  const tools = (Object.entries(d.tools ?? {}) as [keyof typeof TOOL_SHORT, number][]).filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]);
  const run = hover.run && hover.run.days >= 2 ? hover.run : null;

  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.offsetParent as HTMLElement | null;
    if (!el || !box) return;
    const canvas = box.querySelector("canvas");
    const hud = canvas ? measureAvoid(canvas, box) : [];
    setPos(placeTip(hover.x, hover.y, el.offsetWidth, el.offsetHeight, box.clientWidth, box.clientHeight, 16, 10, 90, hud));
  }, [hover.x, hover.y, hover.index, run?.days]);

  return (
    <div
      ref={ref}
      className={`tip tip--float tip--trail${pos?.below ? " tip--below" : ""}`}
      style={{ left: pos?.left ?? hover.x, top: pos?.top ?? hover.y, visibility: pos ? "visible" : "hidden" }}
      role="tooltip"
      data-testid="trail-tip"
    >
      <div className="tip__h">{d.isToday ? "Today" : d.date ? formatDate(d.date) : ""}</div>
      <b className="tip__num">{d.tokens ? formatTokens(d.tokens) : "No tokens"}</b>
      <div className="tip__foot">
        {d.goalMet
          ? "Goal lit"
          : d.frozen
            ? d.freeze
              ? "Streak freeze · streak kept"
              : "Rest day · streak kept"
            : d.tokens
              ? goal
                ? `${Math.floor((d.tokens / goal) * 100)}% of goal`
                : "Under goal"
              : d.isToday
                ? "Just getting started"
                : "Day off"}
        {d.tokens > 0 && ` · ${formatPercent(d.cacheShare)} cache`}
      </div>
      {tools.length > 0 && (
        <div className="tip__rows">
          {tools.map(([k, v]) => (
            <span key={k}>
              <i className={`glyph glyph--${k}`} />
              {TOOL_SHORT[k]} {formatPercent(v)}
            </span>
          ))}
        </div>
      )}
      {run && (
        <div className="tip__run" data-testid="trail-tip-run">
          {run.current ? `Your ${formatInt(run.days)}-day streak · since ${formatDate(run.from)}` : `${formatInt(run.days)}-day run · ${formatDate(run.from)} – ${formatDate(run.to)}`}
        </div>
      )}
    </div>
  );
}
