// Settings: goals, rest days, general, notifications, sound, share privacy,
// data sources, price list, privacy statement and About.

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppInfo, AppSnapshot, MenuBarDisplay, Settings, Theme, Tool } from "../../api/types";
import { IconExternal, IconHeart, IconLock, IconPlay, IconRefresh, LogoMark } from "../../components/icons";
import { Card, Chip, Glyph, Seg, Toggle } from "../../components/ui";
import { REPO_URL, SUPPORT_URL } from "../../config";
import { baseline, goalPresets } from "../../lib/derive";
import { formatAgo, formatDayYear, formatInt, formatTokens, friendlyGoal, prettyPath, TOOL_NAMES, TOOLS } from "../../lib/format";
import { getVolume, playCue, setVolume } from "../../lib/sound";
import { updateSettings, useApi, useSettings } from "../../state/store";
import { defaultPath } from "../popover/FirstRun";
import { PageHead } from "./PageHead";

const MIN = 10_000;
const MAX = 200_000_000;
const toSlider = (v: number) => (Math.log10(Math.max(MIN, Math.min(MAX, v))) - Math.log10(MIN)) / (Math.log10(MAX) - Math.log10(MIN));
const fromSlider = (f: number) => friendlyGoal(Math.pow(10, Math.log10(MIN) + f * (Math.log10(MAX) - Math.log10(MIN))));

/** Parses "500k", "2.5M", "1,000,000". */
export function parseTokens(s: string): number | null {
  const m = /^\s*([\d.,]+)\s*([kmb]?)\s*$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const mul = { "": 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]!.toLowerCase() as "" | "k" | "m" | "b"];
  return Math.round(n * mul);
}

export function SettingsPage({ snap }: { snap: AppSnapshot }) {
  const settings = useSettings();
  const api = useApi();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void api?.getAppInfo().then(setInfo);
  }, [api]);
  if (!settings) return null;
  const set = (patch: Parameters<typeof updateSettings>[0]) => void updateSettings(patch);
  return (
    <div className="page" data-testid="page-settings">
      <PageHead eyebrow="Preferences" title="Settings" />
      <div className="set">
        <div className="set__col">
          <GoalsCard snap={snap} settings={settings} />
          <Card title="Sound">
            <SoundRows settings={settings} set={set} />
          </Card>
          <Card title="Share privacy" sub="What share cards may show. Cards are rendered on this Mac; nothing is uploaded.">
            <Row title="Show project names on cards" desc="Off: cards show agents and totals only.">
              <Toggle label="Show project names on cards" on={settings.share.showProjectNames} onChange={(v) => set({ share: { showProjectNames: v } })} />
            </Row>
            <Row title="Show estimated cost on cards" desc="Off by default. Costs are estimates, not bills.">
              <Toggle label="Show estimated cost on cards" on={settings.share.showCost} onChange={(v) => set({ share: { showCost: v } })} />
            </Row>
          </Card>
        </div>
        <div className="set__col">
          <Card title="General">
            <Row title="Launch at login" desc="Start quietly in the menu bar when you log in.">
              <Toggle label="Launch at login" on={settings.launchAtLogin} onChange={(v) => set({ launchAtLogin: v })} />
            </Row>
            <Row title="Menu bar shows" desc="The icon’s head fills as you approach today’s goal.">
              <Seg<MenuBarDisplay>
                label="Menu bar shows"
                value={settings.menuBar}
                onChange={(v) => set({ menuBar: v })}
                options={[
                  { value: "icon", label: "Icon" },
                  { value: "today", label: "Icon + tokens" },
                  { value: "streak", label: "Icon + streak" },
                ]}
              />
            </Row>
            <Row title="Appearance">
              <Seg<Theme>
                label="Appearance"
                value={settings.theme}
                onChange={(v) => set({ theme: v })}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "system", label: "Auto" },
                ]}
              />
            </Row>
            <Row title="Weeks start on">
              <Seg
                label="Weeks start on"
                value={settings.weekStartsOn}
                onChange={(v) => set({ weekStartsOn: v })}
                options={[
                  { value: "monday", label: "Monday" },
                  { value: "sunday", label: "Sunday" },
                ]}
              />
            </Row>
            <h3 className="card__title set__sub">Notifications</h3>
            <Row title="Goal lit" desc="A single, quiet notification when you pass today’s goal.">
              <Toggle label="Goal lit notification" on={settings.notifications.goalReached} onChange={(v) => set({ notifications: { goalReached: v } })} />
            </Row>
            <Row title="Achievements" desc="When a new badge unlocks.">
              <Toggle label="Achievement notifications" on={settings.notifications.achievements} onChange={(v) => set({ notifications: { achievements: v } })} />
            </Row>
            <Row title="Evening nudge" desc="At 8 pm, only if a streak of 3+ days is at risk. Off by default.">
              <Toggle label="Evening nudge" on={settings.notifications.streakAtRisk} onChange={(v) => set({ notifications: { streakAtRisk: v } })} />
            </Row>
          </Card>
          <DataCard snap={snap} settings={settings} info={info} set={set} />
        </div>
      </div>
      <PrivacyCard />
      <AboutCard info={info} />
    </div>
  );
}

