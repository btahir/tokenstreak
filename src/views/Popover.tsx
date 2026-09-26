// Unstyled popover scaffold: every datum the menu-bar glance needs.

import { acknowledgeCelebration, useApi, useAppState, useSnapshot } from "../state/store";
import { TOOL_NAMES, formatPercent, formatTokens, formatUsd } from "../lib/format";

export function Popover() {
  const snap = useSnapshot();
  const api = useApi();
  const celebration = useAppState((s) => s.celebration);
  if (!snap) return <p data-testid="loading">Loading…</p>;
  const t = snap.today;
  return (
    <main data-testid="popover" style={{ width: 360, padding: 12 }}>
      {celebration && (
        <section data-testid="celebration" role="status">
          Goal reached! {formatTokens(celebration.tokens)} / {formatTokens(celebration.goal)} · streak {celebration.streak}
          {celebration.newRecord && " · new record"} <button onClick={() => void acknowledgeCelebration()}>Nice</button>
        </section>
      )}
      <section data-testid="today">
        <h1>{formatTokens(t.tokens.total)} tokens today</h1>
        <progress max={1} value={Math.min(1, t.progress)} aria-label="Daily goal progress" />
        <p>
          {formatPercent(t.progress)} of {formatTokens(t.goal)} goal · {t.met ? "met" : `${formatTokens(t.remaining)} to go`} · est. {formatUsd(t.cost)}
        </p>
      </section>
      <section data-testid="streak">
        <p>
          🔥 {snap.streak.current}-day streak {snap.streak.atRisk && "(at risk)"} · best {snap.streak.longest}
        </p>
      </section>
      <section data-testid="tools">
        <ul>
          {t.byTool.filter((s) => s.tokens > 0).map((s) => (
            <li key={s.tool}>
              {TOOL_NAMES[s.tool]}: {formatTokens(s.tokens)} ({formatPercent(s.share)})
            </li>
          ))}
        </ul>
      </section>
      <footer>
        <small>Updated {new Date(snap.generatedAt).toLocaleTimeString()}</small>{" "}
        <button onClick={() => void api?.refresh()}>Refresh</button>{" "}
        <button onClick={() => void api?.openDashboard()}>Dashboard</button>
      </footer>
    </main>
  );
}
