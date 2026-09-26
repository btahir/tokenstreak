import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `pnpm dev`      → Tauri dev server (real backend over IPC), port 1420.
// `pnpm dev:web`  → plain browser with the mock backend (VITE_BACKEND=mock).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  clearScreen: false,
  define: {
    "import.meta.env.VITE_BACKEND": JSON.stringify(mode === "web" ? "mock" : "auto"),
    // The production app bundle ships without the mock backend and presets.
    "import.meta.env.VITE_INCLUDE_MOCK": JSON.stringify(mode !== "production"),
  },
  server: {
    port: mode === "web" ? 5173 : 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
  build: {
    target: "safari15",
    sourcemap: mode !== "production",
  },
}));
