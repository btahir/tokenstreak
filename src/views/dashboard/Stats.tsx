// Stats: the numbers behind the light. Totals for a range, token anatomy,
// caching payoff, cost over time, when you work, biggest sessions, lifetime.

import { useState } from "react";
import type { AppSnapshot, Breakdown, RangeKind } from "../../api/types";
import { AreaChart, MiniBars } from "../../components/charts";
import { IconDownload, IconLock } from "../../components/icons";
import { Card, Delta, Glyph, Seg, Tile } from "../../components/ui";
import { cacheShareOf } from "../../lib/derive";
import { formatDayYear, formatInt, formatPercent, formatTimes, formatTokens, formatUsd, plural, TOOL_NAMES } from "../../lib/format";
import { useApi, useBreakdown } from "../../state/store";
import { PageHead } from "./PageHead";

type R = "last7" | "last30" | "last90" | "thisYear" | "all";
const LABEL: Record<R, string> = { last7: "Last 7 days", last30: "Last 30 days", last90: "Last 90 days", thisYear: "This year", all: "All time" };

export function Stats({ snap }: { snap: AppSnapshot }) {
  const [range, setRange] = useState<R>("last30");
  const b = useBreakdown({ kind: range as RangeKind });
  const api = useApi();
  const [exported, setExported] = useState<string | null>(null);
  const exportCsv = async () => {
    if (!api) return;
    const csv = await api.exportCsv({ kind: range as RangeKind });
    const b64 = btoa(unescape(encodeURIComponent(csv)));
    const path = await api.saveExport(`tokenstreak-${range}-${snap.today.date}.csv`, b64);
    setExported(path);
    setTimeout(() => setExported(null), 4000);
  };
  return (
    <div className="page" data-testid="page-stats">
      <PageHead
        eyebrow={b ? `${formatDayYear(b.from)} – ${formatDayYear(b.to)}` : LABEL[range]}
        title="Stats"
        actions={
          <>
            <Seg
              label="Range"
              value={range}
              onChange={setRange}
              options={[
                { value: "last7", label: "7 days" },
                { value: "last30", label: "30 days" },
                { value: "last90", label: "90 days" },
                { value: "thisYear", label: "Year" },
                { value: "all", label: "All" },
              ]}
            />
            <button type="button" className="btn" onClick={() => void exportCsv()} data-testid="export-csv">
              <IconDownload /> {exported ? "Saved to Downloads" : "Export CSV"}
            </button>
          </>
        }
      />
      {b ? <StatsBody snap={snap} b={b} /> : <div className="stats-loading" />}
    </div>
  );
}

