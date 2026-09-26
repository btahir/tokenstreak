// Frontend state: one tiny external store fed by the API (snapshot pushes,
// settings, pending moments). Views subscribe with the hooks below.
//
// Flow: getApi() → initial getSnapshot()/getSettings() → `snapshot` events
// replace the snapshot → views re-render; breakdowns are fetched per range and
// refetched whenever a new snapshot arrives.

import { useEffect, useState, useSyncExternalStore } from "react";
import { getApi } from "../api";
import type { Achievement, AppSnapshot, Breakdown, Celebration, RangeQuery, Settings, TokenstreakApi } from "../api";

export interface AppState {
  api: TokenstreakApi | null;
  snapshot: AppSnapshot | null;
  settings: Settings | null;
  /** A goal-reached moment to celebrate (from the event or a pending snapshot celebration). */
  celebration: Celebration | null;
  /** Achievements unlocked live, waiting to be shown. */
  unlocked: Achievement[];
  /** Increments each time the popover is shown (replay entry motion). */
  popoverShownCount: number;
  error: string | null;
}

let state: AppState = {
  api: null,
  snapshot: null,
  settings: null,
  celebration: null,
  unlocked: [],
  popoverShownCount: 0,
  error: null,
};
const subs = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  subs.forEach((s) => s());
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

let started = false;

/** Connects to the backend once. */
export function startStore(): void {
  if (started) return;
  started = true;
  getApi()
    .then(async (api) => {
      setState({ api });
      api.on("snapshot", (snapshot) => {
        setState({ snapshot, celebration: getState().celebration ?? snapshot.celebration });
      });
      api.on("goal-reached", (celebration) => setState({ celebration }));
      api.on("achievements-unlocked", (list) => setState({ unlocked: [...getState().unlocked, ...list] }));
      api.on("popover-shown", () => setState({ popoverShownCount: getState().popoverShownCount + 1 }));
      const [snapshot, settings] = await Promise.all([api.getSnapshot(), api.getSettings()]);
      setState({ snapshot, settings, celebration: snapshot.celebration });
    })
    .catch((e: unknown) => setState({ error: String(e) }));
}

export function useAppState<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state), () => select(state));
}

export const useSnapshot = () => useAppState((s) => s.snapshot);
export const useSettings = () => useAppState((s) => s.settings);
export const useApi = () => useAppState((s) => s.api);

/** Fetches a breakdown for `range`, refetching when the snapshot changes. */
export function useBreakdown(range: RangeQuery): Breakdown | null {
  const api = useApi();
  const generatedAt = useAppState((s) => s.snapshot?.generatedAt);
  const [data, setData] = useState<Breakdown | null>(null);
  const key = `${range.kind}|${range.from ?? ""}|${range.to ?? ""}`;
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.getBreakdown(range).then((b) => live && setData(b));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, generatedAt]);
  return data;
}

/** Saves settings through the API and mirrors the result into the store. */
export async function updateSettings(patch: Parameters<TokenstreakApi["updateSettings"]>[0]): Promise<void> {
  const api = state.api;
  if (!api) return;
  const settings = await api.updateSettings(patch);
  setState({ settings });
}

export async function acknowledgeCelebration(): Promise<void> {
  const c = state.celebration;
  setState({ celebration: null });
  if (c && state.api) await state.api.acknowledgeCelebration(c.date);
}
