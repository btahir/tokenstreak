// "Your trail": the full Trail with a hover tooltip, stat tiles, charts, the
// efficiency score, a year of light, breakdowns and recent achievements.

import { useMemo, useState } from "react";
import type { AppSnapshot, Breakdown, RangeKind } from "../../api/types";
import { Badge } from "../../components/badges";
import { BarChart, Heatmap, RankList, Sparkline } from "../../components/charts";
import { IconLock, IconShare, Spark } from "../../components/icons";
import { Card, Delta, Glyph, Ring, Seg, Tile } from "../../components/ui";
import {
  baseline,
  buildTrailData,
  dailyBars,
  dayCacheShare,
  efficiency,
  heatmapColumns,
  periodBars,
  progressLabel,
  tierInfo,
  trailSummary,
  windowSums,
} from "../../lib/derive";
import { formatDate, formatInt, formatLongDate, formatPercent, formatTokens, formatTowardGoal, formatUsd, parseDate, TOOL_NAMES, TOOL_SHORT } from "../../lib/format";
import { useReducedMotion, useResolvedTheme } from "../../lib/theme";
import { useAppState, useBreakdown } from "../../state/store";
import { TrailCanvas } from "../../trail/TrailCanvas";
import type { TrailHover } from "../../trail/types";
import type { Route } from "../route";
import { PageHead } from "./PageHead";

type Range = "week" | "month" | "year" | "all";
const RANGE_KIND: Record<Range, RangeKind> = { week: "last7", month: "last30", year: "thisYear", all: "all" };
const RANGE_LABEL: Record<Range, string> = { week: "last 7 days", month: "last 30 days", year: "this year", all: "all time" };
const RANGE_DAYS: Record<Range, number> = { week: 21, month: 45, year: 365, all: 2000 };

export function Overview({ snap, onShare, go }: { snap: AppSnapshot; onShare: () => void; go: (r: Route) => void }) {
  const [range, setRange] = useState<Range>("year");
  const b = useBreakdown({ kind: RANGE_KIND[range] });
  return (
    <div className="page" data-testid="page-overview">
      <PageHead
        eyebrow={formatLongDate(snap.today.date)}
        title="Your trail"
        actions={
          <>
            <Seg
              label="Range"
              value={range}
              onChange={setRange}
              options={[
                { value: "week", label: "Week" },
                { value: "month", label: "Month" },
                { value: "year", label: "Year" },
                { value: "all", label: "All" },
              ]}
            />
            <button type="button" className="btn btn--glow" onClick={onShare} data-testid="share-open">
              <IconShare /> Share
            </button>
          </>
        }
      />
      <Hero snap={snap} maxDays={RANGE_DAYS[range]} />
      <StatTiles snap={snap} b={b} range={range} />
      <div className="grid2">
        <UsageChart snap={snap} />
        <EfficiencyCard snap={snap} />
      </div>
      <YearOfLight snap={snap} />
      <Breakdowns b={b} range={range} />
      <RecentAchievements snap={snap} go={go} />
    </div>
  );
}

/* ---------------- hero ---------------- */

