// First run, three steps: find the agents on this Mac, reveal the history as a
// Trail drawing itself in, then pick a daily goal with a smart suggestion.

import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "../../api";
import type { AppSnapshot } from "../../api/types";
import { IconCheck, IconLock } from "../../components/icons";
import { Glyph, Progress, Toggle } from "../../components/ui";
import { baseline, buildTrailData, goalDirection, goalPresets, revealFacts, simulateGoal, weeklyFor } from "../../lib/derive";
import { addDays, daysBetween, formatDate, formatPercent, formatTokens, plural, splitUnit, TOOL_NAMES } from "../../lib/format";
import { setSoundEnabled } from "../../lib/sound";
import { useReducedMotion, useResolvedTheme } from "../../lib/theme";
import { setState, updateSettings, useApi, useAppState, useSettings } from "../../state/store";
import { TrailCanvas } from "../../trail/TrailCanvas";
import { DAY0, toolDays } from "../popover/FirstRun";

type Step = 1 | 2 | 3;
const REVEAL_LAYOUT = { baseY: 0.6, headX: 0.9, maxDays: 200, top: 0.36, bottom: 0.78, headR: 9, wMax: 13 };

export function Onboarding({ snap, onDone }: { snap: AppSnapshot; onDone: () => void }) {
  const q = Number(new URLSearchParams(location.search).get("step"));
  const [step, setStep] = useState<Step>(q === 2 || q === 3 ? q : 1);
  const presets = useMemo(() => goalPresets(snap.goals.suggestedDaily || baseline(snap.days, snap.today.date).medianTokens), [snap]);
  const [goal, setGoal] = useState(presets[1]!.value);
  return (
    <div className="onb" data-testid="onboarding" data-step={step}>
      <div className="onb__drag" data-tauri-drag-region>
        {!isTauri() && (
          <div className="lights" aria-hidden>
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
      <div className="onb__steps" role="progressbar" aria-valuemin={1} aria-valuemax={3} aria-valuenow={step} aria-label={`Setup, step ${step} of 3`}>
        {[1, 2, 3].map((i) => (
          <i key={i} className={i <= step ? "on" : ""} />
        ))}
      </div>
      {step === 1 && <Detect snap={snap} next={() => setStep(2)} />}
      {step === 2 && <Reveal snap={snap} goal={goal} next={() => setStep(3)} />}
      {step === 3 && <Goal snap={snap} goal={goal} setGoal={setGoal} presets={presets} back={() => setStep(2)} done={onDone} />}
    </div>
  );
}

/* ---------------- step 1: detect ---------------- */

function Detect({ snap, next }: { snap: AppSnapshot; next: () => void }) {
  const theme = useResolvedTheme();
  const reduced = useReducedMotion();
  const tools = useMemo(() => toolDays(snap), [snap]);
  const [resolved, setResolved] = useState(reduced ? 3 : 0);
  useEffect(() => {
    if (reduced) return;
    const ts = [0, 1, 2].map((i) => setTimeout(() => setResolved(i + 1), 450 + i * 380));
    return () => ts.forEach(clearTimeout);
  }, [reduced]);
  const activeDays = snap.days.filter((d) => d.total > 0).length;
  const anyFound = tools.some((t) => t.found && t.used);
  const sp = useAppState((s) => s.scanProgress);
  const scanning = snap.status.initialScan;
  const pct = sp && sp.bytesTotal > 0 ? sp.bytesDone / sp.bytesTotal : sp && sp.filesTotal > 0 ? sp.filesDone / sp.filesTotal : 0;
  return (
    <div className="onb__pane">
      <div className="onb__left">
        <div className="eyebrow">Step 1 of 3</div>
        <h1 className="onb__h1">
          Let’s find
          <br />
          your agents
        </h1>
        <p className="onb__p">Tokenstreak looks for the usage logs your coding agents already keep on this Mac.</p>
        <div className="onb__rows" data-testid="detect-rows">
          {tools.map((t, i) => {
            const done = resolved > i;
            const ok = t.found && t.used;
            return (
              <div className={`orow${done && !ok ? " orow--missing" : ""}`} key={t.tool}>
                <Glyph tool={t.tool} lg />
                <div>
                  <div className="orow__t">{TOOL_NAMES[t.tool]}</div>
                  <div className="orow__p">{t.path}</div>
                </div>
                <span className="orow__st">
                  {!done ? (
                    <span className="scan" aria-label="Looking" />
                  ) : ok ? (
                    <span className="orow__ok">
                      <IconCheck /> {plural(t.days, "day")}
                    </span>
                  ) : t.found ? (
                    <span className="orow__none">Found · no usage yet</span>
                  ) : (
                    <span className="orow__none">Not found</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        {scanning && (
          <div className="onb__scan" data-testid="scan-progress">
            <Progress value={pct} label="Reading your history" />
            <span className="ts-label">
              Reading your history{sp ? ` · ${sp.filesDone.toLocaleString("en-US")} of ${sp.filesTotal.toLocaleString("en-US")} files` : "…"}
            </span>
          </div>
        )}
        <div className="privacy onb__privacy">
          <IconLock />
          <span>Only token counts, model names, timestamps and project folder names are read. Never prompts, code or responses. Nothing leaves this Mac.</span>
        </div>
        <div className="onb__foot">
          <span className="ts-label">{resolved >= 3 ? (anyFound ? `Found ${plural(activeDays, "day")} of history` : "No usage yet. Your trail starts today.") : "Looking…"}</span>
          <button type="button" className="btn btn--glow btn--lg" onClick={next} disabled={resolved < 3 || scanning} data-testid="onb-next">
            {anyFound ? "Show me my history" : "Continue"}
          </button>
        </div>
      </div>
      <div className="onb__art">
        <TrailCanvas data={DAY0} theme={theme} variant="popover" layout={{ soloX: 0.5, baseY: 0.62 }} reducedMotion={reduced} ariaLabel="A dusk sky with a single spark waiting" />
      </div>
    </div>
  );
}

/* ---------------- step 2: reveal ---------------- */

function Reveal({ snap, goal, next }: { snap: AppSnapshot; goal: number; next: () => void }) {
  const theme = useResolvedTheme();
  const reduced = useReducedMotion();
  const data = useMemo(() => {
    const d = buildTrailData({ ...snap, today: { ...snap.today, goal } }, { maxDays: 400, goalFallback: goal });
    // Rows carry no goal before onboarding; judge history by the suggested goal.
    d.history = d.history.map((h) => ({ ...h, goalMet: h.tokens >= goal, goal }));
    const sim = simulateGoal(snap.days, snap.today.date, goal, snap.streak.restDays, snap.streak.freezesEnabled);
    d.streak = { current: sim.current, best: sim.best };
    return d;
  }, [snap, goal]);
  const facts = revealFacts(snap, goal);
  // The count follows the light: it reports the share of tokens drawn so far.
  const [drawn, setDrawn] = useState(reduced ? 1 : 0);
  const landed = drawn >= 1;
  const count = facts.total * drawn;
  const [num, unit] = splitUnit(formatTokens(count));
  const [revealKey, setRevealKey] = useState(0);
  const ready = useRef(false);
  useEffect(() => {
    if (!ready.current) {
      ready.current = true;
      setRevealKey(1);
    }
  }, []);
  return (
    <div className="onb__full" data-testid="reveal">
      <TrailCanvas data={data} theme={theme} variant="full" layout={REVEAL_LAYOUT} revealKey={revealKey} reducedMotion={reduced} onRevealProgress={setDrawn} ariaLabel={`Your history: ${formatTokens(facts.total)} tokens since ${facts.since ?? "today"}`} />
      <div className="onb__over" data-trail-avoid="children">
        <div className="eyebrow onb__eye">Here’s your history</div>
        <h1 className="onb__since">{facts.since ? `Since ${formatDate(facts.since)} your agents have written` : "Today your agents have written"}</h1>
        <div className="onb__big" data-testid="reveal-total">
          {num}
          {unit}
          <small>tokens</small>
        </div>
        {/* the facts stagger in once the head has landed */}
        <div className="facts-row" style={{ minHeight: 62 }} data-testid="reveal-facts">
          {landed && (
            <>
              <Fact d={0.08} label="Days you showed up" value={String(facts.daysShowedUp)} />
              <Fact d={0.2} label="Longest run" value={plural(facts.longestRun, "day")} />
              <Fact d={0.32} label="Busiest day" value={facts.busiest ? `${formatTokens(facts.busiest.total)} · ${formatDate(facts.busiest.date)}` : "—"} />
              <Fact d={0.44} label="From cache" value={formatPercent(facts.cacheShare)} />
            </>
          )}
        </div>
        <div className="onb__cta">
          <span>Each stretch of light is a run of good days. Gaps are days off.</span>
          <button type="button" className="btn btn--glow btn--lg" onClick={next} data-testid="onb-next">
            Set my goal
          </button>
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value, d }: { label: string; value: string; d: number }) {
  return (
    <div className="ofact" style={{ animationDelay: `${d}s` }}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

/* ---------------- step 3: goal ---------------- */

function Goal({ snap, goal, setGoal, presets, back, done }: { snap: AppSnapshot; goal: number; setGoal: (n: number) => void; presets: ReturnType<typeof goalPresets>; back: () => void; done: () => void }) {
  const api = useApi();
  const settings = useSettings();
  const [launch, setLaunch] = useState(true);
  const [notify, setNotify] = useState(settings?.notifications.goalReached ?? true);
  const [sound, setSound] = useState(false);
  const [busy, setBusy] = useState(false);
  const sim = useMemo(() => simulateGoal(snap.days, snap.today.date, goal, snap.streak.restDays, snap.streak.freezesEnabled), [snap, goal]);
  const median = baseline(snap.days, snap.today.date).medianTokens;
  // size the preview to the history (at least 8 weeks, at most 20)
  const firstDay = snap.days.find((d) => d.total > 0)?.date ?? snap.today.date;
  const weeks = Math.max(8, Math.min(20, Math.ceil((daysBetween(firstDay, snap.today.date) + 1) / 7)));
  const suggested = presets[1]!.value;
  const dir = goalDirection(suggested, median);
  const cells = useMemo(() => {
    const start = addDays(snap.today.date, -(weeks * 7 - 1));
    const byDate = new Map(snap.days.map((d) => [d.date, d.total]));
    return Array.from({ length: weeks * 7 }, (_, i) => {
      const date = addDays(start, i);
      const t = byDate.get(date) ?? 0;
      return { date, cls: t >= goal ? "l" : t > 0 ? "p" : "" };
    });
  }, [snap, goal]);
  const start = async () => {
    if (!api) return;
    setBusy(true);
    try {
      await updateSettings({ launchAtLogin: launch, notifications: { goalReached: notify }, sound });
      setSoundEnabled(sound);
      const next = await api.completeOnboarding({ daily: goal, weekly: weeklyFor(goal) });
      setState({ snapshot: next });
      done();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="onb__pane">
      <div className="onb__left">
        <div className="eyebrow">Step 3 of 3</div>
        <h1 className="onb__h1">
          Pick a daily goal
          <br />
          that feels good
        </h1>
        <p className="onb__p">
          {median > 0 ? (
            <>
              Your typical day is <b>{formatTokens(median)} tokens</b>.{" "}
              {dir === "below"
                ? `The suggested ${formatTokens(suggested)} sits a touch below it, so most days light and the streak stays honest.`
                : dir === "above"
                  ? `The suggested ${formatTokens(suggested)} sits a little above it: a stretch, without burning tokens for the sake of it.`
                  : `The suggested ${formatTokens(suggested)} is right about there, so a normal day lights the trail.`}
            </>
          ) : (
            <>Pick a number that feels like a good day. You can change it any time.</>
          )}
        </p>
        <div className="presets3" role="radiogroup" aria-label="Daily goal">
          {presets.map((p) => (
            <button type="button" role="radio" aria-checked={goal === p.value} key={p.key} className={`pre${goal === p.value ? " on" : ""}`} onClick={() => setGoal(p.value)} data-testid={`preset-${p.key}`}>
              <em>
                {p.label}
                {p.key === "steady" ? " · suggested" : ""}
              </em>
              <b>{formatTokens(p.value)}</b>
            </button>
          ))}
        </div>
        <div className="onb__opts">
          <label className="oopt">
            Launch at login
            <Toggle label="Launch at login" on={launch} onChange={setLaunch} />
          </label>
          <label className="oopt">
            Tell me when my goal is lit
            <Toggle label="Goal notification" on={notify} onChange={setNotify} />
          </label>
          <label className="oopt">
            Sounds
            <Toggle label="Sounds" on={sound} onChange={setSound} />
          </label>
        </div>
        <div className="onb__foot">
          <button type="button" className="btn btn--ghost" onClick={back}>
            Back
          </button>
          <button type="button" className="btn btn--glow btn--lg" onClick={() => void start()} disabled={busy} data-testid="onb-start">
            Start my streak
          </button>
        </div>
      </div>
      <div className="onb__right">
        <div className="preview" data-testid="goal-preview">
          <div className="ts-label">
            With a {formatTokens(goal)} goal, your last {weeks} weeks look like this
          </div>
          <div className="miniheat">
            {cells.map((c) => (
              <i key={c.date} className={c.cls} title={formatDate(c.date)} />
            ))}
          </div>
          <div className="preview__facts">
            <div>
              <div className="ts-label">Days lit</div>
              <div className="ts-num">{sim.lit}</div>
            </div>
            <div>
              <div className="ts-label">Current streak</div>
              <div className="ts-num">{sim.current}</div>
            </div>
            <div>
              <div className="ts-label">Best run</div>
              <div className="ts-num">{sim.best}</div>
            </div>
          </div>
        </div>
        <p className="onb__small">You can change this any time. Changing a goal never rewrites past days.</p>
      </div>
    </div>
  );
}