function Row({ title, desc, children, block }: { title: React.ReactNode; desc?: React.ReactNode; children?: React.ReactNode; block?: boolean }) {
  return (
    <div className={`srow${block ? " srow--block" : ""}`}>
      <div className="srow__text">
        <div className="srow__t">{title}</div>
        {desc && <div className="srow__d">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

/* ---------------- goals ---------------- */

function GoalsCard({ snap, settings }: { snap: AppSnapshot; settings: Settings }) {
  const api = useApi();
  const [daily, setDaily] = useState(snap.goals.daily || snap.goals.suggestedDaily);
  const [weekly, setWeekly] = useState(snap.goals.weekly || snap.goals.suggestedWeekly);
  const [custom, setCustom] = useState<"daily" | "weekly" | null>(null);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => setDaily(snap.goals.daily || snap.goals.suggestedDaily), [snap.goals.daily, snap.goals.suggestedDaily]);
  useEffect(() => setWeekly(snap.goals.weekly || snap.goals.suggestedWeekly), [snap.goals.weekly, snap.goals.suggestedWeekly]);
  const median = useMemo(() => baseline(snap.days, snap.today.date).medianTokens, [snap]);
  const presets = goalPresets(snap.goals.suggestedDaily || median);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const commit = (d: number, w: number) => {
    if (!api) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await api.setGoals({ daily: d, weekly: w });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    }, 350);
  };
  const setD = (v: number) => {
    setDaily(v);
    commit(v, weekly);
  };
  const setW = (v: number) => {
    setWeekly(v);
    commit(daily, v);
  };
  const ratio = median > 0 ? daily / median : 0;
  const verdict =
    median <= 0
      ? "Pick a number that feels like a good day. You can change it any time."
      : ratio < 0.7
        ? `Your 30-day median is ${formatTokens(median)}, so this goal is gentle: most days will light.`
        : ratio <= 1.25
          ? `Your 30-day median is ${formatTokens(median)}, so this goal is a comfortable stretch.`
          : `Your 30-day median is ${formatTokens(median)}, so this goal is ambitious. Worth it if you mean it.`;
  const restDays = settings.restDays;
  const L = ["M", "T", "W", "T", "F", "S", "S"];

  const submitCustom = () => {
    const n = parseTokens(draft);
    if (n) (custom === "daily" ? setD : setW)(n);
    setCustom(null);
    setDraft("");
  };

  return (
    <Card title="Goals" action={saved ? <span className="saved">Saved · applies from today</span> : undefined}>
      <div className="srow srow--block">
        <div className="goalrow">
          <div className="srow__t">Daily token goal</div>
          <span className="ts-num goalrow__num" data-testid="daily-goal">
            {formatTokens(daily)}
          </span>
        </div>
        <div className="goalslider">
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(toSlider(daily) * 1000)}
            onChange={(e) => setD(fromSlider(Number(e.target.value) / 1000))}
            aria-label="Daily token goal"
            style={{ ["--f" as string]: `${toSlider(daily) * 100}%` }}
          />
          {median > 0 && <em style={{ left: `${toSlider(median) * 100}%` }} title={`Your 30-day median: ${formatTokens(median)}`} />}
        </div>
        <div className="srow__d">{verdict}</div>
        <div className="presets">
          {presets.map((p) => (
            <Chip key={p.key} onClick={() => setD(p.value)} active={daily === p.value} title={p.label}>
              {formatTokens(p.value)}
              {p.key === "steady" && <em>suggested</em>}
            </Chip>
          ))}
          {custom === "daily" ? (
            <CustomInput draft={draft} setDraft={setDraft} onSubmit={submitCustom} onCancel={() => setCustom(null)} label="Custom daily goal" />
          ) : (
            <Chip onClick={() => setCustom("daily")}>Custom…</Chip>
          )}
        </div>
      </div>
      <Row title="Weekly goal" desc="A softer target that forgives a quiet day.">
        <div className="presets presets--right">
          {[daily * 5, daily * 7].map((v) => (
            <Chip key={v} onClick={() => setW(v)} active={weekly === v}>
              {formatTokens(v)}
            </Chip>
          ))}
          {![daily * 5, daily * 7].includes(weekly) && custom !== "weekly" && (
            <Chip active solid>
              {formatTokens(weekly)}
            </Chip>
          )}
          {custom === "weekly" ? (
            <CustomInput draft={draft} setDraft={setDraft} onSubmit={submitCustom} onCancel={() => setCustom(null)} label="Custom weekly goal" />
          ) : (
            <Chip onClick={() => setCustom("weekly")}>Custom…</Chip>
          )}
        </div>
      </Row>
      <Row title="Rest days don’t break the streak" desc="Pick days that are always off. They’re skipped, not counted against you.">
        <Seg
          label="Rest days"
          size="sm"
          value={restDays}
          onChange={(d: number) => void updateSettings({ restDays: restDays.includes(d) ? restDays.filter((x) => x !== d) : [...restDays, d].sort() })}
          options={L.map((l, i) => ({ value: i, label: l, title: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i] }))}
        />
      </Row>
      <Row
        title={
          <>
            Streak freezes <span className="soon">Soon</span>
          </>
        }
        desc="Earn one for every 7-day run and hold up to 2; a missed day spends one. Until then, rest days bridge your streak."
      >
        <Toggle label="Streak freezes" on={false} onChange={() => {}} disabled />
      </Row>
      <div className="srow__d set__foot">Changing a goal never rewrites past days.</div>
    </Card>
  );
}

