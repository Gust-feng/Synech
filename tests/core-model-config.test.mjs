import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalConfigCenter } from "../dist/app/config-center/index.js";
import { parseConfigUpdate } from "../dist/app/panel-server/request-parsers.js";

test("saving a remote model catalog keeps a user-configured model id outside the catalog", async () => {
  await withDirectory(async (directory) => {
    const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
    await configCenter.updateModelProviderConfig({ model: "my-own-model" });
    await configCenter.upsertModelProviderModelCatalog({
      profileId: "default",
      label: "Discovered",
      baseUrl: "https://connect.example.invalid/v1",
      modelsPath: "/models",
      fetchedAt: "2026-09-28T00:00:00.000Z",
      models: [{ id: "listed-model", displayName: "Listed model" }],
    });
    const config = await configCenter.getModelProviderConfig();
    assert.equal(config.model, "my-own-model");

    // The catalog itself is still saved as a pure discovery cache.
    const catalogs = await configCenter.listModelProviderModelCatalogs();
    assert.deepEqual(catalogs.map((catalog) => catalog.models.map((model) => model.id)), [["listed-model"]]);

    // Reload from disk: neither the model id nor the catalog was dropped.
    const reopened = createLocalConfigCenter({ configDirectory: directory }).configCenter;
    assert.equal((await reopened.getModelProviderConfig()).model, "my-own-model");
    assert.deepEqual(
      (await reopened.listModelProviderModelCatalogs())[0]?.models.map((model) => model.id),
      ["listed-model"],
    );
  });
});

test("piProviderId prefills on built-in slots and round-trips on custom profiles", async () => {
  await withDirectory(async (directory) => {
    const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
    // The default slot maps to the OpenAI preset, so its pi provider is explicit.
    assert.equal((await configCenter.getModelProviderConfig()).piProviderId, "openai");

    await configCenter.createModelProviderProfile({
      profileId: "custom_gateway",
      label: "Gateway",
      baseUrl: "https://gateway.example.invalid/v1",
      protocolKind: "openai_compatible_chat_completions",
    });
    // A custom profile starts without a declared pi provider: all its models are
    // treated as unknown discovered models.
    const created = (await configCenter.listModelProviderProfiles())
      .find((profile) => profile.profileId === "custom_gateway");
    assert.equal(created?.piProviderId, undefined);

    await configCenter.updateModelProviderConfig({
      profileId: "custom_gateway",
      piProviderId: "deepseek",
    });
    const reopened = createLocalConfigCenter({ configDirectory: directory }).configCenter;
    const saved = (await reopened.listModelProviderProfiles())
      .find((profile) => profile.profileId === "custom_gateway");
    assert.equal(saved?.piProviderId, "deepseek");

    // The user can clear an explicitly declared pi provider on a custom profile.
    await reopened.updateModelProviderConfig({ profileId: "custom_gateway", clearPiProviderId: true });
    const cleared = (await reopened.listModelProviderProfiles())
      .find((profile) => profile.profileId === "custom_gateway");
    assert.equal(cleared?.piProviderId, undefined);
  });
});

test("parseConfigUpdate carries piProviderId through config-center upsert and persistence", async () => {
  await withDirectory(async (directory) => {
    const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
    await configCenter.createModelProviderProfile({
      profileId: "custom_gateway",
      label: "Gateway",
      baseUrl: "https://gateway.example.invalid/v1",
      protocolKind: "openai_compatible_chat_completions",
    });
    const readSavedPiProviderId = async () => {
      const reopened = createLocalConfigCenter({ configDirectory: directory }).configCenter;
      const saved = (await reopened.listModelProviderProfiles())
        .find((profile) => profile.profileId === "custom_gateway");
      return saved?.piProviderId;
    };

    // The HTTP parser surfaces the declared pi provider instead of dropping it.
    const declared = parseConfigUpdate({ profileId: "custom_gateway", piProviderId: "deepseek" });
    assert.equal(declared.piProviderId, "deepseek");
    await configCenter.updateModelProviderConfig(declared);
    assert.equal(await readSavedPiProviderId(), "deepseek");

    // A save that never mentions piProviderId must not wipe the declaration:
    // config-center does not fall back to the stored value for this field.
    const unrelated = parseConfigUpdate({ profileId: "custom_gateway", label: "Gateway renamed" });
    assert.equal("piProviderId" in unrelated, false);
    await configCenter.updateModelProviderConfig(unrelated);
    assert.equal(await readSavedPiProviderId(), "deepseek");

    // The explicit clear flag normalizes to undefined after persistence.
    await configCenter.updateModelProviderConfig(
      parseConfigUpdate({ profileId: "custom_gateway", clearPiProviderId: true }),
    );
    assert.equal(await readSavedPiProviderId(), undefined);

    // An empty declaration also normalizes to undefined instead of persisting "".
    await configCenter.updateModelProviderConfig(
      parseConfigUpdate({ profileId: "custom_gateway", piProviderId: "deepseek" }),
    );
    await configCenter.updateModelProviderConfig(
      parseConfigUpdate({ profileId: "custom_gateway", piProviderId: "" }),
    );
    assert.equal(await readSavedPiProviderId(), undefined);
  });
});

async function withDirectory(operation) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synech-core-model-config-"));
  try { await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
}
