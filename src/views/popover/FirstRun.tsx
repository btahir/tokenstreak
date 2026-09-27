// Popover before onboarding: a Day-0 sky, what we found on this Mac, and the
// button that opens the dashboard for the "here's your history" reveal.

import { useMemo } from "react";
import type { AppSnapshot } from "../../api/types";
import { IconCheck, IconGear, IconLock, IconRefresh, IconWindow, Wordmark } from "../../components/icons";
import { Glyph } from "../../components/ui";
import { prettyPath, TOOL_NAMES, TOOLS, plural } from "../../lib/format";
import { useReducedMotion, useResolvedTheme } from "../../lib/theme";
import { useApi, useAppState } from "../../state/store";
import { TrailCanvas } from "../../trail/TrailCanvas";
import type { TrailData } from "../../trail/types";
import { openDashboardAt } from "../route";

export const DAY0: TrailData = { goal: 1, today: { tokens: 0, tools: { claude: 1 }, cacheShare: 0 }, streak: { current: 0, best: 0 }, history: [] };

const SOLO = { soloX: 0.77, baseY: 0.6 };

export function toolDays(snap: AppSnapshot) {
  return TOOLS.map((tool) => {
    const src = snap.sources.find((s) => s.tool === tool);
    const days = snap.days.filter((d) => d[tool] > 0).length;
    return { tool, found: !!src?.found, used: days > 0 || (src?.files ?? 0) > 0, path: src?.paths[0] ? prettyPath(src.paths[0]) : defaultPath(tool), days };
  });
}

export function defaultPath(tool: string): string {
  return tool === "claude" ? "~/.claude/projects" : tool === "codex" ? "~/.codex/sessions" : "~/.gemini/tmp";
}

export function FirstRun({ snap }: { snap: AppSnapshot }) {
  const theme = useResolvedTheme();
  const reduced = useReducedMotion();
  const api = useApi();
  const visible = useAppState((s) => s.popoverVisible);
  const tools = useMemo(() => toolDays(snap), [snap]);
  const open = () => api && void openDashboardAt(api, "overview");
  return (
    <>
      <div className="sky">
        <TrailCanvas data={DAY0} theme={theme} variant="popover" layout={SOLO} paused={!visible} reducedMotion={reduced} ariaLabel="An empty dusk sky with a single spark waiting" />
        <div className="sky__hud">
          <div className="topbar">
            <Wordmark size={19} mark={20} />
            <div className="icons">
              <button type="button" className="ib" aria-label="Refresh" title="Refresh" onClick={() => api && void api.refresh()}>
                <IconRefresh />
              </button>
              <button type="button" className="ib" aria-label="Open dashboard" title="Open dashboard" onClick={open}>
                <IconWindow />
              </button>
              <button type="button" className="ib" aria-label="Settings" title="Settings" onClick={() => api && void openDashboardAt(api, "settings")}>
                <IconGear />
              </button>
            </div>
          </div>
          <div>
            <div className="hero-lab">Welcome</div>
            <div className="hero-num hero-num--words">
              Your trail
              <br />
              starts here
            </div>
          </div>
        </div>
      </div>
      <div className="first" data-testid="first-run">
        <p>Tokenstreak reads the usage numbers your coding agents already log on this Mac and turns them into a daily streak of light.</p>
        <div className="detect">
          {tools.map((t) => (
            <div className={`det${t.found && t.used ? "" : " det--no"}`} key={t.tool}>
              <span className="det__ok">{t.found && t.used && <IconCheck size={10} />}</span>
              <Glyph tool={t.tool} />
              <span className="det__name">{TOOL_NAMES[t.tool]}</span>
              <span className="det__meta">
                {!t.found ? (
                  "Not installed"
                ) : t.days ? (
                  <>
                    <span className="det__path">{t.path}</span> · {plural(t.days, "day")}
                  </>
                ) : (
                  "Found, no usage yet"
                )}
              </span>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn--glow btn--lg first__cta" onClick={open} data-testid="reveal-history">
          Reveal my history
        </button>
        <div className="privacy">
          <IconLock />
          Only token counts, model names, times and project folder names are read. Never your prompts or code. Nothing leaves this Mac.
        </div>
      </div>
      <footer className="pfoot">
        <span>No account needed</span>
        <span>Takes ~3 seconds</span>
      </footer>
    </>
  );
}
