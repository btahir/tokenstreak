export const PRESET_IDS = [
  "new-user",
  "first-run-reveal",
  "streak-30",
  "heavy-multi-tool",
  "goal-hit",
  "streak-at-risk",
] as const;
export type PresetId = (typeof PRESET_IDS)[number];
