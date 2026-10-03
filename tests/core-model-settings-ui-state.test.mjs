import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { createServer } from "vite";

let server;
let projections;
let drafts;
let controllers;
let modelConfiguration;
let capabilityDisplay;
let modelOptions;

before(async () => {
  server = await createServer({
    configFile: false,
    root: path.resolve(import.meta.dirname, ".."),
    cacheDir: ".tmp/model-settings-test-cache",
    resolve: { alias: { "@panel-api": path.resolve(import.meta.dirname, "../src/app/panel-api") } },
    server: { middlewareMode: true, hmr: false, watch: null },
    logLevel: "error",
  });
  const settingsRoot = "/src/app/panel-ui/src/features/settings";
  projections = await server.ssrLoadModule(`${settingsRoot}/model/settings-projection.ts`);
  drafts = await server.ssrLoadModule(`${settingsRoot}/model/provider-projection-draft.ts`);
  controllers = await server.ssrLoadModule(`${settingsRoot}/controllers/model-controller.ts`);
  modelConfiguration = await server.ssrLoadModule(`${settingsRoot}/model/model-configuration-form.ts`);
  capabilityDisplay = await server.ssrLoadModule(`${settingsRoot}/model/capability-display.ts`);
  modelOptions = await server.ssrLoadModule(`${settingsRoot}/model/options.ts`);
});

after(async () => {
  await server?.close();
});

test("native environment credentials do not require a stored API key to select a model", () => {
  const ambient = { profileId: "bedrock-env", protocolKind: "native", piProviderId: "amazon-bedrock",
    connection: { authMode: "ambient" }, defaultAiMode: "native", secretConfigured: false,
    enabled: true, model: "anthropic.claude-sonnet-4-5-20250929-v1:0" };
  const config = { profiles: [ambient, { ...ambient, profileId: "missing-key", connection: { authMode: "api_key" } },
    { ...ambient, profileId: "disabled", enabled: false }] };
  const options = modelOptions.modelOptionsFromConfig(config, {});
  assert.equal(options.length, 1);
  assert.deepEqual(modelOptions.parseModelOptionId(options[0].id), { profileId: ambient.profileId, modelId: ambient.model });
});

test("advanced edits retain user overrides while automatic values stay live after save and reset", () => {
  const unknown = { facts: { status: "unconfirmed", modelId: "private-model" } };
  const initial = modelConfiguration.modelConfigurationDraft(undefined, unknown);
  assert.equal(initial.contextWindowTokens, "256000");
  assert.equal(modelConfiguration.modelConfigurationFromDraft(initial, unknown), null);
  const edited = {
    ...initial, contextWindowTokens: "64000", maxOutputTokens: "4096",
    supportsVisionInput: true, thinkingLevels: ["low", "high", "max"],
  };
  const saved = modelConfiguration.modelConfigurationFromDraft(edited, unknown);
  assert.equal(saved.overrides.contextWindowTokens, 64000);
  assert.equal(saved.overrides.maxOutputTokens, 4096);
  assert.equal(saved.overrides.supportsVisionInput, true);
  assert.deepEqual(saved.overrides.thinkingLevels, ["low", "high", "max"]);
  assert.deepEqual(modelConfiguration.modelConfigurationDraft(saved, unknown), edited);
  assert.equal(modelConfiguration.modelConfigurationDraft(undefined, unknown).contextWindowTokens, "256000");

  const confirmed = { facts: {
    ...unknown.facts, status: "confirmed", contextWindowTokens: 1_000_000, maxOutputTokens: 32000,
    supportsReasoningOutput: true, thinkingLevels: ["off", "minimal", "low", "high", "max"],
  } };
  const automatic = modelConfiguration.modelConfigurationDraft(undefined, confirmed);
  assert.equal(automatic.contextWindowTokens, "1000000");
  assert.equal(automatic.maxOutputTokens, "32000");
  assert.equal(modelConfiguration.modelConfigurationFromDraft(automatic, confirmed), null);
  assert.deepEqual(capabilityDisplay.runReasoningEffortOptions(confirmed), [
    { value: "low", label: "低" }, { value: "high", label: "高" }, { value: "max", label: "最高" },
  ]);
});

