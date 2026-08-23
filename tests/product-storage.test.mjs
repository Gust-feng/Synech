import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mcpManagedRuntimeDirectories } from "../dist/adapters/mcp/mcp-local-runtime.js";
import { startLocalPanelServer } from "../dist/app/panel-server/request-handler.js";
import {
  PRODUCT_HOME_LEASE_FILENAME,
  STORAGE_LAYOUT_MANIFEST,
  acquireProductHomeLease,
  initializeProductStorage,
  productStorageDirectories,
  resolveProductHome,
  resolveProductPaths,
} from "../dist/platform/storage/index.js";

test("Product Home resolver follows its documented precedence and platform defaults", async (t) => {
  const cases = [
    {
      name: "explicit selection wins over SYNECH_HOME",
      options: {
        productHome: "./explicit-home",
        env: { SYNECH_HOME: "./environment-home", SYNECH_CONFIG_DIR: "./legacy-config" },
      },
      expected: path.resolve("./explicit-home"),
    },
    {
      name: "SYNECH_HOME wins over platform defaults",
      options: {
        env: {
          SYNECH_HOME: "./environment-home",
          LOCALAPPDATA: "./local-app-data",
          SYNECH_CONFIG_DIR: "./legacy-config",
        },
        platform: "win32",
        homeDirectory: path.resolve("home"),
      },
      expected: path.resolve("./environment-home"),
    },
    {
      name: "Windows uses LOCALAPPDATA",
      options: {
        env: { LOCALAPPDATA: path.resolve("local-app-data"), SYNECH_CONFIG_DIR: "./ignored" },
        platform: "win32",
        homeDirectory: path.resolve("home"),
      },
      expected: path.resolve("local-app-data", "Synech"),
    },
    {
      name: "Windows falls back below the user home",
      options: {
        env: { SYNECH_CONFIG_DIR: "./ignored" },
        platform: "win32",
        homeDirectory: path.resolve("home"),
      },
      expected: path.resolve("home", "AppData", "Local", "Synech"),
    },
    {
      name: "macOS uses Application Support",
      options: {
        env: { SYNECH_CONFIG_DIR: "./ignored" },
        platform: "darwin",
        homeDirectory: path.resolve("home"),
      },
      expected: path.resolve("home", "Library", "Application Support", "Synech"),
    },
    {
      name: "Linux uses XDG_DATA_HOME",
      options: {
        env: { XDG_DATA_HOME: path.resolve("xdg-data"), SYNECH_CONFIG_DIR: "./ignored" },
        platform: "linux",
        homeDirectory: path.resolve("home"),
      },
      expected: path.resolve("xdg-data", "synech"),
    },
    {
      name: "Linux falls back below .local/share",
      options: {
        env: { SYNECH_CONFIG_DIR: "./ignored" },
        platform: "linux",
        homeDirectory: path.resolve("home"),
      },
      expected: path.resolve("home", ".local", "share", "synech"),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      assert.equal(resolveProductHome(entry.options), entry.expected);
    });
  }
});

test("resolveProductPaths returns the exact v1 layout below Product Home", () => {
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
    layoutManifest: path.join(productHome, "storage-layout.json"),
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
    cache: {
      root: cache,
      electron: path.join(cache, "electron"),
    },
    backups: path.join(productHome, "backups"),
  });

  for (const candidate of collectStringValues(paths)) {
    if (candidate === productHome) continue;
    const relative = path.relative(productHome, candidate);
    assert.ok(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative), candidate);
  }
});

test("initialization creates the strict v1 layout and is idempotent", async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const paths = resolveProductPaths({ productHome: path.join(temporaryDirectory, "product") });
    await initializeProductStorage(paths);

    const manifest = JSON.parse(await fs.readFile(paths.layoutManifest, "utf8"));
    assert.deepEqual(manifest, STORAGE_LAYOUT_MANIFEST);
    assert.deepEqual(Object.keys(manifest).sort(), ["layoutVersion", "product"]);
    for (const directory of productStorageDirectories(paths)) {
      assert.equal((await fs.stat(directory)).isDirectory(), true, directory);
    }

    const preservedManifest = JSON.stringify(STORAGE_LAYOUT_MANIFEST);
    const userFile = path.join(paths.configDirectory, "user-settings.json");
    await fs.writeFile(paths.layoutManifest, preservedManifest, "utf8");
    await fs.writeFile(userFile, "user-owned", "utf8");
    await fs.rm(paths.data.agent.attachments, { recursive: true });
    await fs.rm(paths.state.runtimeTools.mcp.bin, { recursive: true });

    await initializeProductStorage(paths);

    assert.equal(await fs.readFile(paths.layoutManifest, "utf8"), preservedManifest);
    assert.equal(await fs.readFile(userFile, "utf8"), "user-owned");
    assert.equal((await fs.stat(paths.data.agent.attachments)).isDirectory(), true);
    assert.equal((await fs.stat(paths.state.runtimeTools.mcp.bin)).isDirectory(), true);
  });
});

