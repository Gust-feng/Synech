import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_CLOSE_BEHAVIOR_PREFERENCE_KEY,
  desktopWindowCloseAction,
  normalizeDesktopPlatform,
  parseDesktopCloseBehavior,
  shouldQuitWhenAllWindowsClosed,
} from "../dist/app/panel-api/desktop-lifecycle.js";
import { normalizeDesktopLocalPreferenceKey } from "../dist/app/desktop/panel-desktop-local-preferences.js";

test("desktop lifecycle contract keeps the close preference stable and defaults to quit", () => {
  assert.equal(DESKTOP_CLOSE_BEHAVIOR_PREFERENCE_KEY, "synech/v1-baseline-2:desktop.close-behavior");
  assert.equal(parseDesktopCloseBehavior(undefined), "quit");
  assert.equal(parseDesktopCloseBehavior("unknown"), "quit");
  assert.equal(parseDesktopCloseBehavior("hide-to-tray"), "hide-to-tray");
});

test("desktop preference validation uses the current product data namespace", () => {
  assert.equal(
    normalizeDesktopLocalPreferenceKey("synech/v1-baseline-2:desktop.close-behavior"),
    "synech/v1-baseline-2:desktop.close-behavior",
  );
  assert.equal(normalizeDesktopLocalPreferenceKey("synech/v1:desktop.close-behavior"), undefined);
});

test("only Windows tray mode hides a user-initiated window close", () => {
  assert.equal(desktopWindowCloseAction("win32", "hide-to-tray"), "hide");
  assert.equal(desktopWindowCloseAction("win32", "quit"), "quit");
  assert.equal(desktopWindowCloseAction("darwin", "hide-to-tray"), "quit");
  assert.equal(desktopWindowCloseAction("linux", "hide-to-tray"), "quit");
  assert.equal(desktopWindowCloseAction("win32", "hide-to-tray", true), "quit");
});

test("macOS keeps the process alive after the last window closes", () => {
  assert.equal(shouldQuitWhenAllWindowsClosed("darwin"), false);
  assert.equal(shouldQuitWhenAllWindowsClosed("win32"), true);
  assert.equal(shouldQuitWhenAllWindowsClosed("linux"), true);
  assert.equal(normalizeDesktopPlatform("freebsd"), "other");
});
