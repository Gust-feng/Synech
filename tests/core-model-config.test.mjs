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
import { listPiProviderCatalog } from "../dist/adapters/intelligence/pi-model-catalog.js";
import { createNativeModelProviderCollection } from "../dist/adapters/intelligence/native-model-provider.js";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

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

test("the frozen provider binding keeps the connection's declared piProviderId", async () => {
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

  const binding = await createFrozenProviderBinding({
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
  assert.equal(anthropic.protocolKind, "native");

  const openrouter = byId.get("openrouter");
  assert.ok(openrouter, "Pi's OpenRouter provider must be available in the product market");
  assert.equal("knownModelIds" in openrouter, false);
  assert.equal(openrouter.protocolKind, "native");

  const openai = byId.get("openai");
  assert.equal("defaultModel" in openai, false);

  const providers = listPiProviderCatalog();
  assert.deepEqual(
    market.presets.map((preset) => preset.piProviderId).sort(),
    providers.map((provider) => provider.providerId).sort(),
    "each installed Pi provider must have its own service, including native, regional and plan variants",
  );
  const native = builtinModels();
  for (const preset of market.presets) {
    assert.deepEqual(preset.piProviderIds, [preset.piProviderId]);
    assert.ok(preset.brandId && preset.brandLabel && preset.serviceLabel);
    assert.equal(preset.protocolKind, "native");
    assert.equal(preset.baseUrl, native.getProvider(preset.piProviderId).baseUrl ?? "");
    assert.ok(preset.supportedAuthModes.includes(preset.connection.authMode));
    const collection = createNativeModelProviderCollection({
      ...preset,
      profileId: `coverage-${preset.presetId}`,
      credentialStore: {
        read: async () => undefined,
        modify: async (update) => update(undefined),
        delete: async () => {},
      },
    });
    const runtimeModels = collection.modelRegistry.getModels(collection.providerId);
    for (const model of runtimeModels) {
      const original = native.getModel(preset.piProviderId, model.id);
      assert.ok(original, `native model ${model.id} must have Pi provenance`);
      assert.equal(model.api, original.api);
      assert.equal(model.baseUrl, original.baseUrl, "default service URLs must not replace model-specific routes");
    }
  }
  assert.ok(byId.has("kimi-coding"));
  assert.ok(byId.has("moonshotai"));
  assert.equal(byId.get("minimax").piProviderId, "minimax-cn");
  assert.equal(byId.get("pi-minimax").piProviderId, "minimax");
  assert.equal(byId.get("openai").brandId, byId.get("openai-codex").brandId);
  assert.notEqual(byId.get("openai").serviceLabel, byId.get("openai-codex").serviceLabel);
  assert.equal(byId.get("google").brandId, byId.get("google-vertex").brandId);
  const drifted = modelProviderMarketPayload(providers.filter((provider) => provider.providerId !== "openai"));
  assert.ok(drifted.presets.some((preset) => preset.piProviderId === "google"));
  assert.equal(drifted.presets.some((preset) => preset.piProviderId === "openai"), false);
  assert.deepEqual(drifted.warnings.map((warning) => [warning.code, warning.presetId]), [
    ["model_service_unavailable", "openai"],
  ]);
});

test("native connection configuration reloads independently without exposing credentials", async () => {
  await withDirectory(async (directory) => {
    const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
    for (const [profileId, key, project] of [
      ["vertex-personal", "private-key-one", "personal-project"],
      ["vertex-work", "private-key-two", "work-project"],
    ]) {
      await configCenter.createModelProviderProfile(parseConfigUpdate({
        profileId,
        label: profileId,
        protocolKind: "native",
        piProviderId: "google-vertex",
        baseUrl: "",
        model: "gemini-2.5-pro",
        connection: { authMode: "api_key", cloudProject: project, cloudLocation: "global" },
        apiKey: key,
      }));
    }
    const reopened = createLocalConfigCenter({ configDirectory: directory }).configCenter;
    const profiles = await reopened.listModelProviderProfiles();
    for (const [id, key, project] of [
      ["vertex-personal", "private-key-one", "personal-project"],
      ["vertex-work", "private-key-two", "work-project"],
    ]) {
      const profile = profiles.find((item) => item.profileId === id);
      assert.equal(profile.protocolKind, "native");
      assert.equal(profile.defaultAiMode, "native");
      assert.equal(profile.connection.cloudProject, project);
      assert.equal(await reopened.getModelProviderApiKey(id), key);
      assert.equal(JSON.stringify(profiles).includes(key), false);
    }
    const resolved = resolveModelRuntimeConfig({
      mode: "native",
      env: {},
      modelProvider: { profileId: "cloud", piProviderId: "google-vertex", baseUrl: "", model: "gemini-2.5-pro", connection: { authMode: "ambient" } },
    });
    assert.equal(resolved.protocol, "native");
    assert.equal(resolved.baseUrl, "", "native connections must not inherit an OpenAI URL");
    await reopened.updateModelProviderConfig({
      profileId: "vertex-personal",
      connection: { authMode: "api_key", cloudProject: "renamed-project", cloudLocation: "global" },
    });
    assert.equal(await reopened.getModelProviderApiKey("vertex-personal"), "private-key-one",
      "editing public cloud parameters must not erase a saved API key");
    const custom = await reopened.createModelProviderProfile({
      profileId: "custom-empty-address", label: "Custom", model: "manual-model", apiKey: "custom-test-key",
    });
    assert.equal(custom.baseUrl, "");
    const env = await reopened.createModelRuntimeEnvironment({ modelProvider: custom });
    assert.throws(() => resolveModelRuntimeConfig({
      mode: "openai-compatible", env, modelProvider: custom,
    }), (error) => error.issue?.code === "missing_base_url");
    for (const baseUrl of ["not-a-url", "file:///private", "https://secret-user:secret-pass@example.invalid"]) {
      await assert.rejects(reopened.updateModelProviderConfig({
        profileId: custom.profileId, baseUrl,
      }), /HTTP\(S\)/);
    }
    assert.equal((await reopened.listModelProviderProfiles()).find((profile) => profile.profileId === custom.profileId).baseUrl, "");
  });
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
