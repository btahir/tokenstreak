// Unstyled dashboard scaffold. It exercises every API call and field so the
// frontend builder can see real shapes; replace it with the designed UI.

import { useState } from "react";
import type { RangeKind, ShareCardData, ShareFormat } from "../api";
import { SUPPORT_URL } from "../config";
import { TOOL_NAMES, formatPercent, formatTokens, formatUsd } from "../lib/format";
import { updateSettings, useApi, useBreakdown, useSettings, useSnapshot } from "../state/store";

const RANGES: RangeKind[] = ["today", "last7", "last30", "last90", "thisMonth", "thisYear", "all"];

export function Dashboard() {
  const snap = useSnapshot();
  if (!snap) return <p data-testid="loading">Loading…</p>;
  return (
    <main data-testid="dashboard" style={{ padding: "40px 24px", maxWidth: 1100, margin: "0 auto" }}>
      {!snap.onboarding.completed ? <Onboarding /> : <Overview />}
    </main>
  );
}

function Onboarding() {
  const snap = useSnapshot()!;
  const api = useApi();
  const [daily, setDaily] = useState(snap.goals.suggestedDaily);
  return (
    <section data-testid="onboarding">
      <h1>Welcome to Tokenstreak</h1>
      <p>Found: {snap.onboarding.toolsFound.map((t) => TOOL_NAMES[t]).join(", ") || "no supported tools yet"}</p>
      <p data-testid="reveal">
        {snap.onboarding.activeDays} active days since {snap.onboarding.firstActivity ?? "today"} ·{" "}
        {formatTokens(snap.lifetime.tokens.total)} tokens · best day {snap.lifetime.bestDay ? formatTokens(snap.lifetime.bestDay.tokens) : "—"} ·{" "}
        {snap.achievements.filter((a) => a.unlockedAt).length} achievements already earned
      </p>
      <label>
        Daily goal <input type="number" value={daily} onChange={(e) => setDaily(Number(e.target.value))} />
      </label>{" "}
      <button onClick={() => void api?.completeOnboarding({ daily, weekly: daily * 5 })}>Start my streak</button>
      <p>
        <small>Reads usage numbers only. Your prompts and responses never leave the log files, and nothing leaves your Mac.</small>
      </p>
    </section>
  );
}

