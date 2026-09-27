// The menu-bar popover: the two-second glance. Sky with the Trail and today's
// number, progress to goal, three quick facts, the week, the agent mix, and a
// footer that says we're watching. Also the goal-hit moment and first run.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AppSnapshot } from "../../api/types";
import { IconGear, IconRefresh, IconWindow, Spark, Wordmark } from "../../components/icons";
import { Chip, Delta, Glyph, Meter, Progress, StreakPill, Tile, useCountUp } from "../../components/ui";
import { IconArrow } from "../../components/icons";
import { buildTrailData, cacheDeltaCopy, celebrationLine, leanCopy, progressCopy, streakMood, todayTiles, trailSummary, weekOrbs } from "../../lib/derive";
import { formatAgo, formatChange, formatInt, formatTokens, formatTowardGoal, formatUsd, percentValue, splitUnit, TOOL_SHORT, TOOLS } from "../../lib/format";
import { playCue } from "../../lib/sound";
import { useReducedMotion, useResolvedTheme } from "../../lib/theme";
import { acknowledgeCelebration, getState, useApi, useAppState, useSnapshot } from "../../state/store";
import { TrailCanvas } from "../../trail/TrailCanvas";
import { useGoalMoment } from "../../trail/celebration";
import { FirstRun } from "./FirstRun";
import { openDashboardAt } from "../route";

