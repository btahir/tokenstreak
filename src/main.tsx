import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/popover.css";
import "./styles/dashboard.css";
import { App } from "./App";
import { startStore } from "./state/store";

performance.mark("ts:boot");
startStore();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
