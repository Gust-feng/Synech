import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileSystemLocalDevSecretStore,
  FileSystemLocalDevSecretStoreError,
} from "../dist/adapters/config/index.js";
import { createLocalConfigCenter } from "../dist/app/config-center/index.js";

test("invalid settings are quarantined before defaults are recreated", async () => {
  for (const invalid of ["{", JSON.stringify({ version: 99, updatedAt: "invalid" })]) {
    await withConfigDirectory(async (directory) => {
      const settingsPath = path.join(directory, "settings.json");
      await writeFile(settingsPath, invalid, "utf8");

      const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
      const settings = await configCenter.getModelProviderConfig();

      assert.equal(settings.profileId.length > 0, true);
      const files = await readdir(directory);
      const corrupt = files.find((name) => name.startsWith("settings.json.corrupt-"));
      assert.notEqual(corrupt, undefined);
      assert.equal(await readFile(path.join(directory, corrupt), "utf8"), invalid);
      assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).version, 1);
    });
  }
});

test("an invalid secrets document is never overwritten by a later write", async () => {
  const invalidDocuments = [
    "{",
    JSON.stringify({
      version: 1,
      secrets: { existing: { value: "keep-me" } },
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
    JSON.stringify({
      version: 1,
      secrets: { existing: { value: "keep-me", updatedAt: "2026-08-26T00:00:00.000Z", extra: true } },
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  ];
  for (const invalid of invalidDocuments) {
    await withConfigDirectory(async (directory) => {
      const secretsPath = path.join(directory, "local-dev-secrets.json");
      await writeFile(secretsPath, invalid, "utf8");
      const store = new FileSystemLocalDevSecretStore(directory);
      const invalidSecret = (error) => error instanceof FileSystemLocalDevSecretStoreError &&
        error.code === "local_dev_secrets_invalid";

      await assert.rejects(store.readSecret("existing"), invalidSecret);
      await assert.rejects(store.writeSecret("new-secret", "new-value"), invalidSecret);
      await assert.rejects(store.deleteSecret("existing"), invalidSecret);
      assert.equal(await readFile(secretsPath, "utf8"), invalid);
    });
  }
});

async function withConfigDirectory(operation) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synech-config-recovery-"));
  try {
    await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
