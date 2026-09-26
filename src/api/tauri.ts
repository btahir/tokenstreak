// Tauri IPC implementation of TokenstreakApi. Command names match
// src-tauri/src/commands.rs.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ApiEvents, SettingsPatch, TokenstreakApi, Unsubscribe } from "./client";
import type {
  AppInfo,
  AppSnapshot,
  Breakdown,
  GoalsInput,
  PriceRefreshResult,
  RangeQuery,
  Settings,
  ShareCardData,
  ShareOptions,
} from "./types";

export function createTauriApi(): TokenstreakApi {
  return {
    backend: "tauri",
    getSnapshot: () => invoke<AppSnapshot>("get_snapshot"),
    getBreakdown: (range: RangeQuery) => invoke<Breakdown>("get_breakdown", { range }),
    getSettings: () => invoke<Settings>("get_settings"),
    updateSettings: (patch: SettingsPatch) => invoke<Settings>("update_settings", { patch }),
    setGoals: (goals: GoalsInput) => invoke<AppSnapshot>("set_goals", { goals }),
    completeOnboarding: (goals: GoalsInput) => invoke<AppSnapshot>("complete_onboarding", { goals }),
    refresh: () => invoke<AppSnapshot>("refresh"),
    refreshPrices: () => invoke<PriceRefreshResult>("refresh_prices"),
    getShareCard: (options: ShareOptions) => invoke<ShareCardData>("get_share_card", { options }),
    exportCsv: (range: RangeQuery) => invoke<string>("export_csv", { range }),
    saveExport: (fileName: string, dataBase64: string) => invoke<string>("save_export", { fileName, dataBase64 }),
    acknowledgeCelebration: (date: string) => invoke<void>("acknowledge_celebration", { date }),
    acknowledgeAchievements: (ids: string[]) => invoke<void>("acknowledge_achievements", { ids }),
    getAppInfo: () => invoke<AppInfo>("get_app_info"),
    openDashboard: () => invoke<void>("open_dashboard"),
    hidePopover: () => invoke<void>("hide_popover"),
    setPopoverHeight: (height: number) => invoke<void>("set_popover_height", { height }),
    quit: () => invoke<void>("quit_app"),
    openExternal: (url: string) => invoke<void>("open_external", { url }),
    on<E extends keyof ApiEvents>(event: E, cb: (payload: ApiEvents[E]) => void): Unsubscribe {
      let active = true;
      let unlisten: (() => void) | undefined;
      void listen<ApiEvents[E]>(event, (e) => cb(e.payload)).then((u) => {
        if (active) unlisten = u;
        else u();
      });
      return () => {
        active = false;
        unlisten?.();
      };
    },
  };
}
