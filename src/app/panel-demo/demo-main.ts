import { installPanelDemoTransport } from "./panel-demo-transport";

installPanelDemoTransport();

// The demo boots the production Panel entry only after the browser transport
// is installed. App, components, styles and state projections stay identical
// to the desktop product; only the loopback PanelHost boundary is replaced.
void import("../panel-ui/src/main");
