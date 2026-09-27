// Resolved theme (light/dark) and reduced-motion, as React hooks.

import { useEffect, useState, useSyncExternalStore } from "react";

export type Resolved = "light" | "dark";

function readTheme(): Resolved {
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") return attr;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const listeners = new Set<() => void>();
let observerStarted = false;
function startObserver() {
  if (observerStarted) return;
  observerStarted = true;
  const notify = () => listeners.forEach((l) => l());
  new MutationObserver(notify).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", notify);
}

/** The theme actually on screen: the explicit data-theme, else the system appearance. */
export function useResolvedTheme(): Resolved {
  startObserver();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    readTheme,
    () => "light",
  );
}

export function useReducedMotion(): boolean {
  const q = "(prefers-reduced-motion: reduce)";
  const [r, setR] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setR(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return r;
}
