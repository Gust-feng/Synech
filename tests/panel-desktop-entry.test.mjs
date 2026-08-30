import assert from "node:assert/strict";
import test from "node:test";

import { createPanelDesktopWindowOptions, panelLaunchUrl } from "../dist/app/desktop/panel-desktop-launcher.js";

test("Desktop starts with one ordinary opaque BrowserWindow", () => {
  const options = createPanelDesktopWindowOptions();
  assert.equal(options.transparent, false);
  assert.equal(options.show, false);
  assert.equal(options.frame, false);
});

test("desktop launch mode becomes a plain query parameter inside Electron", () => {
  assert.equal(panelLaunchUrl("http://127.0.0.1:9090/", "installed"), "http://127.0.0.1:9090/?launch=installed");
  assert.equal(panelLaunchUrl("http://127.0.0.1:9090/", "updated"), "http://127.0.0.1:9090/?launch=updated");
  assert.equal(panelLaunchUrl("http://127.0.0.1:9090/", undefined), "http://127.0.0.1:9090/");
  assert.equal(panelLaunchUrl("http://localhost:5173/?foo=1", "installed"), "http://localhost:5173/?foo=1&launch=installed");
});
