import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const compiledRoot = path.resolve(process.env.SYNECH_TEST_DIST ?? "dist");
const leaseModuleUrl = pathToFileURL(path.join(compiledRoot, "app/panel-server/product-home-runtime-lease.js"));
const leaseModule = await import(leaseModuleUrl);

function resetProcess(productHome, extraArgs = []) {
  return spawnSync(process.execPath, ["scripts/reset-product-home.mjs", "--home", productHome, "--confirm", productHome, ...extraArgs], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, SYNECH_RUNTIME_LEASE_MODULE: fileURLPath(leaseModuleUrl) },
  });
}

test("reset refuses while PanelHost holds the Product Home runtime lease", async () => {
  const productHome = await mkdtemp(path.join(os.tmpdir(), "synech-reset-live-"));
  const marker = path.join(productHome, "keep.txt");
  await writeFile(marker, "must survive\n", "utf8");
  const lease = await leaseModule.acquireProductHomeRuntimeLease(productHome);
  try {
    assert.equal((await leaseModule.inspectProductHomeRuntimeLease(productHome)).status, "held");
    const result = resetProcess(productHome);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /product_home_in_use/u);
    assert.equal(await readFile(marker, "utf8"), "must survive\n");
  } finally {
    await lease.release();
    await rm(productHome, { recursive: true, force: true });
  }
});

test("reset still deletes an idle Product Home after explicit confirmation", async () => {
  const productHome = await mkdtemp(path.join(os.tmpdir(), "synech-reset-idle-"));
  await writeFile(path.join(productHome, "marker.txt"), "delete me\n", "utf8");
  try {
    const result = resetProcess(productHome);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes("Removed Synech Product Home"), true);
    await assert.rejects(() => readFile(path.join(productHome, "marker.txt")));
  } finally {
    await rm(productHome, { recursive: true, force: true });
  }
});

function fileURLPath(url) {
  return decodeURIComponent(new URL(url).pathname).replace(/^\/(\w):/u, "$1:");
}

// Core invariant: an explicit test-data reset must not remove model credentials
// or user/project skills while dropping incompatible content and restore intents.
test("data-only reset preserves configuration and external skills while removing test lifecycle data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synech-reset-data-"));
  const productHome = path.join(root, "product");
  const externalProject = path.join(root, "project");
  const config = path.join(productHome, "config");
  const data = path.join(productHome, "data");
  const journals = path.join(productHome, "state", "journals");
  const restore = path.join(productHome, "state", "restore-markers");
  const skills = path.join(externalProject, ".agents", "skills", "example");
  await Promise.all([config, data, journals, restore, skills].map(directory => mkdir(directory, { recursive: true })));
  await Promise.all([
    writeFile(path.join(config, "local-dev-secrets.json"), "fixture credential", "utf8"),
    writeFile(path.join(data, "synech.sqlite3"), "old fixture", "utf8"),
    writeFile(path.join(journals, "old-intent.json"), "{}", "utf8"),
    writeFile(path.join(restore, "old-restore.json"), "{}", "utf8"),
    writeFile(path.join(skills, "SKILL.md"), "fixture skill", "utf8"),
  ]);
  try {
    const result = resetProcess(productHome, ["--data-only"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(path.join(config, "local-dev-secrets.json"), "utf8"), "fixture credential");
    assert.equal(await readFile(path.join(skills, "SKILL.md"), "utf8"), "fixture skill");
    await assert.rejects(() => readFile(path.join(data, "synech.sqlite3")));
    await assert.rejects(() => readFile(path.join(journals, "old-intent.json")));
    await assert.rejects(() => readFile(path.join(restore, "old-restore.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