function StatsBody({ snap, b }: { snap: AppSnapshot; b: Breakdown }) {
  const t = b.totals;
  const lit = b.series.filter((d) => d.met).length;
  const share = cacheShareOf(t);
  const payoff = t.cacheWrite > 0 ? t.cacheRead / t.cacheWrite : 0;
  const parts = [
    { key: "cacheRead", label: "Cache read", value: t.cacheRead, color: "var(--moon)", note: "Context reused from cache. The cheapest tokens there are." },
    { key: "cacheWrite", label: "Cache write", value: t.cacheWrite, color: "#8B6CF0", note: "Context stored so later turns can reuse it." },
    { key: "input", label: "Input", value: t.input, color: "var(--tool-claude)", note: "Fresh prompt tokens sent to the model." },
    { key: "output", label: "Output", value: t.output, color: "var(--tool-codex)", note: "What the model wrote back, including reasoning." },
    { key: "other", label: "Other", value: t.other, color: "var(--tool-other)", note: "Tool-reported extras (e.g. Gemini thoughts)." },
  ].filter((p) => p.value > 0);
  const total = t.total || 1;
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hourLabels = Array.from({ length: 24 }, (_, h) => (h % 6 === 0 ? (h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`) : ""));
  const peakHour = b.hourly.indexOf(Math.max(...b.hourly));
  const peakDay = b.weekday.indexOf(Math.max(...b.weekday));
  const hourName = (h: number) => (h === 0 ? "midnight" : h === 12 ? "noon" : h < 12 ? `${h} am` : `${h - 12} pm`);
  const L = snap.lifetime;
  return (
    <>
      <div className="grid4" data-testid="stats-tiles">
        <Tile label="Tokens" value={formatTokens(t.total)}>
          <div className="tile__foot">{formatInt(t.total)} in total</div>
        </Tile>
        <Tile label="Est. cost" badge={<span className="rarity tile__badge">estimate</span>} value={formatUsd(b.cost)}>
          <div className="tile__foot">{formatUsd(b.efficiency.costPerMillion)} per 1M tokens</div>
        </Tile>
        <Tile label="Sessions" value={formatInt(b.sessions)}>
          <div className="tile__foot">{formatInt(b.messages)} messages · {formatTokens(b.efficiency.tokensPerSession)} each</div>
        </Tile>
        <Tile label="Active days" value={formatInt(b.activeDays)}>
          <Delta>{plural(lit, "goal day")} lit</Delta>
        </Tile>
      </div>

      <div className="grid2">
        <Card title="Token anatomy" sub="What every token was, across all agents">
          <div className="anatomy" data-testid="anatomy">
            <div className="anatomy__bar" aria-hidden>
              {parts.map((p) => (
                <i key={p.key} style={{ flex: p.value / total, background: p.color }} title={p.label} />
              ))}
            </div>
            <div className="anatomy__rows">
              {parts.map((p) => (
                <div className="anatomy__row" key={p.key}>
                  <i style={{ background: p.color }} />
                  <div>
                    <div className="anatomy__name">
                      {p.label} <span>{formatPercent(p.value / total, p.value / total < 0.01 ? 1 : 0)}</span>
                    </div>
                    <div className="anatomy__note">{p.note}</div>
                  </div>
                  <b>{formatTokens(p.value)}</b>
                </div>
              ))}
            </div>
          </div>
        </Card>
        <Card title="Caching" sub="The quiet efficiency behind your streak">
          <div className="savings">
            <div className="eyebrow">Caching saved you about</div>
            <div className="savings__num">{formatUsd(b.efficiency.cacheSavings, { cents: b.efficiency.cacheSavings < 100 })}</div>
            <div className="ts-label">Estimated against sending the same context fresh each time.</div>
          </div>
          <div className="savings__grid">
            <div>
              <span className="ts-label">From cache</span>
              <b>{formatPercent(share)}</b>
            </div>
            <div>
              <span className="ts-label">Cache payoff</span>
              <b>{payoff ? formatTimes(payoff) : "—"}</b>
            </div>
            <div>
              <span className="ts-label">Per message</span>
              <b>{formatTokens(b.efficiency.tokensPerMessage)}</b>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid2">
        <Card title="Estimated cost per day" sub={`Average ${formatUsd(b.efficiency.costPerActiveDay)} on active days · estimates from the bundled price list`}>
          <AreaChart points={b.series.map((d) => ({ key: d.date, value: d.cost }))} height={184} color="var(--accent)" label="Estimated cost per day" />
        </Card>
        <Card title="When you work" sub={b.hourly.some((v) => v > 0) ? `Busiest around ${hourName(peakHour)} · ${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][peakDay]}s are your big day` : "No activity in this range"}>
          <div className="when">
            <MiniBars values={b.hourly} labels={hourLabels} height={96} label="Tokens by hour of day" />
            <MiniBars values={b.weekday} labels={dayNames.map((d) => d[0]!)} height={72} label="Tokens by weekday" color="var(--tool-gemini)" />
          </div>
        </Card>
      </div>

      <Card title="Biggest sessions" sub="Project names stay on this Mac" action={<IconLock size={13} />}>
        {b.topSessions.length ? (
          <table className="sessions" data-testid="top-sessions">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Project</th>
                <th>Started</th>
                <th>Length</th>
                <th>Model</th>
                <th className="num">Tokens</th>
                <th className="num">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {b.topSessions.slice(0, 8).map((s) => {
                const mins = Math.max(1, Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 60000));
                return (
                  <tr key={s.id}>
                    <td>
                      <span className="sessions__tool">
                        <Glyph tool={s.tool} />
                        {TOOL_NAMES[s.tool].replace(" CLI", "")}
                      </span>
                    </td>
                    <td className="mono">{s.project || "—"}</td>
                    <td>{formatDayYear(s.startedAt.slice(0, 10))}</td>
                    <td>{mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`}</td>
                    <td className="mono sessions__model">{s.models[0] ?? "—"}</td>
                    <td className="num">{formatTokens(s.tokens)}</td>
                    <td className="num">{formatUsd(s.cost)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="note">No sessions in this range yet.</div>
        )}
      </Card>

      <Card title="Lifetime" sub={L.firstDate ? `Since ${formatDayYear(L.firstDate)}` : "Everything Tokenstreak has seen"}>
        <div className="facts" data-testid="lifetime">
          <Fact label="Tokens" value={formatTokens(L.tokens.total)} />
          <Fact label="Est. cost" value={formatUsd(L.cost, { cents: false })} />
          <Fact label="Active days" value={formatInt(L.activeDays)} />
          <Fact label="Best day" value={L.bestDay ? formatTokens(L.bestDay.tokens) : "—"} sub={L.bestDay ? formatDayYear(L.bestDay.date) : undefined} />
          <Fact label="Longest streak" value={`${snap.streak.longest}`} sub={snap.streak.longestStart ? `from ${formatDayYear(snap.streak.longestStart)}` : undefined} />
          <Fact label="Sessions" value={formatInt(L.sessions)} />
          <Fact label="Favourite agent" value={L.favoriteTool ? TOOL_NAMES[L.favoriteTool] : "—"} small />
          <Fact label="Favourite model" value={L.favoriteModel ?? "—"} small mono />
          <Fact label="Models · projects" value={`${L.modelsUsed} · ${L.projects}`} />
          <Fact label="Saved by caching" value={formatUsd(L.cacheSavings, { cents: false })} sub="estimate" />
        </div>
      </Card>
    </>
  );
}

function Fact({ label, value, sub, small, mono }: { label: string; value: string; sub?: string; small?: boolean; mono?: boolean }) {
  return (
    <div className="fact">
      <span className="ts-label">{label}</span>
      <b className={`${small ? "fact--small" : ""}${mono ? " fact--mono" : ""}`} title={value}>
        {value}
      </b>
      {sub && <span className="fact__sub">{sub}</span>}
    </div>
  );
}
