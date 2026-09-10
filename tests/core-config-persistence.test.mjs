import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalConfigCenter } from "../dist/app/config-center/index.js";
import { FileSystemLocalDevSecretStore, FileSystemLocalDevSecretStoreError } from "../dist/adapters/config/index.js";

test("configuration mutations serialize without losing either update", async () => {
  await withDirectory(async (directory) => {
    const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
    await Promise.all([
      configCenter.updateToolState({ name: "Read", enabled: false }),
      configCenter.updateSkillTriggerConfig({ mode: "keyword" }),
    ]);
    assert.equal((await configCenter.listToolStates())[0]?.enabled, false);
    assert.equal((await configCenter.getSkillTriggerConfig()).mode, "keyword");
  });
});

test("corrupt settings are quarantined and corrupt secrets are preserved", async () => {
  await withDirectory(async (directory) => {
    const settingsPath = path.join(directory, "settings.json");
    await writeFile(settingsPath, "{", "utf8");
    const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
    assert.equal((await configCenter.getModelProviderConfig()).profileId.length > 0, true);
    const backup = (await readdir(directory)).find((name) => name.startsWith("settings.json.corrupt-"));
    assert.equal(await readFile(path.join(directory, backup), "utf8"), "{");

    const secretsPath = path.join(directory, "local-dev-secrets.json");
    const invalid = JSON.stringify({ version: 1, secrets: { old: { value: "keep" } }, updatedAt: "now" });
    await writeFile(secretsPath, invalid, "utf8");
    const store = new FileSystemLocalDevSecretStore(directory);
    await assert.rejects(store.writeSecret("new", "value"), (error) => error instanceof FileSystemLocalDevSecretStoreError);
    assert.equal(await readFile(secretsPath, "utf8"), invalid);
  });
});

async function withDirectory(operation) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synech-core-config-"));
  try { await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
}
