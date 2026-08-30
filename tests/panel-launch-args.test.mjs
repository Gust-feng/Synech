import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePanelArgs,
  parsePanelDesktopArgs,
} from "../dist/app/panel-server/panel-launch-args.js";

test("Desktop launch presentation accepts installer and updater restart facts", () => {
  assert.equal(
    parsePanelDesktopArgs(["--first-launch-after-install"]).desktopLaunch,
    "installed",
  );
  assert.equal(parsePanelDesktopArgs(["--updated"]).desktopLaunch, "updated");
});

test("Panel server does not accept desktop-only launch presentation flags", () => {
  assert.throws(
    () => parsePanelArgs(["--first-launch-after-install"]),
    /Unknown panel argument/u,
  );
});

test("Desktop launch rejects removed handoff flags", () => {
  assert.throws(
    () => parsePanelDesktopArgs(["--first-launch-after-install", "--install-handoff-id=abc"]),
    /Unknown panel argument/u,
  );
});