function Hero({ snap, maxDays }: { snap: AppSnapshot; maxDays: number }) {
  const theme = useResolvedTheme();
  const reduced = useReducedMotion();
  const celebration = useAppState((s) => s.celebration);
  const [hover, setHover] = useState<TrailHover | null>(null);
  const data = useMemo(() => buildTrailData(snap, { maxDays }), [snap, maxDays]);
  const t = snap.today;
  const tier = tierInfo(snap.streak.current);
  const afterglow = snap.streak.current === 0 && snap.streak.longest > 0 ? tierInfo(snap.streak.longest) : null;
  const [celebrateKey, setCelebrateKey] = useState(0);
  const [lastCeleb, setLastCeleb] = useState<string | null>(null);
  if (celebration && celebration.date !== lastCeleb) {
    setLastCeleb(celebration.date);
    setCelebrateKey((k) => k + 1);
  }
  const layout = useMemo(() => ({ maxDays }), [maxDays]);
  const pct = Math.round(t.progress * 100);
  return (
    <section className="hero ts-grain" data-testid="hero">
      <TrailCanvas
        data={data}
        theme={theme}
        variant="full"
        layout={layout}
        reducedMotion={reduced}
        celebrateKey={celebrateKey}
        onHover={setHover}
        keyboard
        ariaLabel={`${trailSummary(snap)}. Use the arrow keys to step through days.`}
      />
      <div className="hero__hud">
        <div className="hero__lab">{t.met ? "Goal lit today" : "Today’s light"}</div>
        <div className="hero__num">
          {formatTowardGoal(t.tokens.total, t.goal)}
          {t.goal > 0 && <small>of {formatTokens(t.goal)}</small>}
        </div>
        <div className="hero__row">
          <span className="hpill">
            <Spark size={13} from={theme === "dark" ? "#FFF6EA" : "#FFB27A"} to={theme === "dark" ? "#FFD6A8" : "#F0728C"} />
            {streakLine(snap.streak.current, snap.streak.longest)}
          </span>
          {t.goal > 0 && <span className="hpill">{t.met ? `Lit · ${progressLabel(t.progress)}` : `${pct}% · ${formatTokens(t.remaining)} to go`}</span>}
        </div>
      </div>
      <span className="hpill hero__tier" data-testid="tier-chip">
        {afterglow
          ? `${afterglow.name} afterglow · from your ${formatInt(snap.streak.longest)}-day run`
          : `${tier.name} tier${tier.next ? ` · ${tier.next} in ${formatInt(tier.daysToNext ?? 0)} ${tier.daysToNext === 1 ? "day" : "days"}` : " · the brightest"}`}
      </span>
      <div className="hero__legend">
        <span>
          <Glyph tool="claude" />
          Claude Code
        </span>
        <span>
          <Glyph tool="codex" />
          Codex
        </span>
        <span>
          <Glyph tool="gemini" />
          Gemini
        </span>
        <span className="hero__legend-note">Width = tokens · breaks = missed days</span>
      </div>
      {hover && <HeroTip hover={hover} />}
    </section>
  );
}

/** "12-day streak · best 30", "30-day streak · your best", "Best run 8 days · start a new one". */
export function streakLine(current: number, longest: number): string {
  if (current > 0) return current >= longest ? `${formatInt(current)}-day streak · your best` : `${formatInt(current)}-day streak · best ${formatInt(longest)}`;
  if (longest > 0) return `Best run ${formatInt(longest)} ${longest === 1 ? "day" : "days"} · start a new one`;
  return "Your trail starts today";
}

function HeroTip({ hover }: { hover: TrailHover }) {
  const d = hover.day;
  const goal = d.goal ?? 0;
  const tools = (Object.entries(d.tools) as [keyof typeof TOOL_SHORT, number][]).filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]);
  const left = hover.x < 140;
  return (
    <div
      className="tip tip--float tip--trail"
      style={{ left: hover.x, top: hover.y, transform: `translate(${left ? "-12px" : "-50%"}, calc(-100% - 18px))` }}
      role="tooltip"
      data-testid="trail-tip"
    >
      <div className="tip__h">{d.isToday ? "Today" : d.date ? formatDate(d.date) : ""}</div>
      <b className="tip__num">{d.tokens ? formatTokens(d.tokens) : "No tokens"}</b>
      <div className="tip__foot">
        {d.goalMet ? "Goal lit" : d.frozen ? (d.freeze ? "Streak freeze · streak kept" : "Rest day · streak kept") : d.tokens ? (goal ? `${Math.round((d.tokens / goal) * 100)}% of goal` : "Under goal") : d.isToday ? "Just getting started" : "Day off"}
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
    </div>
  );
}

/* ---------------- tiles ---------------- */