export function Popover() {
  const snap = useSnapshot();
  const rootRef = useRef<HTMLDivElement>(null);
  const api = useApi();
  const shown = useAppState((s) => s.popoverShownCount);

  // Size the native window to the content.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !api) return;
    let last = 0;
    const send = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h && Math.abs(h - last) > 1) {
        last = h;
        void api.setPopoverHeight(h);
      }
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    return () => ro.disconnect();
  }, [api, !!snap]);

  // Keyboard: ⌘D dashboard, ⌘R refresh, ⌘, settings, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = getState().api;
      if (!a) return;
      if (e.key === "Escape") void a.hidePopover();
      else if (e.metaKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        void openDashboardAt(a, "overview");
      } else if (e.metaKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        void a.refresh();
      } else if (e.metaKey && e.key === ",") {
        e.preventDefault();
        void openDashboardAt(a, "settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Entry motion each time the popover opens: fade plus a 6 px rise.
  useEffect(() => {
    const el = rootRef.current;
    if (!shown || !el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate(
      [
        { opacity: 0, transform: "translateY(-6px) scale(.985)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  }, [shown]);

  if (!snap) return <div className="pop pop--loading" data-testid="loading" ref={rootRef} aria-busy="true" />;
  return (
    <div className="pop" data-testid="popover" ref={rootRef}>
      {snap.onboarding.completed ? <PopoverMain snap={snap} /> : <FirstRun snap={snap} />}
    </div>
  );
}

function PopoverMain({ snap }: { snap: AppSnapshot }) {
  const theme = useResolvedTheme();
  const reduced = useReducedMotion();
  const api = useApi();
  const visible = useAppState((s) => s.popoverVisible);
  const celebration = useAppState((s) => s.celebration);
  const skyRef = useRef<HTMLDivElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const t = snap.today;
  const data = useMemo(() => buildTrailData(snap, { maxDays: 42 }), [snap]);

  // Goal-hit moment: once per day, when the popover is on screen (see trail/celebration.ts).
  const { celebrateKey, toast } = useGoalMoment({
    celebration,
    visible,
    reduced,
    root: skyRef,
    scope: ".pop",
    toastText: celebrationLine,
    onIgnite: (milestone) => playCue(milestone ? "milestone" : "goal"),
    onDone: () => void acknowledgeCelebration(),
  });

  const tiles = todayTiles(snap);
  const cacheDelta = cacheDeltaCopy(tiles.cacheDeltaPts);
  const lean = leanCopy(tiles.leaner, formatChange);
  const mood = streakMood(snap);
  const copy = progressCopy(t);
  const heroValue = useCountUp(t.tokens.total, 900);
  const [heroNum, heroUnit] = splitUnit(formatTowardGoal(heroValue, t.goal));
  const onDark = theme === "dark";
  const lit = t.met;

  const refresh = useCallback(async () => {
    if (!api || refreshing) return;
    setRefreshing(true);
    try {
      await api.refresh();
    } finally {
      setTimeout(() => setRefreshing(false), 400);
    }
  }, [api, refreshing]);

  const watching = snap.sources.filter((s) => s.found && s.enabled).length;
  const status = snap.status;
  const lastUpdate = status.lastScanAt ?? snap.generatedAt;
  const [, force] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => force((x) => x + 1), 30_000);
    return () => clearInterval(id);
  }, [visible]);

  return (
    <>
      <div className="sky" ref={skyRef}>
        <TrailCanvas
          data={data}
          theme={theme}
          variant="popover"
          celebrateKey={celebrateKey}
          paused={!visible}
          reducedMotion={reduced}
          ariaLabel={trailSummary(snap)}
        />
        <div className="sky__hud">
          <div className={`topbar${toast ? " topbar--hidden" : ""}`} data-trail-avoid>
            <Wordmark size={19} mark={20} />
            <div className="icons">
              <button type="button" className={`ib${refreshing ? " ib--spin" : ""}`} title="Refresh (⌘R)" aria-label="Refresh" onClick={() => void refresh()}>
                <IconRefresh />
              </button>
              <button type="button" className="ib" title="Open dashboard (⌘D)" aria-label="Open dashboard" onClick={() => api && void openDashboardAt(api, "overview")}>
                <IconWindow />
              </button>
              <button type="button" className="ib" title="Settings (⌘,)" aria-label="Settings" onClick={() => api && void openDashboardAt(api, "settings")}>
                <IconGear />
              </button>
            </div>
          </div>
          {toast && (
            <div className="toast toast--pop" role="status" data-testid="goal-toast">
              <i className="toast__orb" />
              {toast}
            </div>
          )}
          <div className="hud-row" data-trail-avoid="children">
            <div>
              <div className="hero-lab">
                {lit ? (
                  <>
                    <Spark size={13} from={onDark ? "#FFF6EA" : "#FFB27A"} to={onDark ? "#FFD6A8" : "#F0728C"} /> Goal lit today
                  </>
                ) : mood === "risk" ? (
                  "Today’s light · keep it going"
                ) : (
                  "Today’s light"
                )}
              </div>
              <div className="hero-num" data-testid="today-tokens">
                <span>
                  {heroNum}
                  {heroUnit}
                </span>
                {t.goal > 0 && <small>of {formatTokens(t.goal)}</small>}
              </div>
            </div>
            {snap.streak.current > 0 ? (
              <StreakPill days={snap.streak.current} tone={mood === "lit" ? "lit" : mood === "risk" ? "risk" : "none"} onDark={onDark} sub={mood === "risk" ? "light it tonight" : undefined}>
                day streak
              </StreakPill>
            ) : (
              <StreakPill days={null} tone="none" onDark={onDark} sub={snap.streak.longest > 0 ? `best run ${formatInt(snap.streak.longest)} ${snap.streak.longest === 1 ? "day" : "days"}` : undefined}>
                {snap.streak.longest > 0 ? "Start a new streak" : "Your trail starts today"}
              </StreakPill>
            )}
          </div>
        </div>
      </div>

      <div className="pbody">
        <Progress value={t.progress} lit={lit} label="Today’s goal" />
        <div className="meta" data-testid="progress-meta">
          <span>
            {copy.lead && <b>{copy.lead}</b>} {copy.rest}
          </span>
          <span className="ts-tabular">{copy.pct}</span>
        </div>

        <div className="ptiles">
          <Tile label="Est. cost" value={formatUsd(tiles.cost)}>
            {tiles.usualCost !== null ? <span className="tile__sub">usual day {formatUsd(tiles.usualCost, { cents: tiles.usualCost < 10 })}</span> : <span className="tile__hint">estimate</span>}
          </Tile>
          <Tile label="From cache" value={percentValue(tiles.cacheShare)} unit="%">
            {cacheDelta ? (
              <Delta lean>
                <IconArrow size={10} dir={tiles.cacheDeltaPts! > 0 ? "up" : "down"} /> {cacheDelta}
              </Delta>
            ) : (
              tiles.cacheDeltaPts !== null && <span className="tile__sub">about usual</span>
            )}
          </Tile>
          <Tile label="Per 1M" value={t.tokens.total > 0 ? formatUsd(tiles.perMillion) : "—"}>
            {lean ? (
              <Delta lean={tiles.leaner! > 0} warm={tiles.leaner! < 0}>
                {lean}
              </Delta>
            ) : (
              tiles.leaner !== null && <span className="tile__sub">about usual</span>
            )}
          </Tile>
        </div>

        <Week snap={snap} />
        <Agents snap={snap} />
      </div>

      <footer className="pfoot">
        <span className="live" data-testid="watching">
          <i className={status.watching || watching ? "" : "off"} />
          {status.initialScan
            ? "Reading your history…"
            : watching
              ? `Watching ${watching} ${watching === 1 ? "folder" : "folders"} · updated ${formatAgo(lastUpdate)}`
              : `No agent logs found · updated ${formatAgo(lastUpdate)}`}
        </span>
        <button type="button" className="btn btn--ghost pfoot__open" onClick={() => api && void openDashboardAt(api, "overview")} data-testid="open-dashboard">
          Open <kbd>⌘D</kbd>
        </button>
      </footer>
    </>
  );
}

function Week({ snap }: { snap: AppSnapshot }) {
  const orbs = weekOrbs(snap);
  const w = snap.goals.thisWeek;
  return (
    <div className="week" data-testid="week">
      <div className="week__orbs">
        {orbs.map((o) => (
          <div className="d" key={o.date} title={o.date}>
            <span className={`orb orb--${o.state}`} style={{ ["--p" as string]: `${Math.min(1, o.progress) * 100}%` }} />
            {o.label}
          </div>
        ))}
      </div>
      <div className="week__sum">
        <b>{formatTowardGoal(w.tokens, w.goal)}</b>
        {w.goal > 0 ? `of ${formatTokens(w.goal)} this week` : "this week"}
      </div>
    </div>
  );
}

function Agents({ snap }: { snap: AppSnapshot }) {
  const t = snap.today;
  const by = TOOLS.map((tool) => t.byTool.find((b) => b.tool === tool) ?? { tool, tokens: 0, share: 0, cost: 0 });
  const used = by.filter((b) => b.tokens > 0);
  return (
    <div className="agents" data-testid="agents">
      <div className="agents__head">
        <span>By agent today</span>
        <span className="ts-tabular">{formatTokens(t.tokens.total)}</span>
      </div>
      {used.length ? (
        <>
          <Meter parts={used.map((b) => ({ key: b.tool, value: b.tokens }))} />
          <div className="agents__chips">
            {used.map((b) => (
              <Chip key={b.tool}>
                <Glyph tool={b.tool} />
                {TOOL_SHORT[b.tool]} <em>{formatTokens(b.tokens)}</em>
              </Chip>
            ))}
          </div>
        </>
      ) : (
        <p className="agents__empty">
          Quiet so far. Start a session in Claude Code, Codex or Gemini and watch the comet fill.
        </p>
      )}
    </div>
  );
}
