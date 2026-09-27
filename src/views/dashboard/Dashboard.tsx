// Dashboard window: sidebar + four pages (Your trail, Stats, Achievements,
// Settings), the share dialog, and first-run onboarding.

import { useEffect, useState } from "react";
import { isTauri } from "../../api";
import { IconBars, IconGear, IconHeart, IconMedal, IconTrail, Wordmark } from "../../components/icons";
import { Progress } from "../../components/ui";
import { SUPPORT_URL } from "../../config";
import { formatTokens } from "../../lib/format";
import { useApi, useSnapshot } from "../../state/store";
import { ROUTES, takeRequestedRoute, type Route } from "../route";
import { Achievements } from "./Achievements";
import { Onboarding } from "./Onboarding";
import { Overview } from "./Overview";
import { SettingsPage } from "./Settings";
import { ShareDialog } from "./ShareDialog";
import { Stats } from "./Stats";
import { UnlockToasts } from "./UnlockToasts";

const NAV: { route: Route; label: string; icon: React.ReactNode }[] = [
  { route: "overview", label: "Your trail", icon: <IconTrail /> },
  { route: "stats", label: "Stats", icon: <IconBars /> },
  { route: "achievements", label: "Achievements", icon: <IconMedal /> },
  { route: "settings", label: "Settings", icon: <IconGear /> },
];

function initialRoute(): Route {
  const q = new URLSearchParams(location.search).get("page") as Route | null;
  if (q && ROUTES.includes(q)) return q;
  return takeRequestedRoute() ?? "overview";
}

export function Dashboard() {
  const snap = useSnapshot();
  const api = useApi();
  const [route, setRoute] = useState<Route>(initialRoute);
  const [share, setShare] = useState(() => new URLSearchParams(location.search).get("share") === "1");
  const [onboardingDone, setOnboardingDone] = useState(false);

  // The popover can ask for a page (e.g. Settings) before showing this window.
  useEffect(() => {
    if (!api) return;
    const take = () => {
      const r = takeRequestedRoute();
      if (r) setRoute(r);
    };
    const off = api.on("dashboard-shown", take);
    const onStorage = (e: StorageEvent) => e.key === "tokenstreak.route" && e.newValue && take();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", take);
    return () => {
      off();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", take);
    };
  }, [api]);

  useEffect(() => {
    document.querySelector(".main")?.scrollTo({ top: 0 });
  }, [route]);

  if (!snap) return <div className="win win--loading" data-testid="loading" />;

  if (!snap.onboarding.completed && !onboardingDone) {
    return <Onboarding snap={snap} onDone={() => setOnboardingDone(true)} />;
  }

  const w = snap.goals.thisWeek;
  const litThisWeek = snap.days.filter((d) => d.date >= w.start && d.date <= w.end && d.met).length;

  return (
    <div className="win" data-testid="dashboard">
      <aside className="side">
        <div className="side__drag" data-tauri-drag-region>
          {!isTauri() && (
            <div className="lights" aria-hidden>
              <i />
              <i />
              <i />
            </div>
          )}
        </div>
        <div className="side__brand">
          <Wordmark size={22} mark={24} />
        </div>
        <nav className="side__nav" aria-label="Sections">
          {NAV.map((n) => (
            <button key={n.route} type="button" className={`nav${route === n.route ? " on" : ""}`} aria-current={route === n.route ? "page" : undefined} onClick={() => setRoute(n.route)} data-testid={`nav-${n.route}`}>
              {n.icon}
              {n.label}
              {n.route === "achievements" && snap.achievements.some((a) => a.isNew) && <span className="nav__dot" aria-label="New" />}
            </button>
          ))}
        </nav>
        <div className="side__grow" />
        <div className="goalbox">
          <div className="eyebrow">This week</div>
          <div className="goalbox__num">
            <span className="ts-num">{formatTokens(w.tokens)}</span>
            {w.goal > 0 && <span className="ts-label">of {formatTokens(w.goal)}</span>}
          </div>
          <Progress value={w.progress} lit={w.met} label="This week’s goal" />
          <div className="ts-label goalbox__sub">
            {w.met ? "Weekly goal lit" : `${litThisWeek} goal ${litThisWeek === 1 ? "day" : "days"} · ${w.daysLeft} ${w.daysLeft === 1 ? "day" : "days"} left`}
            {snap.streak.weeklyCurrent > 1 ? ` · ${snap.streak.weeklyCurrent}-week run` : ""}
          </div>
        </div>
        <button type="button" className="support" onClick={() => api && void api.openExternal(SUPPORT_URL)}>
          <IconHeart /> Support this project
        </button>
      </aside>
      <main className="main" data-page={route}>
        <div className="main__drag" data-tauri-drag-region />
        {route === "overview" && <Overview snap={snap} onShare={() => setShare(true)} go={setRoute} />}
        {route === "stats" && <Stats snap={snap} />}
        {route === "achievements" && <Achievements snap={snap} />}
        {route === "settings" && <SettingsPage snap={snap} />}
      </main>
      {share && <ShareDialog snap={snap} onClose={() => setShare(false)} />}
      <UnlockToasts />
    </div>
  );
}