function StatTiles({ snap, b, range }: { snap: AppSnapshot; b: Breakdown | null; range: Range }) {
  const days = snap.days;
  const today = snap.today.date;
  const spark = useMemo(() => {
    const totals = days.map((d) => d.total);
    if (range === "week") return totals.slice(-7);
    if (range === "month") return totals.slice(-30);
    if (range === "all" && totals.length > 26 * 7) return windowSums(totals.slice(-(Math.floor(totals.length / 7) * 7)), 7).slice(-52);
    return windowSums(totals.slice(-182), 7);
  }, [days, range]);
  const cacheSpark = useMemo(() => {
    const src = range === "week" ? days.slice(-7) : range === "month" ? days.slice(-30) : days.slice(-182);
    if (range === "week" || range === "month") return src.filter((d) => d.total > 0).map(dayCacheShare);
    const out: number[] = [];
    for (let i = 0; i + 7 <= src.length; i += 7) {
      const wk = src.slice(i, i + 7);
      const tot = wk.reduce((a, d) => a + d.total, 0);
      out.push(tot ? wk.reduce((a, d) => a + d.cacheRead, 0) / tot : 0);
    }
    return out;
  }, [days, range]);
  // cost per active day vs the previous window of the same length
  const winLen = range === "week" ? 7 : range === "month" ? 30 : range === "year" ? Math.max(1, Math.round((parseDate(today).getTime() - Date.UTC(parseDate(today).getUTCFullYear(), 0, 1)) / 864e5) + 1) : days.length;
  const cur = days.slice(-winLen).filter((d) => d.total > 0);
  const prev = days.slice(-winLen * 2, -winLen).filter((d) => d.total > 0);
  const cpd = (xs: typeof days) => (xs.length ? xs.reduce((a, d) => a + d.cost, 0) / xs.length : 0);
  const change = prev.length >= 3 && cpd(prev) > 0 ? (cpd(cur) - cpd(prev)) / cpd(prev) : null;
  const base = baseline(days, today);
  const eff = b?.efficiency;
  const perSession = eff?.tokensPerSession ?? 0;
  const inZone = perSession >= base.sessionLow && perSession <= base.sessionHigh;
  return (
    <div className="grid4" data-testid="stat-tiles">
      <Tile label={`Tokens ${RANGE_LABEL[range]}`} value={b ? formatTokens(b.totals.total) : "—"}>
        <div className="tile__spark">
          <Sparkline values={spark} color="var(--accent)" />
        </div>
      </Tile>
      <Tile label="Est. cost per day" badge={<span className="rarity tile__badge">estimate</span>} value={eff ? formatUsd(eff.costPerActiveDay) : "—"}>
        {change !== null && Math.abs(change) >= 0.01 && (
          <Delta lean={change < 0} warm={change > 0}>
            {change < 0 ? "↓" : "↑"} {Math.round(Math.abs(change) * 100)}% vs previous {range === "all" ? "period" : range}
          </Delta>
        )}
      </Tile>
      <Tile label="From cache" value={eff ? Math.round(eff.cacheReadShare * 100) : "—"} unit={eff ? "%" : undefined}>
        <div className="tile__spark">
          <Sparkline values={cacheSpark} color="var(--moon)" />
        </div>
      </Tile>
      <Tile label="Tokens per session" value={eff ? formatTokens(perSession) : "—"}>
        {base.activeDays >= 3 && perSession > 0 && (
          <Delta warm={!inZone}>
            {inZone ? "In your zone" : perSession > base.sessionHigh ? "Longer than usual" : "Shorter than usual"} ({formatTokens(base.sessionLow)}–{formatTokens(base.sessionHigh)})
          </Delta>
        )}
      </Tile>
    </div>
  );
}

/* ---------------- charts ---------------- */