function CustomInput({ draft, setDraft, onSubmit, onCancel, label }: { draft: string; setDraft: (s: string) => void; onSubmit: () => void; onCancel: () => void; label: string }) {
  return (
    <input
      className="chip chip--input"
      autoFocus
      placeholder="e.g. 750K"
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit();
        if (e.key === "Escape") onCancel();
      }}
      onBlur={() => (draft ? onSubmit() : onCancel())}
    />
  );
}

/* ---------------- sound ---------------- */

function SoundRows({ settings, set }: { settings: Settings; set: (p: Parameters<typeof updateSettings>[0]) => void }) {
  const [vol, setVol] = useState(getVolume());
  return (
    <>
      <Row title="Play sounds" desc="Soft glass chimes for goal lit, milestones and unlocks. Off by default.">
        <Toggle label="Play sounds" on={settings.sound} onChange={(v) => set({ sound: v })} />
      </Row>
      <Row title="Volume">
        <div className="vol">
          <input
            type="range"
            min={5}
            max={100}
            value={Math.round(vol * 100)}
            aria-label="Volume"
            style={{ ["--f" as string]: `${((vol * 100 - 5) / 95) * 100}%` }}
            onChange={(e) => {
              const v = Number(e.target.value) / 100;
              setVol(v);
              setVolume(v);
            }}
          />
          <button type="button" className="btn" onClick={() => playCue("goal", true)}>
            <IconPlay /> Goal
          </button>
          <button type="button" className="btn" onClick={() => playCue("milestone", true)}>
            <IconPlay /> Milestone
          </button>
        </div>
      </Row>
    </>
  );
}

/* ---------------- data ---------------- */

