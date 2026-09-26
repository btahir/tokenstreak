/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "mock" in `pnpm dev:web`, otherwise "auto" (Tauri when available). */
  readonly VITE_BACKEND: "mock" | "auto";
  /** False in the production app build (mock code is tree-shaken out). */
  readonly VITE_INCLUDE_MOCK: boolean;
}
