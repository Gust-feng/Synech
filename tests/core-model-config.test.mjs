import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalConfigCenter } from "../dist/app/config-center/index.js";
import { normalizeBuiltInModelProviderProfiles } from "../dist/app/config-center/model-provider-profile-settings.js";
import { createFrozenProviderBinding } from "../dist/app/panel-server/settings/model-provider-adapter.js";
import { resolveModelRuntimeConfig } from "../dist/app/model-runtime/model-runtime-config.js";
import { listBuiltinModelProviderPresets } from "../dist/domain/config/index.js";
import { modelProviderMarketPayload } from "../dist/app/panel-server/settings/config-route-payloads.js";
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

test("explicit model clearing survives reload while an empty discovery catalog preserves manual selection", async () => {
  await withDirectory(async (directory) => {
    const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
    await configCenter.createModelProviderProfile({
      profileId: "custom_clearing",
      label: "Custom clearing",
      baseUrl: "https://connect.example.invalid/v1",
      protocolKind: "openai_compatible_chat_completions",
    });
    for (const profileId of ["default", "custom_clearing"]) {
      await configCenter.activateModelProviderProfile(profileId);
      await configCenter.updateModelProviderConfig({ profileId, model: "manually-configured-unknown" });
      const emptyCatalog = {
        profileId,
        baseUrl: "https://connect.example.invalid/v1",
        modelsPath: "/models",
        fetchedAt: "2026-09-30T00:00:00.000Z",
        models: [],
      };
      await configCenter.upsertModelProviderModelCatalog(emptyCatalog);
      let reopened = createLocalConfigCenter({ configDirectory: directory }).configCenter;
      assert.equal((await reopened.getModelProviderConfig()).model, "manually-configured-unknown");

      // An empty model alone is not an explicit clear request.
      await configCenter.updateModelProviderConfig(parseConfigUpdate({ profileId, model: "" }));
      assert.equal((await configCenter.getModelProviderConfig()).model, "manually-configured-unknown");

      // The existing UI save payload requests clearing explicitly.
      const cleared = await configCenter.updateModelProviderConfig(
        parseConfigUpdate({ profileId, model: "", clearModel: true }),
      );
      assert.equal(cleared.model, undefined);
      await configCenter.upsertModelProviderModelCatalog(emptyCatalog);
      reopened = createLocalConfigCenter({ configDirectory: directory }).configCenter;
      assert.equal((await reopened.getModelProviderConfig()).model, undefined);
      assert.deepEqual(await reopened.listModelProviderModelCatalogs(), []);
    }
  });
});

test("piProviderId prefills on built-in slots and round-trips on custom profiles", async () => {
  await withDirectory(async (directory) => {
    const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
    // The default slot maps to the OpenAI preset, so its pi provider is explicit.
    assert.equal((await configCenter.getModelProviderConfig()).piProviderId, "openai");

    // MiniMax's built-in slot is Pi-native: its models speak anthropic-messages
    // through pi's minimax-cn provider, so the preset must declare it rather than
    // degrading every MiniMax model to an unconfirmed discovery.
    const minimaxPreset = listBuiltinModelProviderPresets().find((p) => p.presetId === "minimax");
    assert.equal(minimaxPreset?.piProviderId, "minimax-cn");
    assert.equal(minimaxPreset?.protocolKind, "anthropic_messages");
    assert.equal(minimaxPreset?.baseUrl, "https://api.minimaxi.com/anthropic");

    // A profile bound to that slot inherits the declared pi provider and transport.
    const [normalized] = normalizeBuiltInModelProviderProfiles(
      [{ ...(await configCenter.listModelProviderProfiles())[0], profileId: "minimax", label: "MiniMax" }],
      "2026-09-29T00:00:00.000Z",
    );
    assert.equal(normalized.piProviderId, "minimax-cn");
    assert.equal(normalized.protocolKind, "anthropic_messages");

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

test("the frozen provider binding keeps the connection's declared piProviderId", () => {
  const resolved = resolveModelRuntimeConfig({
    mode: "openai-compatible",
    env: { SYNECH_MODEL_API_KEY: "test-key" },
    modelProvider: {
      profileId: "deepseek",
      piProviderId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
    },
  });
  assert.equal(resolved.piProviderId, "deepseek");

  const binding = createFrozenProviderBinding({
    resolved,
    profileId: "deepseek",
    resolveApiKey: async () => "test-key",
  });
  // The live model facts must come from Pi's real catalog, not from the
  // unconfirmed-model fallback.
  assert.equal(binding.selectedModel.contextWindow, 1_000_000);
  assert.equal(binding.selectedModel.maxTokens, 384_000);
});

test("the panel provider market projects Pi provider identities without preloading models", () => {
  const market = modelProviderMarketPayload();
  const byId = new Map(market.presets.map((preset) => [preset.presetId, preset]));
  assert.equal(byId.size, market.presets.length, "provider preset ids must remain unique");

  const anthropic = byId.get("anthropic");
  assert.ok(anthropic, "Pi's Anthropic provider must be available in the product market");
  assert.equal(anthropic.piProviderId, "anthropic");
  assert.equal("knownModelIds" in anthropic, false);
  assert.equal(anthropic.protocolKind, "anthropic_messages");

  const openrouter = byId.get("openrouter");
  assert.ok(openrouter, "Pi's OpenRouter provider must be available in the product market");
  assert.equal("knownModelIds" in openrouter, false);
  assert.equal(openrouter.protocolKind, "openai_compatible_chat_completions");

  const openai = byId.get("openai");
  assert.equal("defaultModel" in openai, false);
});

test("an Anthropic Messages profile reloads without resetting the settings file", async () => {
  await withDirectory(async (directory) => {
    const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
    // Unrelated state written before the Anthropic profile. It must still be
    // present afterwards: a schema-level rejection here would quarantine the
    // whole settings document and silently rebuild defaults.
    await configCenter.updateModelProviderConfig({ profileId: "default", model: "marker-model" });
    await configCenter.createModelProviderProfile({
      profileId: "custom_anth",
      label: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      protocolKind: "anthropic_messages",
      model: "claude-haiku-4-5",
      piProviderId: "anthropic",
    });

    const reopened = createLocalConfigCenter({ configDirectory: directory }).configCenter;
    const profiles = await reopened.listModelProviderProfiles();
    const anthropic = profiles.find((profile) => profile.profileId === "custom_anth");
    assert.ok(anthropic, "the Anthropic profile must survive a reload");
    assert.equal(anthropic.protocolKind, "anthropic_messages");
    assert.equal(anthropic.defaultAiMode, "anthropic-messages");
    assert.equal(anthropic.piProviderId, "anthropic");
    assert.equal(
      (await reopened.getModelProviderConfig()).model,
      "marker-model",
      "an unrelated setting must not be reset when an Anthropic profile is stored",
    );
  });
});

async function withDirectory(operation) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synech-core-model-config-"));
  try { await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
}
