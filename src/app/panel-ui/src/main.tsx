import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { ErrorBoundary } from "./components/error-boundary";
import { applyMotionPreference } from "./app-motion";
import { applyTheme, getInitialTheme } from "./app-theme";
import { startPanelResponsivenessDiagnostics } from "./app-responsiveness-diagnostics";
import { panelQueryClient } from "./panel-query-client";
import { scheduleOfficePreviewWarmup } from "./personal-workbench/workbench/app/components/officePreviewRuntime";
import "./personal-workbench/workbench/styles/index.css";

applyMotionPreference();
const initialTheme = getInitialTheme();
// The inline bootstrap script paints the first frame; applying the same
// preference here also installs the live OS listener for "跟随系统".
applyTheme(initialTheme.styleId, initialTheme.colorId);
startPanelResponsivenessDiagnostics();

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <QueryClientProvider client={panelQueryClient}>
      <App />
    </QueryClientProvider>
  </ErrorBoundary>
);

scheduleOfficePreviewWarmup();