function UsageChart({ snap }: { snap: AppSnapshot }) {
  const [mode, setMode] = useState<"daily" | "weekly" | "monthly">("daily");
  const rows = useMemo(() => {
    if (mode === "daily") return dailyBars(snap.days, snap.today.date, 30);
    if (mode === "weekly") return periodBars(snap.weeks, "week", 16, snap.goals.thisWeek.start);
    return periodBars(snap.months, "month", 12, snap.today.date.slice(0, 7));
  }, [snap, mode]);
  const goal = mode === "daily" ? snap.goals.daily : mode === "weekly" ? snap.goals.weekly : null;
  const sub =
    mode === "daily" ? "Last 30 days, stacked by agent · dots mark goal days" : mode === "weekly" ? "Last 16 weeks · dots mark weeks that hit the weekly goal" : "Last 12 months, stacked by agent";
  return (
    <Card
      title={mode === "daily" ? "Daily tokens" : mode === "weekly" ? "Weekly tokens" : "Monthly tokens"}
      sub={sub}
      action={
        <Seg
          label="Chart period"
          value={mode}
          onChange={setMode}
          options={[
            { value: "daily", label: "Daily" },
            { value: "weekly", label: "Weekly" },
            { value: "monthly", label: "Monthly" },
          ]}
        />
      }
    >
      <BarChart
        rows={rows}
        height={196}
        goal={goal || null}
        labelEvery={mode === "daily" ? 3 : mode === "weekly" ? 2 : 1}
        heading={(r) => (mode === "daily" ? (r.isCurrent ? "Today" : formatDate(r.key)) : mode === "weekly" ? `Week of ${formatDate(r.key)}` : r.label)}
        testId="usage-chart"
      />
    </Card>
  );
}

