// Routes to the popover or the dashboard (`?view=`), applies the theme and,
// in the browser mock, shows the preset switcher.

import { lazy, Suspense, useEffect } from "react";
import { isTauri, urlOptions } from "./api";
import { useAppState, useSettings } from "./state/store";
import { DevPanel } from "./views/DevPanel";
import { Popover } from "./views/popover/Popover";

// The popover window loads only what it needs; the dashboard is its own chunk.
const Dashboard = lazy(() => import("./views/dashboard/Dashboard").then((m) => ({ default: m.Dashboard })));
const Lab = import.meta.env.VITE_INCLUDE_MOCK ? lazy(() => import("./views/Lab").then((m) => ({ default: m.Lab }))) : null;

export function App() {
  const opts = urlOptions();
  const settings = useSettings();
  const error = useAppState((s) => s.error);
  const theme = opts.theme ?? (settings?.theme && settings.theme !== "system" ? settings.theme : undefined);

  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.dataset.theme = theme;
    else delete root.dataset.theme;
    root.dataset.view = new URLSearchParams(location.search).get("view") === "lab" ? "lab" : opts.view;
    const wall = new URLSearchParams(location.search).get("wall");
    if (wall && !isTauri()) root.dataset.wall = wall;
  }, [theme, opts.view]);

  return (
    <>
      {error && (
        <p role="alert" className="fatal">
          Tokenstreak couldn’t reach its engine: {error}
        </p>
      )}
      {Lab && new URLSearchParams(location.search).get("view") === "lab" ? (
        <Suspense fallback={null}>
          <Lab />
        </Suspense>
      ) : opts.view === "dashboard" ? (
        <Suspense fallback={<div className="win win--loading" />}>
          <Dashboard />
        </Suspense>
      ) : (
        <Popover />
      )}
      {import.meta.env.VITE_INCLUDE_MOCK && !isTauri() && opts.devtools && <DevPanel />}
    </>
  );
}