function Overview() {
  const snap = useSnapshot()!;
  const api = useApi();
  const [range, setRange] = useState<RangeKind>("last30");
  const b = useBreakdown({ kind: range });
  return (
    <>
      <section data-testid="summary">
        <h1>
          {formatTokens(snap.today.tokens.total)} today · {snap.streak.current}-day streak · {formatTokens(snap.lifetime.tokens.total)} all time
        </h1>
        <p>
          This week {formatTokens(snap.goals.thisWeek.tokens)} / {formatTokens(snap.goals.thisWeek.goal)} ({formatPercent(snap.goals.thisWeek.progress)}) · lifetime est.{" "}
          {formatUsd(snap.lifetime.cost)} · cache saved {formatUsd(snap.lifetime.cacheSavings)}
        </p>
      </section>

      <section data-testid="heatmap">
        <h2>History ({snap.days.length} days)</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
          {snap.days.slice(-371).map((d) => (
            <span key={d.date} title={`${d.date}: ${formatTokens(d.total)}${d.met ? " ✓" : ""}`} style={{ width: 10, height: 10, background: d.met ? "#3a3" : d.total > 0 ? "#9c9" : "#8883" }} />
          ))}
        </div>
      </section>

      <section data-testid="breakdown">
        <h2>
          Breakdown{" "}
          <select value={range} onChange={(e) => setRange(e.target.value as RangeKind)} aria-label="Range">
            {RANGES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </h2>
        {b && (
          <>
            <p>
              {b.from} → {b.to}: {formatTokens(b.totals.total)} tokens, {formatUsd(b.cost)}, {b.activeDays} active days, {b.sessions} sessions · cache-read share{" "}
              {formatPercent(b.efficiency.cacheReadShare)} · {formatUsd(b.efficiency.costPerActiveDay)}/day · {formatTokens(b.efficiency.tokensPerSession)}/session
            </p>
            <Table title="By tool" rows={b.byTool.map((s) => [s.label, formatTokens(s.tokens.total), formatPercent(s.share), formatUsd(s.cost)])} />
            <Table title="By model" rows={b.byModel.map((s) => [s.label, s.tool ?? "", formatTokens(s.tokens.total), formatUsd(s.cost)])} />
            <Table title="By project" rows={b.byProject.map((s) => [s.label, formatTokens(s.tokens.total), formatPercent(s.share)])} />
          </>
        )}
      </section>

      <section data-testid="achievements">
        <h2>Achievements</h2>
        <ul>
          {snap.achievements.map((a) => (
            <li key={a.id}>
              {a.unlockedAt ? "🏅" : "🔒"} {a.title} ({a.tier}) — {a.description} {a.unlockedAt ? `· ${a.unlockedAt}` : `· ${Math.round((a.progress / a.target) * 100)}%`}
              {a.isNew && " · NEW"}
            </li>
          ))}
        </ul>
      </section>

      <Share />
      <SettingsPanel />

      <section data-testid="sources">
        <h2>Sources</h2>
        <Table title="" rows={snap.sources.map((s) => [s.name, s.found ? "found" : "not found", `${s.files} files`, formatTokens(s.totalTokens), s.lastActivity ?? "—"])} />
        <p>
          <small>
            Prices: {snap.pricing.source} ({snap.pricing.license}), updated {snap.pricing.updatedAt}. Costs are estimates.
            {snap.pricing.unpricedModels.length > 0 && ` Unpriced: ${snap.pricing.unpricedModels.join(", ")}.`}
          </small>
        </p>
        <p>
          <a href={SUPPORT_URL} onClick={(e) => { e.preventDefault(); void api?.openExternal(SUPPORT_URL); }}>
            Support this project
          </a>
        </p>
      </section>
    </>
  );
}

function Share() {
  const api = useApi();
  const [card, setCard] = useState<ShareCardData | null>(null);
  const load = async (format: ShareFormat) => setCard((await api?.getShareCard({ range: { kind: "last30" }, format })) ?? null);
  return (
    <section data-testid="share">
      <h2>Share card data</h2>
      <button onClick={() => void load("square")}>1:1</button> <button onClick={() => void load("story")}>9:16</button>{" "}
      <button
        onClick={async () => {
          const csv = (await api?.exportCsv({ kind: "all" })) ?? "";
          await api?.saveExport("tokenstreak-daily.csv", btoa(csv));
        }}
      >
        Export CSV
      </button>
      {card && <pre style={{ fontSize: 11, maxHeight: 200, overflow: "auto" }}>{JSON.stringify(card, null, 1)}</pre>}
    </section>
  );
}

function SettingsPanel() {
  const settings = useSettings();
  const api = useApi();
  const snap = useSnapshot()!;
  const [goal, setGoal] = useState(snap.goals.daily);
  if (!settings) return null;
  return (
    <section data-testid="settings">
      <h2>Settings</h2>
      <label>
        Daily goal <input type="number" value={goal} onChange={(e) => setGoal(Number(e.target.value))} />
      </label>{" "}
      <button onClick={() => void api?.setGoals({ daily: goal, weekly: goal * 5 })}>Save goal</button>
      <br />
      <label>
        Menu bar{" "}
        <select value={settings.menuBar} onChange={(e) => void updateSettings({ menuBar: e.target.value as typeof settings.menuBar })}>
          <option value="icon">Icon</option>
          <option value="today">Today's tokens</option>
          <option value="streak">Streak</option>
        </select>
      </label>{" "}
      <label>
        Theme{" "}
        <select value={settings.theme} onChange={(e) => void updateSettings({ theme: e.target.value as typeof settings.theme })}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <br />
      {(
        [
          ["Launch at login", settings.launchAtLogin, { launchAtLogin: !settings.launchAtLogin }],
          ["Goal notifications", settings.notifications.goalReached, { notifications: { goalReached: !settings.notifications.goalReached } }],
          ["Achievement notifications", settings.notifications.achievements, { notifications: { achievements: !settings.notifications.achievements } }],
          ["Sound", settings.sound, { sound: !settings.sound }],
          ["Project names on share cards", settings.share.showProjectNames, { share: { showProjectNames: !settings.share.showProjectNames } }],
          ["Cost on share cards", settings.share.showCost, { share: { showCost: !settings.share.showCost } }],
        ] as const
      ).map(([label, on, patch]) => (
        <label key={label} style={{ display: "block" }}>
          <input type="checkbox" checked={on} onChange={() => void updateSettings(patch)} /> {label}
        </label>
      ))}
      {(["claude", "codex", "gemini"] as const).map((t) => (
        <label key={t} style={{ display: "block" }}>
          <input type="checkbox" checked={settings.tools[t].enabled} onChange={() => void updateSettings({ tools: { [t]: { enabled: !settings.tools[t].enabled } } })} /> Track{" "}
          {TOOL_NAMES[t]}
        </label>
      ))}
      <button onClick={() => void api?.refreshPrices()}>Refresh prices</button> <button onClick={() => void api?.refresh()}>Rescan logs</button>
    </section>
  );
}

function Table({ title, rows }: { title: string; rows: (string | number)[][] }) {
  return (
    <table>
      {title && <caption style={{ textAlign: "left" }}>{title}</caption>}
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} style={{ paddingRight: 12 }}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
