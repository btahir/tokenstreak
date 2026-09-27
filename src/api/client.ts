// The single interface the UI talks to. Implemented by the Tauri IPC backend
// (src/api/tauri.ts) and by the browser mock (src/api/mock/). Keep both in sync
// with src-tauri/src/commands.rs.

import type {
  Achievement,
  AppInfo,
  AppSnapshot,
  Breakdown,
  Celebration,
  GoalsInput,
  PriceRefreshResult,
  RangeQuery,
  ScanProgress,
  Tool,
  Settings,
  ShareCardData,
  ShareOptions,
} from "./types";

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type SettingsPatch = DeepPartial<Settings>;

/** Events pushed by the backend. */
export interface ApiEvents {
  /** A new snapshot (after a scan, goal change, acknowledgement, day rollover). */
  snapshot: AppSnapshot;
  /** Today's goal was just reached (fires once per day). */
  "goal-reached": Celebration;
  /** Achievements unlocked by activity just now. */
  "achievements-unlocked": Achievement[];
  /** The popover window was shown from the menu bar (replay entry motion). */
  "popover-shown": null;
  "popover-hidden": null;
  "dashboard-shown": null;
  /** Full settings after any change (from either window or the tray). */
  settings: Settings;
  /** First-scan progress (partial snapshots stream meanwhile). */
  "scan-progress": ScanProgress;
  /** The dashboard (already open) should show Settings. */
  "open-settings": null;
}

export type Unsubscribe = () => void;

export interface TokenstreakApi {
  readonly backend: "tauri" | "mock";

  /** Everything for the popover and dashboard overview. Instant (cached). */
  getSnapshot(): Promise<AppSnapshot>;
  /** Tool / model / project / session / time-of-day breakdown for a range. */
  getBreakdown(range: RangeQuery): Promise<Breakdown>;
  getSettings(): Promise<Settings>;
  /** Deep-merges a partial settings object; resolves to the full settings. */
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  /** Changes goals from today onward (past days keep their goals). */
  setGoals(goals: GoalsInput): Promise<AppSnapshot>;
  /** Finishes first run; the first goal also applies to the history found. */
  completeOnboarding(goals: GoalsInput): Promise<AppSnapshot>;
  /** Rescans the log folders now. */
  refresh(): Promise<AppSnapshot>;
  /** Downloads a fresh price list (the app's only network call). */
  refreshPrices(): Promise<PriceRefreshResult>;
  /** Privacy-filtered numbers for a share card (no project names unless allowed). */
  getShareCard(options: ShareOptions): Promise<ShareCardData>;
  /** Daily CSV (numbers only). */
  exportCsv(range: RangeQuery): Promise<string>;
  /** Saves a file (PNG / CSV, base64) to ~/Downloads and reveals it. Resolves to the path. */
  saveExport(fileName: string, dataBase64: string): Promise<string>;
  /** Marks today's goal celebration as shown. */
  acknowledgeCelebration(date: string): Promise<void>;
  /** Marks achievements as seen (clears `isNew`). */
  acknowledgeAchievements(ids: string[]): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  openDashboard(): Promise<void>;
  hidePopover(): Promise<void>;
  /** Fits the popover window to its content height (logical px). */
  setPopoverHeight(height: number): Promise<void>;
  quit(): Promise<void>;
  /** Opens an https URL in the default browser. */
  openExternal(url: string): Promise<void>;
  /** Native folder picker for a tool's log folder; resolves to the new settings, or null on cancel. */
  locateTool(tool: Tool): Promise<Settings | null>;
  /** Opens the dashboard on Settings. */
  openSettings(): Promise<void>;
  /** Reveals the app's log file in Finder ("Report a problem"). */
  revealLogs(): Promise<void>;

  on<E extends keyof ApiEvents>(event: E, cb: (payload: ApiEvents[E]) => void): Unsubscribe;
}
