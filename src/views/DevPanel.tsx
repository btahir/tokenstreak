// Mock-only control strip: switch presets, stream tokens, fire the goal moment.
// Hidden with `?devtools=0` (use that for screenshots and recordings).

import { PRESET_IDS } from "../api/mock/presetIds";
import { urlOptions } from "../api";

type MockControls = { addTokens: (n: number) => void; triggerGoalReached: () => void };

function go(params: Record<string, string>) {
  const u = new URL(window.location.href);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  window.location.href = u.toString();
}

export function DevPanel() {
  const o = urlOptions();
  const mock = () => (window as unknown as { __tokenstreakMock?: MockControls }).__tokenstreakMock;
  return (
    <aside data-testid="mock-devpanel" style={{ position: "fixed", bottom: 8, right: 8, fontSize: 12, padding: 8, border: "1px solid #8884", borderRadius: 8, background: "Canvas" }}>
      <strong>Mock</strong>{" "}
      <select value={o.preset} onChange={(e) => go({ preset: e.target.value })} aria-label="Preset">
        {PRESET_IDS.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>{" "}
      <button onClick={() => go({ view: o.view === "popover" ? "dashboard" : "popover" })}>{o.view === "popover" ? "Dashboard" : "Popover"}</button>{" "}
      <button onClick={() => mock()?.addTokens(250_000)}>+250K</button>{" "}
      <button onClick={() => mock()?.triggerGoalReached()}>Hit goal</button>{" "}
      <button onClick={() => go({ theme: o.theme === "dark" ? "light" : "dark" })}>Theme</button>
    </aside>
  );
}