function EfficiencyCard({ snap }: { snap: AppSnapshot }) {
  const e = useMemo(() => efficiency({ tokens: snap.today.tokens, cost: snap.today.cost, sessions: snap.today.sessions }, baseline(snap.days, snap.today.date), (n) => formatUsd(n)), [snap]);
  return (
    <Card title="Efficiency" sub="Today, compared with your own 30-day baseline" className="eff-card">
      <div className="eff" data-testid="efficiency">
        <Ring value={e.score / 100} size={96} stroke={9} label={snap.today.tokens.total ? e.score : "–"} />
        <div>
          <div className="eff__word">{e.word}</div>
          <div className="ts-label eff__line">{e.line}</div>
        </div>
      </div>
      <div className="contrib">
        {e.contributors.map((c) => (
          <div className="contrib__r" key={c.key}>
            <span>{c.label}</span>
            <div className="contrib__bar">
              <i style={{ width: `${Math.round(c.score * 100)}%` }} />
            </div>
            <span className="contrib__v">{c.value}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function YearOfLight({ snap }: { snap: AppSnapshot }) {
  const cols = useMemo(() => heatmapColumns(snap.days, snap.today.date, 53, snap.goals.weekStartsOn, snap.streak.restDays), [snap]);
  const yearAgo = cols[0]?.[0]?.date ?? snap.today.date;
  const inYear = snap.days.filter((d) => d.date >= yearAgo);
  const lit = inYear.filter((d) => d.met).length;
  const rests = cols.flat().filter((c) => c.frozen && !c.freeze).length;
  const freezes = cols.flat().filter((c) => c.freeze).length;
  return (
    <Card
      title="A year of light"
      sub={`${lit} ${lit === 1 ? "day" : "days"} lit · longest streak ${snap.streak.longest}${rests ? ` · ${rests} rest ${rests === 1 ? "day" : "days"} bridged` : ""}${freezes ? ` · ${freezes} ${freezes === 1 ? "freeze" : "freezes"} spent` : ""}`}
      action={
        <div className="hlegend" aria-hidden>
          Less <i style={{ background: "var(--heat-0)" }} />
          <i style={{ background: "var(--heat-1)" }} />
          <i style={{ background: "var(--heat-2)" }} />
          <i style={{ background: "var(--heat-3)" }} />
          <i style={{ background: "var(--heat-4)" }} /> More · <i className="hlegend__goal" /> goal
        </div>
      }
      className="heat-card"
    >
      <Heatmap columns={cols} />
    </Card>
  );
}

/* ---------------- breakdowns ---------------- */

function Breakdowns({ b, range }: { b: Breakdown | null; range: Range }) {
  if (!b) return <div className="grid3 grid3--loading" />;
  const toolRows = b.byTool.filter((s) => s.tokens.total > 0);
  const cacheBy = toolRows.map((s) => {
    const d = s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite;
    return `${TOOL_SHORT[s.tool ?? "claude"]} ${Math.round((d ? s.tokens.cacheRead / d : 0) * 100)}%`;
  });
  const projects = b.byProject.slice(0, 5);
  const others = b.byProject.length - projects.length;
  return (
    <div className="grid3" data-testid="breakdowns">
      <Card title="By agent" action={<span className="card__sub">{RANGE_LABEL[range][0]!.toUpperCase() + RANGE_LABEL[range].slice(1)}</span>}>
        <RankList
          testId="by-agent"
          rows={toolRows.map((s) => ({ key: s.key, label: TOOL_NAMES[s.tool ?? "claude"], value: s.tokens.total, display: formatTokens(s.tokens.total), color: `var(--tool-${s.tool})`, glyph: s.tool }))}
        />
        {toolRows.length > 0 && <div className="note">Cache reuse by agent: {cacheBy.join(" · ")}. Agents cache differently, so compare each with itself.</div>}
        {toolRows.length === 0 && <div className="note">No agent activity in this range.</div>}
      </Card>
      <Card title="By model" action={<span className="card__sub">Share of tokens</span>}>
        <RankList
          testId="by-model"
          rows={b.byModel.slice(0, 5).map((s) => ({ key: s.key, label: s.label, value: s.share, display: formatPercent(s.share), color: `var(--tool-${s.tool ?? "other"})`, glyph: s.tool, mono: true, title: s.label }))}
        />
        {b.byModel.length > 5 && <div className="note">+ {b.byModel.length - 5} more {b.byModel.length - 5 === 1 ? "model" : "models"}</div>}
      </Card>
      <Card title="By project" action={<span className="card__sub">Stays on this Mac</span>}>
        <RankList
          testId="by-project"
          rows={projects.map((s, i) => ({ key: s.key, label: s.label, value: s.share, display: formatPercent(s.share), color: "var(--ink-3)", opacity: 0.85 - i * 0.12, mono: true, title: s.label }))}
        />
        <div className="note">
          <IconLock size={13} />
          <span>
            {others > 0 ? `+ ${others} more. ` : ""}Project names are hidden on share cards unless you turn them on.
          </span>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- achievements ---------------- */

function RecentAchievements({ snap, go }: { snap: AppSnapshot; go: (r: Route) => void }) {
  const unlocked = snap.achievements.filter((a) => a.unlockedAt).sort((a, b) => (b.unlockedAt ?? "").localeCompare(a.unlockedAt ?? ""));
  const next = snap.achievements.filter((a) => !a.unlockedAt).sort((a, b) => b.progress / (b.target || 1) - a.progress / (a.target || 1))[0];
  const shown = unlocked.slice(0, next ? 5 : 6);
  return (
    <Card
      title="Recent achievements"
      sub={`${unlocked.length} of ${snap.achievements.length} unlocked`}
      action={
        <button type="button" className="btn btn--ghost" onClick={() => go("achievements")}>
          See all
        </button>
      }
    >
      <div className="badges-row" data-testid="recent-achievements">
        {shown.map((a) => (
          <Badge key={a.id} a={a} size={72} compact meta={formatDate(a.unlockedAt!)} />
        ))}
        {next && <Badge a={next} size={72} compact meta={progressMeta(next)} />}
        {!shown.length && !next && <div className="note">Your first badge arrives with your first goal day.</div>}
      </div>
    </Card>
  );
}

export function progressMeta(a: AppSnapshot["achievements"][number]): string {
  const left = Math.max(0, a.target - a.progress);
  if (a.id.startsWith("streak-")) return `${Math.ceil(left)} ${Math.ceil(left) === 1 ? "day" : "days"} to go`;
  if (a.target >= 1000) return `${formatTokens(left)} to go`;
  if (a.target > 1 && a.target < 1) return `${Math.round((a.progress / a.target) * 100)}%`;
  return `${Math.round((a.progress / (a.target || 1)) * 100)}% there`;
}