function DataCard({ snap, settings, info, set }: { snap: AppSnapshot; settings: Settings; info: AppInfo | null; set: (p: Parameters<typeof updateSettings>[0]) => void }) {
  const api = useApi();
  const [prices, setPrices] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [err, setErr] = useState<string | null>(null);
  const refreshPrices = async () => {
    if (!api) return;
    setPrices("busy");
    try {
      const r = await api.refreshPrices();
      setPrices(r.ok ? "ok" : "err");
      setErr(r.error);
    } catch (e) {
      setPrices("err");
      setErr(String(e));
    }
  };
  const p = snap.pricing;
  return (
    <Card title="Data" sub={`Updated ${formatAgo(snap.status.lastScanAt)} · ${formatInt(snap.status.files)} log files · ${formatInt(snap.status.events)} usage records`}>
      {TOOLS.map((tool: Tool) => {
        const s = snap.sources.find((x) => x.tool === tool);
        const enabled = settings.tools[tool].enabled;
        const path = s?.paths[0] ? prettyPath(s.paths[0]) : defaultPath(tool);
        const state = !s?.found ? "not found" : !enabled ? "paused" : snap.status.watching ? "watching" : `${formatInt(s.files)} files`;
        return (
          <Row
            key={tool}
            title={
              <span className="srow__tool">
                <Glyph tool={tool} />
                {TOOL_NAMES[tool]}
              </span>
            }
            desc={
              <span className="path">
                {path} · {state}
                {s?.found && s.lastActivity ? ` · last used ${formatDayYear(s.lastActivity.slice(0, 10))}` : ""}
              </span>
            }
          >
            {s?.found ? (
              <Toggle label={`Read ${TOOL_NAMES[tool]} logs`} on={enabled} onChange={(v) => set({ tools: { [tool]: { enabled: v } } })} />
            ) : (
              <span className="srow__muted">Not installed</span>
            )}
          </Row>
        );
      })}
      <Row title="Keep history from deleted logs" desc="Claude Code removes old transcripts after 30 days. Keep their numbers so your trail stays whole.">
        <Toggle label="Keep history from deleted logs" on={settings.keepDeletedHistory} onChange={(v) => set({ keepDeletedHistory: v })} />
      </Row>
      <Row
        title="Price list"
        desc={
          <>
            {p.source} ({p.license}), {formatInt(p.modelCount)} models, updated {formatDayYear(p.updatedAt.slice(0, 10))}. Costs are estimates.
            {p.unpricedModels.length > 0 && <> Unpriced (counted as $0): {p.unpricedModels.slice(0, 3).join(", ")}{p.unpricedModels.length > 3 ? "…" : ""}.</>}
            {prices === "err" && <span className="srow__err"> Couldn’t refresh{err ? `: ${err}` : ""}.</span>}
          </>
        }
      >
        <button type="button" className="btn" onClick={() => void refreshPrices()} disabled={prices === "busy"} data-testid="refresh-prices">
          <IconRefresh size={13} className={prices === "busy" ? "spin" : undefined} />
          {prices === "busy" ? "Refreshing…" : prices === "ok" ? "Up to date" : "Refresh"}
        </button>
      </Row>
      {info && (
        <Row title="App data" desc={<span className="path">{prettyPath(info.dataDir)}</span>}>
          <span className="srow__muted">Settings, state and a numbers-only cache</span>
        </Row>
      )}
    </Card>
  );
}

function PrivacyCard() {
  return (
    <section className="card privacy-card" data-testid="privacy">
      <div className="privacy-card__icon">
        <IconLock size={20} />
      </div>
      <div>
        <h2 className="privacy-card__title">Tokens stay on this Mac</h2>
        <p>
          Tokenstreak reads token counts, model names, timestamps and project folder names from the logs your agents already keep. It never reads, stores or shows your prompts, code or responses. There is no account, no telemetry and no cloud. The only network request is the price-list refresh, and only when you press it.
        </p>
      </div>
    </section>
  );
}

function AboutCard({ info }: { info: AppInfo | null }) {
  const api = useApi();
  const open = (u: string) => api && void api.openExternal(u);
  return (
    <section className="card about" data-testid="about">
      <div className="about__brand">
        <LogoMark size={44} />
        <div>
          <div className="about__name">Tokenstreak</div>
          <div className="ts-label">
            Version {info?.version ?? "…"} · free and open source (MIT)
          </div>
        </div>
      </div>
      <div className="about__credits">
        <p>
          Log parsing and cost rules are ported from <b>ccusage</b> (MIT), so daily totals match it exactly. <b>Tokscale</b> (MIT) inspired the design. Model prices come from <b>LiteLLM</b>’s open price list (MIT). Type is Instrument Serif and Geist (SIL Open Font License).
        </p>
      </div>
      <div className="about__links">
        <button type="button" className="btn" onClick={() => open(REPO_URL)}>
          GitHub <IconExternal />
        </button>
        <button type="button" className="btn btn--support" onClick={() => open(SUPPORT_URL)}>
          <IconHeart /> Support this project
        </button>
      </div>
    </section>
  );
}
