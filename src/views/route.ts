// Dashboard routes, and a way for the popover to open the dashboard on a page.
// Both windows share one origin, so the requested page travels via localStorage.

import type { TokenstreakApi } from "../api/client";

export type Route = "overview" | "stats" | "achievements" | "settings";
export const ROUTES: Route[] = ["overview", "stats", "achievements", "settings"];
const KEY = "tokenstreak.route";

export function requestRoute(route: Route): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ route, at: Date.now() }));
  } catch {
    /* storage unavailable */
  }
}

/** A route asked for by the popover in the last few seconds, consumed once. */
export function takeRequestedRoute(): Route | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const { route, at } = JSON.parse(raw) as { route: Route; at: number };
    return Date.now() - at < 10_000 && ROUTES.includes(route) ? route : null;
  } catch {
    return null;
  }
}

export async function openDashboardAt(api: TokenstreakApi, route: Route): Promise<void> {
  requestRoute(route);
  if (api.backend === "mock") {
    const u = new URL(window.location.href);
    u.searchParams.set("view", "dashboard");
    u.searchParams.set("page", route);
    window.location.href = u.toString();
    return;
  }
  if (route === "settings") await api.openSettings();
  else await api.openDashboard();
  await api.hidePopover();
}
