import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mcpManagedRuntimeDirectories } from "../dist/adapters/mcp/mcp-local-runtime.js";
import { startPanelDesktopSession } from "../dist/app/desktop/panel-desktop-launcher.js";
import { startLocalPanelServer } from "../dist/app/panel-server/request-handler.js";
import {
  initializeProductStorage,
  productStorageDirectories,
  resolveProductHome,
  resolveProductPaths,
} from "../dist/platform/storage/index.js";

test("Product Home uses explicit selection, SYNECH_HOME, then platform defaults", async (t) => {
  const homeDirectory = path.resolve("test-user-home");
  const cases = [
    [
      "explicit selection",
      { productHome: "./explicit", env: { SYNECH_HOME: "./environment" } },
      path.resolve("explicit"),
    ],
    [
      "environment selection",
      { env: { SYNECH_HOME: "./environment" }, platform: "win32", homeDirectory },
      path.resolve("environment"),
    ],
    [
      "Windows LOCALAPPDATA",
      { env: { LOCALAPPDATA: path.resolve("local-app-data") }, platform: "win32", homeDirectory },
      path.resolve("local-app-data", "Synech"),
    ],
    [
      "Windows home fallback",
      { env: {}, platform: "win32", homeDirectory },
      path.join(homeDirectory, "AppData", "Local", "Synech"),
    ],
    [
      "macOS Application Support",
      { env: {}, platform: "darwin", homeDirectory },
      path.join(homeDirectory, "Library", "Application Support", "Synech"),
    ],
    [
      "Linux XDG data",
      { env: { XDG_DATA_HOME: path.resolve("xdg-data") }, platform: "linux", homeDirectory },
      path.resolve("xdg-data", "synech"),
    ],
    [
      "Linux home fallback",
      { env: {}, platform: "linux", homeDirectory },
      path.join(homeDirectory, ".local", "share", "synech"),
    ],
  ];

  for (const [name, options, expected] of cases) {
    await t.test(name, () => {
      assert.equal(resolveProductHome(options), expected);
    });
  }
});

test("Product paths describe the canonical config, data, state, cache and backup tree", () => {
  const productHome = path.resolve("test-product-home");
  const paths = resolveProductPaths({ productHome });
  const data = path.join(productHome, "data");
  const agent = path.join(data, "agent");
  const workbench = path.join(data, "workbench");
  const state = path.join(productHome, "state");
  const runtimeTools = path.join(state, "runtime-tools");
  const mcp = path.join(runtimeTools, "mcp");
  const cache = path.join(productHome, "cache");

  assert.deepEqual(paths, {
    productHome,
    configDirectory: path.join(productHome, "config"),
    data: {
      root: data,
      database: path.join(data, "synech.sqlite3"),
      agent: {
        root: agent,
        runs: path.join(agent, "runs"),
        conversations: path.join(agent, "conversations"),
        sessions: path.join(agent, "sessions"),
        attachments: path.join(agent, "attachments"),
        evidence: path.join(agent, "evidence"),
        memoryFacts: path.join(agent, "memory-facts"),
      },
      workbench: {
        root: workbench,
        spaceFiles: path.join(workbench, "space-files"),
        knowledgeAssets: path.join(workbench, "knowledge-assets"),
        notes: path.join(workbench, "notes"),
        methodMemory: path.join(workbench, "method-memory"),
      },
    },
    state: {
      root: state,
      journals: path.join(state, "journals"),
      locks: path.join(state, "locks"),
      restoreMarkers: path.join(state, "restore-markers"),
      runtimeTools: {
        root: runtimeTools,
        mcp: { root: mcp, bin: path.join(mcp, "bin") },
      },
      electron: path.join(state, "electron"),
    },
    cache: { root: cache, electron: path.join(cache, "electron") },
    backups: path.join(productHome, "backups"),
  });

  for (const directory of productStorageDirectories(paths)) {
    const relative = path.relative(productHome, directory);
    assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false);
  }
});

test("Storage initialization creates the directory tree and is idempotent", async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const paths = resolveProductPaths({ productHome: path.join(temporaryDirectory, "product") });
    await initializeProductStorage(paths);
    for (const directory of productStorageDirectories(paths)) {
      assert.equal((await fs.stat(directory)).isDirectory(), true);
    }

    const marker = path.join(paths.data.agent.runs, "preserved.txt");
    await fs.writeFile(marker, "preserved", "utf8");
    await initializeProductStorage(paths);
    assert.equal(await fs.readFile(marker, "utf8"), "preserved");
  });
});

test("Desktop storage paths are configured after server startup and before Electron readiness", async (t) => {
  const args = { host: "127.0.0.1", port: 0, productHome: "chosen-home", smoke: false };

  await t.test("uses the Product Home returned by the initialized server", async () => {
    const events = [];
    const session = await startPanelDesktopSession(args, desktopDependencies({
      events,
      configureAppStoragePaths(productHome) {
        assert.equal(productHome, path.resolve("canonical-home"));
        events.push("configure-paths");
      },
    }));
    assert.deepEqual(events.slice(0, 5), ["server-started", "configure-paths", "ready", "window-created", "url-loaded"]);
    await session.close();
  });

  await t.test("closes the server when Electron rejects its storage paths", async () => {
    const events = [];
    const failure = new Error("setPath rejected");
    await assert.rejects(
      () => startPanelDesktopSession(args, desktopDependencies({
        events,
        configureAppStoragePaths() {
          events.push("configure-paths");
          throw failure;
        },
      })),
      failure,
    );
    assert.deepEqual(events, ["server-started", "configure-paths", "server-closed"]);
  });
});

test("A Product Home can start, close and start again", async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const productHome = path.join(temporaryDirectory, "product");
    const paths = resolveProductPaths({ productHome });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const server = await startLocalPanelServer({ productHome, port: 0 });
      try {
        assert.equal(server.productHome, path.resolve(productHome));
        assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/u);
        assert.equal((await fs.stat(paths.data.database)).isFile(), true);
      } finally {
        await server.close();
      }
    }
  });
});

test("MCP managed runtime uses the canonical Product Home state path", () => {
  const productHome = path.resolve("mcp-product-home");
  const expected = path.join(productHome, "state", "runtime-tools", "mcp", "bin");
  const env = {
    SYNECH_HOME: productHome,
    SYNECH_CONFIG_DIR: path.resolve("ignored-config"),
    HOME: path.resolve("unrelated-home"),
  };

  assert.deepEqual(mcpManagedRuntimeDirectories(env), [expected]);
  assert.deepEqual(mcpManagedRuntimeDirectories(env, { managedBinDirectory: expected }), [expected]);
});

function desktopDependencies({ events, configureAppStoragePaths }) {
  return {
    async startPanelServer() {
      events.push("server-started");
      return {
        url: "http://127.0.0.1:12345/",
        productHome: path.resolve("canonical-home"),
        configDirectory: path.resolve("canonical-home", "config"),
        async close() {
          events.push("server-closed");
        },
      };
    },
    configureAppStoragePaths,
    async whenReady() {
      events.push("ready");
    },
    createWindow() {
      events.push("window-created");
      return {
        async loadUrl() {
          events.push("url-loaded");
        },
        onReadyToShow() {},
        show() {},
        isVisible() { return false; },
        isDestroyed() { return false; },
      };
    },
    onWindowAllClosed() {},
    onBeforeQuit() {},
    quit() {},
  };
}

async function withTemporaryDirectory(operation) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-storage-test-"));
  try {
    await operation(temporaryDirectory);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