test("deleted model services cannot return through late editor drafts", () => {
  const profile = modelProfile("custom_a");
  const config = { config: profile, profiles: [profile] };
  const item = projections.modelProviderItems(config)[0];
  const form = { ...projections.modelFormFromProviderItem(item), baseUrl: "", piProviderId: "" };
  const submitted = drafts.profileDraftFromModelForm(form, item, false);
  assert.equal(submitted.baseUrl, "");
  assert.equal(submitted.piProviderId, undefined);

  const pending = { createdProfiles: [], editedProfiles: [submitted], removedProfileIds: [], activeProfile: submitted };
  const deleted = { profiles: [] };
  const reconciled = drafts.reconcileModelProviderProjectionDraft(pending, deleted);
  assert.equal(reconciled.editedProfiles.length, 0);
  assert.equal(reconciled.activeProfile, undefined);
  assert.equal(drafts.applyModelProviderProjectionDraft(deleted, pending).profiles.length, 0);
  assert.equal(drafts.applyModelProviderProjectionDraft(deleted, pending).config, undefined);

  const newerEdit = { ...submitted, label: "Newer edit" };
  const newer = { ...pending, editedProfiles: [newerEdit] };
  assert.equal(drafts.settleModelProviderProfileDraft(newer, submitted), newer);
  const newerCredential = { ...pending, editedProfiles: [{ ...submitted, secretConfigured: true }] };
  assert.equal(drafts.settleModelProviderProfileDraft(newerCredential, submitted), newerCredential);
  assert.equal(drafts.settleModelProviderProfileDraft(pending, submitted).editedProfiles.length, 0);
});

test("a failed deletion resynchronizes the active model after a successful fallback activation", async (t) => {
  const profileA = modelProfile("custom_a");
  const profileB = modelProfile("custom_b");
  let active = profileA;
  const snapshot = () => ({
    config: active,
    profiles: [profileA, profileB],
    modelCatalogs: [],
    modelProviderOrder: ["profile:custom_a", "profile:custom_b"],
  });
  const state = controllerState(snapshot(), projections.modelFormFromProviderItem(projections.modelProviderItems(snapshot())[0]));
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push([init?.method ?? "GET", url]);
    if (url === "/api/config") return Response.json(snapshot());
    if (url === "/api/config/model-profiles/custom_b/activate") {
      active = profileB;
      return Response.json({ config: active, profile: active });
    }
    assert.equal(url, "/api/config/model-profiles/custom_a");
    assert.equal(init.method, "DELETE");
    return Response.json({ error: { code: "delete_failed", message: "Delete failed" } }, { status: 500 });
  });

  await assert.rejects(controllers.createModelSettingsController(state.options)
    .deleteModelProvider("custom_a", "custom_b"), /Delete failed/);
  assert.equal(active.profileId, "custom_b");
  assert.equal(state.app.config.config.profileId, "custom_b");
  assert.equal(state.app.config.profiles.length, 2);
  assert.deepEqual(requests.map(([method]) => method), ["GET", "POST", "DELETE", "GET"]);
});

test("older save responses preserve newer edits and another service's credential-clear intent", async (t) => {
  const profile = modelProfile("custom_a");
  const config = { config: profile, profiles: [profile] };
  const submitted = projections.modelFormFromProviderItem(projections.modelProviderItems(config)[0]);
  let complete;
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => { complete = resolve; }));

  for (const current of [
    { ...submitted, label: "Newer label", apiKey: "synthetic-new-key" },
    { ...submitted, profileId: "custom_b", apiKey: "", apiKeyCleared: true, logoCleared: true },
  ]) {
    const state = controllerState(config, submitted);
    const saving = controllers.createModelSettingsController(state.options).saveModelConfig(submitted);
    await new Promise((resolve) => setImmediate(resolve));
    state.form = current;
    complete(Response.json({ config: profile, profiles: [profile] }));
    await saving;
    assert.deepEqual(state.form, current);
  }
});

function modelProfile(profileId) {
  return {
    profileId,
    label: profileId,
    providerKind: "openai_compatible",
    protocolKind: "openai_compatible_chat_completions",
    baseUrl: "https://example.invalid/v1",
    piProviderId: "openai",
    model: "synthetic-model",
    defaultAiMode: "openai-compatible",
    secretConfigured: false,
  };
}

function controllerState(config, form) {
  const state = { app: { config }, form };
  state.options = {
    app: state.app,
    modelForm: form,
    aiMode: "openai-compatible",
    mountedRef: { current: true },
    modelSaveQueueRef: { current: Promise.resolve() },
    setApp(update) { state.app = update(state.app); },
    setModelForm(update) { state.form = typeof update === "function" ? update(state.form) : update; },
    setModelCatalogs() {},
    setSavingModel() {},
  };
  return state;
}
