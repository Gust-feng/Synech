import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireDesktopSingleInstance } from "../dist/app/desktop/panel-desktop-single-instance.js";
import {
  normalizeLoopbackHost,
  startLocalPanelServer,
} from "../dist/app/panel-server/request-handler.js";

test("one Product Home admits only one live PanelHost", async () => {
  await withTemporaryDirectory(async (directory) => {
    const productHome = path.join(directory, "product");
    const first = await startLocalPanelServer({ productHome, port: 0 });
    try {
      await assert.rejects(
        startLocalPanelServer({ productHome, port: 0 }),
        (error) => error?.code === "product_home_in_use" && error.holder?.pid === process.pid,
      );
    } finally {
      await first.close();
    }

    const restarted = await startLocalPanelServer({ productHome, port: 0 });
    await restarted.close();
  });
});

test("different Product Homes may run independently", async () => {
  await withTemporaryDirectory(async (directory) => {
    const [left, right] = await Promise.all([
      startLocalPanelServer({ productHome: path.join(directory, "left"), port: 0 }),
      startLocalPanelServer({ productHome: path.join(directory, "right"), port: 0 }),
    ]);
    await Promise.all([left.close(), right.close()]);
  });
});

test("Panel host policy accepts loopback and rejects network exposure before creating storage", async () => {
  assert.equal(normalizeLoopbackHost("LOCALHOST"), "localhost");
  assert.equal(normalizeLoopbackHost("127.0.0.2"), "127.0.0.2");
  assert.equal(normalizeLoopbackHost("::1"), "::1");
  assert.throws(() => normalizeLoopbackHost("0.0.0.0"), (error) => error?.code === "panel_non_loopback_host");

  await withTemporaryDirectory(async (directory) => {
    const productHome = path.join(directory, "must-not-exist");
    await assert.rejects(
      startLocalPanelServer({ productHome, host: "192.168.1.10", port: 0 }),
      (error) => error?.code === "panel_non_loopback_host",
    );
    await assert.rejects(fs.stat(productHome), (error) => error?.code === "ENOENT");
  });
});

test("desktop single-instance policy focuses the owner and exits the contender", () => {
  let secondInstanceListener;
  let focusCount = 0;
  let quitCount = 0;
  assert.equal(acquireDesktopSingleInstance({
    requestLock: () => true,
    onSecondInstance: (listener) => { secondInstanceListener = listener; },
    focusCurrentWindow: () => { focusCount += 1; },
    quit: () => { quitCount += 1; },
  }), true);
  secondInstanceListener();
  assert.equal(focusCount, 1);
  assert.equal(quitCount, 0);

  assert.equal(acquireDesktopSingleInstance({
    requestLock: () => false,
    onSecondInstance() { throw new Error("must not register"); },
    focusCurrentWindow() { throw new Error("must not focus"); },
    quit: () => { quitCount += 1; },
  }), false);
  assert.equal(quitCount, 1);
});

async function withTemporaryDirectory(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-panel-boundary-"));
  try {
    await operation(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}