test("initialization fails closed for invalid or conflicting layouts", async (t) => {
  const invalidManifestCases = [
    { name: "invalid JSON", source: "{not-json" },
    { name: "wrong product", source: JSON.stringify({ product: "other", layoutVersion: 1 }) },
    { name: "layoutVersion 0", source: JSON.stringify({ product: "synech", layoutVersion: 0 }) },
    { name: "layoutVersion 2", source: JSON.stringify({ product: "synech", layoutVersion: 2 }) },
    { name: "undeclared manifest field", source: JSON.stringify({ product: "synech", layoutVersion: 1, extra: true }) },
  ];

  await t.test("non-empty Product Home without a manifest", async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const paths = resolveProductPaths({ productHome: path.join(temporaryDirectory, "product") });
      await fs.mkdir(paths.productHome, { recursive: true });
      const sentinel = path.join(paths.productHome, "existing.txt");
      await fs.writeFile(sentinel, "do-not-overwrite", "utf8");

      await assertLayoutError(() => initializeProductStorage(paths));
      assert.equal(await fs.readFile(sentinel, "utf8"), "do-not-overwrite");
      await assert.rejects(fs.access(paths.layoutManifest), { code: "ENOENT" });
    });
  });

  for (const entry of invalidManifestCases) {
    await t.test(entry.name, async () => {
      await withTemporaryDirectory(async (temporaryDirectory) => {
        const paths = resolveProductPaths({ productHome: path.join(temporaryDirectory, "product") });
        await fs.mkdir(paths.productHome, { recursive: true });
        await fs.writeFile(paths.layoutManifest, entry.source, "utf8");

        await assertLayoutError(() => initializeProductStorage(paths));
        assert.equal(await fs.readFile(paths.layoutManifest, "utf8"), entry.source);
      });
    });
  }

  await t.test("a required directory path occupied by a file", async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const paths = resolveProductPaths({ productHome: path.join(temporaryDirectory, "product") });
      await fs.mkdir(paths.productHome, { recursive: true });
      const manifestSource = JSON.stringify(STORAGE_LAYOUT_MANIFEST);
      await fs.writeFile(paths.layoutManifest, manifestSource, "utf8");
      await fs.writeFile(paths.configDirectory, "do-not-overwrite", "utf8");

      await assertLayoutError(() => initializeProductStorage(paths));
      assert.equal(await fs.readFile(paths.layoutManifest, "utf8"), manifestSource);
      assert.equal(await fs.readFile(paths.configDirectory, "utf8"), "do-not-overwrite");
    });
  });
});

test("Product Home lease rejects a second owner and can be reacquired after release", async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const productHome = path.join(temporaryDirectory, "product");
    const leasePath = path.join(productHome, PRODUCT_HOME_LEASE_FILENAME);
    const first = await acquireProductHomeLease(productHome);
    assert.equal((await fs.stat(leasePath)).isFile(), true);

    await assert.rejects(
      () => acquireProductHomeLease(productHome),
      (error) => error?.code === "product_home_in_use" && error.ownerPid === process.pid,
    );

    await first.release();
    await assert.rejects(fs.access(leasePath), { code: "ENOENT" });
    const second = await acquireProductHomeLease(productHome);
    await second.release();
    await assert.rejects(fs.access(leasePath), { code: "ENOENT" });
  });
});

test("local panel startup owns the canonical layout and releases its lease", async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const productHome = path.join(temporaryDirectory, "product");
    const leasePath = path.join(productHome, PRODUCT_HOME_LEASE_FILENAME);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const server = await startLocalPanelServer({ productHome, port: 0 });
      try {
        assert.equal(server.productHome, path.resolve(productHome));
        assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/u);
        assert.deepEqual(
          JSON.parse(await fs.readFile(path.join(productHome, "storage-layout.json"), "utf8")),
          STORAGE_LAYOUT_MANIFEST,
        );
        assert.equal((await fs.stat(leasePath)).isFile(), true);
      } finally {
        await server.close();
      }
      await assert.rejects(fs.access(leasePath), { code: "ENOENT" });
    }
  });
});

test("MCP managed bin resolves only to the canonical Product Home state path", () => {
  const productHome = path.resolve("mcp-product-home");
  const legacyHome = path.resolve("legacy-user-home");
  const expected = path.join(productHome, "state", "runtime-tools", "mcp", "bin");
  const env = {
    SYNECH_HOME: productHome,
    SYNECH_CONFIG_DIR: path.join(legacyHome, ".synech"),
    HOME: legacyHome,
    USERPROFILE: legacyHome,
  };

  assert.deepEqual(mcpManagedRuntimeDirectories(env), [expected]);
  assert.deepEqual(
    mcpManagedRuntimeDirectories(env, { managedBinDirectory: expected }),
    [expected],
  );
  assert.equal(mcpManagedRuntimeDirectories(env).some((entry) => entry.includes(".synech")), false);
});

async function assertLayoutError(operation) {
  await assert.rejects(
    operation,
    (error) => error?.code === "product_storage_layout_invalid",
  );
}

function collectStringValues(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectStringValues);
}

async function withTemporaryDirectory(operation) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-storage-test-"));
  let operationError;
  try {
    await operation(temporaryDirectory);
  } catch (error) {
    operationError = error;
  }

  try {
    await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (cleanupError) {
    if (operationError === undefined) throw cleanupError;
    process.stderr.write(`Temporary directory cleanup also failed: ${cleanupError}\n`);
  }
  if (operationError !== undefined) throw operationError;
}
