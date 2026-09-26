// Routes to the popover or the dashboard (`?view=`), applies the theme and,
// in the browser mock, shows the preset switcher.
//
// NOTE FOR THE FRONTEND BUILDER: the views in ./views are deliberately
// unstyled scaffolds that exercise every field of the API. Replace them.

import { useEffect } from "react";
import { isTauri, urlOptions } from "./api";
import { useAppState, useSettings } from "./state/store";
import { Dashboard } from "./views/Dashboard";
import { DevPanel } from "./views/DevPanel";
import { Popover } from "./views/Popover";

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
  }, [theme, opts.view]);

  return (
    <>
      {error && <p role="alert">Could not connect to the backend: {error}</p>}
      {opts.view === "dashboard" ? <Dashboard /> : <Popover />}
      {import.meta.env.VITE_INCLUDE_MOCK && !isTauri() && opts.devtools && <DevPanel />}
    </>
  );
}
