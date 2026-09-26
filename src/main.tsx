import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startStore } from "./state/store";

startStore();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
