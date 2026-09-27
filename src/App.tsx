// Routes to the popover or the dashboard (`?view=`), applies the theme and,
// in the browser mock, shows the preset switcher.

import { useEffect } from "react";
import { isTauri, urlOptions } from "./api";
import { useAppState, useSettings } from "./state/store";
import { Dashboard } from "./views/dashboard/Dashboard";
import { DevPanel } from "./views/DevPanel";
import { Popover } from "./views/popover/Popover";

export function App() {
  const opts = urlOptions();
  const settings = useSettings();
  const error = useAppState((s) => s.error);
  const theme = opts.theme ?? (settings?.theme && settings.theme !== "system" ? settings.theme : undefined);

  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.dataset.theme = theme;
    else delete root.dataset.theme;
    root.dataset.view = opts.view;
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
      {opts.view === "dashboard" ? <Dashboard /> : <Popover />}
      {import.meta.env.VITE_INCLUDE_MOCK && !isTauri() && opts.devtools && <DevPanel />}
    </>
  );
}
