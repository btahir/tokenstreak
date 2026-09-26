// Picks the backend: Tauri IPC inside the app, the mock in a plain browser
// (`pnpm dev:web`, or any page opened without Tauri).

import type { TokenstreakApi } from "./client";

export type { TokenstreakApi, ApiEvents, SettingsPatch, Unsubscribe } from "./client";
export * from "./types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface UrlOptions {
  view: "popover" | "dashboard";
  preset: string;
  live: boolean | undefined;
  speed: number;
  /** Theme override for screenshots: light | dark. */
  theme: "light" | "dark" | undefined;
  /** Hide the mock dev panel (for clean screenshots). */
  devtools: boolean;
}

export function urlOptions(search = window.location.search): UrlOptions {
  const q = new URLSearchParams(search);
  const theme = q.get("theme");
  const live = q.get("live");
  return {
    view: q.get("view") === "dashboard" ? "dashboard" : "popover",
    preset: q.get("preset") ?? "streak-30",
    live: live === null ? undefined : live === "1" || live === "true",
    speed: Number(q.get("speed") ?? "1") || 1,
    theme: theme === "light" || theme === "dark" ? theme : undefined,
    devtools: q.get("devtools") !== "0",
  };
}

let instance: Promise<TokenstreakApi> | undefined;

/** The API singleton. */
export function getApi(): Promise<TokenstreakApi> {
  if (!instance) {
    const forceMock = import.meta.env.VITE_BACKEND === "mock";
    if (!import.meta.env.VITE_INCLUDE_MOCK || (!forceMock && isTauri())) {
      instance = import("./tauri").then((m) => m.createTauriApi());
    } else {
      const o = urlOptions();
      instance = import("./mock").then((m) => m.createMockApi({ preset: o.preset, live: o.live, speed: o.speed }));
    }
  }
  return instance;
}
