import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { ConfigCenterValidationError, createLocalConfigCenter } from "../dist/app/config-center/index.js";
import { FileSystemLocalDevSecretStore, FileSystemLocalDevSecretStoreError } from "../dist/adapters/config/index.js";
import { parseModelConfigurationUpdate } from "../dist/app/panel-server/request-parsers.js";
import { handlePanelModelConfigRoute } from "../dist/app/panel-server/settings/model-config-routes.js";
import { compactOrdinaryRunStorage, createFileSystemOrdinaryRunRepository, OrdinaryRunSnapshotIncompatibleError } from "../dist/app/ordinary-agent/file-system-repository.js";
import { createInitialOrdinaryRunState } from "../dist/app/ordinary-agent/state.js";
import { ConfigSchemaValidationError, normalizeLocalSettings, parseLocalSettingsFile } from "../dist/app/config-center/settings-schema.js";
import { CapabilityCenter } from "../dist/app/capability/capability-center.js";
import { resolveModelCapabilitiesForProfile } from "../dist/app/panel-server/settings/model-facts.js";
import { prepareOrdinaryRunBirth } from "../dist/app/panel-server/ordinary-run-birth.js";
import { ORDINARY_AGENT } from "../dist/app/agent-prompts/ordinary-agent.js";

test("a per-run visual model assembles image tools without changing the global text model", async () => {
  await withDirectory(async (directory) => {
    const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
    const global = await configCenter.getModelProviderConfig();
    await configCenter.updateModelProviderConfig({ profileId: global.profileId, model: "private-text" });
    await configCenter.updateModelConfiguration({
      profileId: global.profileId, modelId: "private-text",
      settings: { overrides: { supportsVisionInput: false } },
    });
    await configCenter.createModelProviderProfile({
      profileId: "run_visual", baseUrl: "https://vision.example.invalid/v1", apiKey: "test-key",
    });
    await configCenter.updateModelProviderConfig({ profileId: "run_visual", model: "private-visual" });
    await configCenter.updateModelConfiguration({
      profileId: "run_visual", modelId: "private-visual",
      settings: { overrides: { supportsVisionInput: true } },
    });
    const capabilities = new CapabilityCenter({ configCenter, skillRoots: [], resolveModelCapabilities: resolveModelCapabilitiesForProfile });
    const text = await capabilities.snapshot({ executionRoot: directory });
    assert.equal(text.toolCatalog.allowedTools.includes("ViewImage"), false);
    const birth = await prepareOrdinaryRunBirth({
      configCenter, capabilityCenter: capabilities,
      ordinaryAgentDefinition: ORDINARY_AGENT, agentDefinitionOverrides: new Map(),
      spaceFeature: { queries: { async getTree() {
        return { space: { title: "Test project" } };
      } } },
      spaceConversationDeletion: { assertAvailable() {} },
      productPaths: { data: { spaces: { files: directory } } },
      collaborationRulesApplication: { async startupSnapshot() { return {}; } },
    }, {
      owner: { kind: "space", id: "space-1" },
      userMessage: "Inspect image.png", modelOverride: { profileId: "run_visual", model: "private-visual" },
    });
    const visual = birth.capabilitySnapshot;
    assert.equal(visual.activeModel.profileId, "run_visual");
    assert.ok(visual.toolCatalog.allowedTools.includes("ViewImage"));
    assert.ok(visual.toolCatalog.allowedTools.includes("AttachmentReadImage"));
    assert.equal((await configCenter.getModelProviderConfig()).profileId, global.profileId);
    assert.equal((await capabilities.snapshot({ executionRoot: directory })).toolCatalog.allowedTools.includes("ViewImage"), false);
  });
});

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

test("per-model replacement and reset preserve concurrent settings across discovery and restart", async () => {
  await withDirectory(async (directory) => {
    const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
    await configCenter.createModelProviderProfile({
      profileId: "custom_gateway", baseUrl: "https://gateway.example.invalid/v1", apiKey: "test-key",
    });
    const credentialStore = await configCenter.createModelProviderCredentialStore("custom_gateway");
    const settingsA = {
      overrides: { contextWindowTokens: 128000, thinkingLevels: ["low", "high", "high", "max"] },
    };
    const settingsB = { overrides: { maxOutputTokens: 4096, supportsVisionInput: false, supportsReasoningOutput: false, thinkingLevels: [] } };
    await Promise.all([
      configCenter.updateModelConfiguration({ profileId: " CUSTOM_GATEWAY ", modelId: " vendor/model-a ", settings: settingsA }),
      configCenter.updateModelConfiguration({ profileId: "custom_gateway", modelId: "__proto__", settings: settingsB }),
      configCenter.updateModelProviderConfig({ profileId: "custom_gateway", label: "Renamed gateway" }),
    ]);
    const expected = Object.fromEntries([
      ["vendor/model-a", {
        overrides: { contextWindowTokens: 128000, thinkingLevels: ["low", "high", "max"] },
      }],
      ["__proto__", settingsB],
    ]);
    const catalog = {
      profileId: "custom_gateway", baseUrl: "https://gateway.example.invalid/v1",
      modelsPath: "/models", fetchedAt: "2026-10-01T00:00:00.000Z",
      models: [{ id: "vendor/model-a", displayName: "Model A" }],
    };
    await configCenter.upsertModelProviderModelCatalog(catalog);
    await configCenter.upsertModelProviderModelCatalog({ ...catalog, models: [] });
    const reopened = createLocalConfigCenter({ configDirectory: directory }).configCenter;
    const profiles = await reopened.listModelProviderProfiles();
    const saved = profiles.find((profile) => profile.profileId === "custom_gateway");
    assert.deepEqual(saved.modelSettings, expected);
    assert.equal(Object.hasOwn(saved.modelSettings, "__proto__"), true);
    assert.equal(Object.hasOwn(saved.modelSettings, "constructor"), false);
    assert.equal(saved.label, "Renamed gateway");
    assert.equal((await reopened.getModelProviderConfig()).modelSettings, undefined);
    assert.deepEqual(await reopened.listModelProviderModelCatalogs(), []);
    assert.equal(await reopened.getModelProviderApiKey("custom_gateway"), "test-key");
    assert.deepEqual(await credentialStore.read(), { type: "api_key", key: "test-key" });

    const empty = await reopened.updateModelConfiguration({
      profileId: "custom_gateway", modelId: "vendor/model-a", settings: {},
    });
    assert.deepEqual(empty.modelSettings, Object.fromEntries([["__proto__", settingsB], ["vendor/model-a", {}]]));
    // Replacement removes previous fields; it does not merge an old whole-profile map.
    await reopened.updateModelConfiguration({
      profileId: "custom_gateway", modelId: "vendor/model-a", settings: { overrides: { supportsVisionInput: true } },
    });
    const request = Readable.from([JSON.stringify({ modelId: "__proto__", settings: null })]);
    request.method = "POST";
    let payload;
    let invalidated = false;
    const snapshot = { snapshotId: "refreshed-capabilities" };
    const runtime = {
      configCenter: reopened,
      capabilityCenter: {
        invalidate() { invalidated = true; },
        async snapshot() { assert.equal(invalidated, true); return snapshot; },
      },
    };
    assert.equal(await handlePanelModelConfigRoute(runtime, request, {
      writeHead(status) { assert.equal(status, 200); },
      end(body) { payload = JSON.parse(body); },
    }, new URL("http://localhost/api/config/model-profiles/custom_gateway/model-settings")), true);
    assert.equal(payload.config.profileId, "default", "updating another profile must not activate it");
    assert.deepEqual(payload.profile.modelSettings, { "vendor/model-a": { overrides: { supportsVisionInput: true } } });
    assert.deepEqual(payload.capabilities, snapshot);
    assert.ok(Array.isArray(payload.profiles) && Array.isArray(payload.modelCatalogs) && Array.isArray(payload.modelCapabilityProfiles));
    await reopened.updateModelConfiguration({
      profileId: "custom_gateway", ...parseModelConfigurationUpdate({ modelId: "vendor/model-a" }),
    });
    const final = createLocalConfigCenter({ configDirectory: directory }).configCenter;
    assert.equal((await final.listModelProviderProfiles()).find((profile) => profile.profileId === "custom_gateway").modelSettings, undefined);
    const persisted = JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8"));
    assert.equal(persisted.version, 1);
    assert.equal(Object.hasOwn(persisted.modelProfiles.find((profile) => profile.profileId === "custom_gateway"), "modelSettings"), false);
    assert.equal((await readdir(directory)).some((name) => name.includes(".corrupt-")), false);
  });
});

test("invalid model configuration is rejected before it can change durable settings", async () => {
  await withDirectory(async (directory) => {
    const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
    await configCenter.getModelProviderConfig();
    await configCenter.createModelProviderProfile({
      profileId: "custom_native", protocolKind: "native", piProviderId: "openai",
      connection: { authMode: "api_key" }, apiKey: "native-test-key",
    });
    const credentials = await configCenter.createModelProviderCredentialStore("custom_native");
    const native = await configCenter.updateModelConfiguration({
      profileId: "custom_native", modelId: "model", settings: { overrides: { supportsVisionInput: true } },
    });
    assert.deepEqual(native.modelSettings, { model: { overrides: { supportsVisionInput: true } } });
    assert.deepEqual(await credentials.read(), { type: "api_key", key: "native-test-key" });
    const before = await readFile(path.join(directory, "settings.json"), "utf8");
    await assert.rejects(configCenter.updateModelConfiguration({
      profileId: "custom_native", modelId: "model",
      settings: { catalogModel: { providerId: "anthropic", modelId: "claude" } },
    }), ConfigCenterValidationError);
    for (const settings of [
      null, [], "invalid",
      { catalogModel: { providerId: " ", modelId: "model" } },
      { catalogModel: { providerId: "provider", modelId: 3 } },
      { overrides: { contextWindowTokens: 1.5 } },
      { overrides: { contextWindowTokens: Number.MAX_SAFE_INTEGER + 1 } },
      { overrides: { contextWindowTokens: "128000" } },
      { overrides: { maxOutputTokens: 0 } },
      { overrides: { supportsVisionInput: "true" } },
      { overrides: { supportsReasoningOutput: null } },
      { overrides: { thinkingLevels: ["off"] } },
      { overrides: { thinkingLevels: ["minimal"] } },
      { overrides: { thinkingLevels: "high" } },
      { overrides: { arbitraryRequestField: true } },
      { apiKey: "must-not-persist" },
    ]) {
      await assert.rejects(configCenter.updateModelConfiguration({
        profileId: "default", modelId: "model", settings,
      }), ConfigCenterValidationError);
      if (settings !== null) {
        assert.throws(() => parseModelConfigurationUpdate({ modelId: "model", settings }),
          (error) => error.statusCode === 400 && error.code === "invalid_model_configuration");
      }
    }
    await assert.rejects(configCenter.updateModelConfiguration({ profileId: "missing", modelId: "model" }), ConfigCenterValidationError);
    assert.throws(() => parseModelConfigurationUpdate({ modelId: " " }), (error) => error.statusCode === 400);
    assert.equal(await readFile(path.join(directory, "settings.json"), "utf8"), before);

    const corrupt = JSON.parse(before);
    const profile = corrupt.modelProfiles.find((item) => item.profileId === "custom_native");
    profile.modelSettings = Object.fromEntries([
      ["__proto__", { catalogModel: { providerId: "anthropic", modelId: "claude" } }],
    ]);
    const settingsPath = path.join(directory, "settings.json");
    const corruptJson = JSON.stringify(corrupt);
    await writeFile(settingsPath, corruptJson, "utf8");
    const diskSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.throws(() => parseLocalSettingsFile(diskSettings), ConfigSchemaValidationError);
    assert.throws(() => normalizeLocalSettings(diskSettings), ConfigSchemaValidationError);
    assert.equal(await readFile(settingsPath, "utf8"), corruptJson);
  });
});

test("Ordinary frozen settings round-trip and reject invalid capability configuration on read", async () => {
  await withDirectory(async (directory) => {
    const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
    const configuration = { overrides: { contextWindowTokens: 128000, thinkingLevels: ["low", "high", "max"] } };
    const configured = await configCenter.updateModelConfiguration({ profileId: "default", modelId: "__proto__", settings: configuration });
    const config = { ...configured, model: "__proto__", logoDataUrl: `data:image/png;base64,${"A".repeat(400_000)}`,
      modelSettings: Object.fromEntries([["__proto__", configuration], ["other-model", { overrides: { contextWindowTokens: 8192 } }]]) };
    const now = "2026-10-01T00:00:00.000Z";
    const modelCapabilities = {
      facts: { status: "unconfirmed", modelId: "__proto__" },
      configuration, transport: "openai_responses",
    };
    const state = createInitialOrdinaryRunState({
      runId: "frozen-model-settings", eventId: "created", recordedAt: now,
      sessionRef: { sessionId: "session", storageKey: "session", sessionCwd: directory, createdAt: now },
      turn: { conversationId: "conversation", ordinal: 1, userTurnId: "user", assistantTurnId: "assistant" },
      runInput: { userMessage: "test" },
      birth: {
        instructions: "", aiMode: "openai-responses", config,
        agentDefinitionRef: {
          agentId: "ordinary", agentDisplayName: "Ordinary", promptRef: "ordinary", promptVersion: "v1",
          outputContractId: "ordinary", toolVisibilityProfileId: "ordinary",
        },
        capabilitySnapshot: {
          snapshotId: "snapshot", createdAt: now, activeModel: config, modelCapabilities,
          toolCatalog: { scope: "agent-basic", tools: [], allowedTools: [] },
          skillCatalog: [], subAgentCatalog: [], mcpCatalog: [], executionRoot: directory, warnings: [],
        },
        memoryOwner: { kind: "space", id: "space" },
        informationAccess: { web: { provider: "none", maxResults: 0, secretConfigured: false, status: "disabled", updatedAt: now } },
        accessPolicy: { approvalMode: "prompt", filesystemScope: "owner_only" },
      },
    });
    await createFileSystemOrdinaryRunRepository(directory).save(state, 0);
    const repository = createFileSystemOrdinaryRunRepository(directory);
    const saved = await repository.get(state.runId);
    assert.deepEqual(saved.state.birth.config.modelSettings, Object.fromEntries([["__proto__", configuration]]));
    assert.deepEqual(saved.state.birth.capabilitySnapshot.modelCapabilities, modelCapabilities);
    const snapshotPath = path.join(directory, "runs", state.runId, "snapshot.json");
    assert.equal(saved.state.birth.config.logoDataUrl, undefined);
    assert.equal(saved.state.birth.capabilitySnapshot.activeModel.logoDataUrl, undefined);
    assert.deepEqual(Object.keys(saved.state.birth.capabilitySnapshot.activeModel.modelSettings), ["__proto__"]);
    assert.equal((await readFile(snapshotPath, "utf8")).includes("logoDataUrl"), false);
    // Explicit maintenance reads the shared DTO, validates, backs up and preserves semantic revisions.
    const oldDocument = structuredClone(saved);
    oldDocument.state.birth.config.logoDataUrl = config.logoDataUrl;
    oldDocument.state.birth.capabilitySnapshot.activeModel.logoDataUrl = config.logoDataUrl;
    const oldJson = JSON.stringify(oldDocument, null, 2);
    await writeFile(snapshotPath, oldJson, "utf8");
    const backupRoot = path.join(directory, "maintenance-backup");
    const compacted = await compactOrdinaryRunStorage(directory, backupRoot);
    assert.equal(compacted.count, 1);
    assert.ok(compacted.bytesAfter < compacted.bytesBefore / 10);
    assert.equal(await readFile(path.join(backupRoot, state.runId, "snapshot.json"), "utf8"), oldJson);
    assert.deepEqual(await repository.get(state.runId), saved);
    const birthPath = path.join(directory, "runs", state.runId, "birth.json");
    const storedBirth = JSON.parse(await readFile(birthPath, "utf8"));
    const storedSnapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    assert.equal(storedSnapshot.state.birth, undefined);
    assert.equal(storedBirth.birth.capabilitySnapshot.activeModel, undefined);
    assert.deepEqual(storedBirth.birth.model.modelSettings, saved.state.birth.config.modelSettings);
    const birthStat = await (await import("node:fs/promises")).stat(birthPath, { bigint: true });
    await repository.save({ ...saved.state, visibleAssistantText: "Visible progress", timestamps: { ...saved.state.timestamps, updatedAt: "2026-10-01T00:00:01.000Z" } }, saved.revision);
    assert.equal((await (await import("node:fs/promises")).stat(birthPath, { bigint: true })).mtimeNs, birthStat.mtimeNs);
    assert.deepEqual(JSON.parse(await readFile(birthPath, "utf8")), storedBirth);
    await assert.rejects(repository.save({ ...saved.state, birth: { ...saved.state.birth, instructions: "Changed frozen instructions" } }, 2), (error) => error.code === "ordinary_run_state_conflict");
    for (const corrupt of [
      (document) => { document.birth.model.modelSettings.__proto__.overrides.maxOutputTokens = -1; },
      (document) => { document.birth.capabilitySnapshot.modelCapabilities.configuration.overrides.thinkingLevels = ["off"]; },
      (document) => { document.birth.model.apiKey = "must-not-freeze"; },
      (document) => { document.birth.capabilitySnapshot.modelCapabilities.transport = "invalid"; },
      (document) => { document.runId = "another-run"; },
    ]) {
      const document = structuredClone(storedBirth);
      corrupt(document);
      await writeFile(birthPath, JSON.stringify(document), "utf8");
      await assert.rejects(repository.get(state.runId), OrdinaryRunSnapshotIncompatibleError);
    }
    await writeFile(birthPath, JSON.stringify(storedBirth), "utf8");
    // The state commit without its birth cannot be loaded as a partial run.
    await rm(birthPath);
    await assert.rejects(repository.get(state.runId), OrdinaryRunSnapshotIncompatibleError);
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
    const store = new FileSystemLocalDevSecretStore(directory);
    for (const file of [
      { version: 1, secrets: { old: { value: "keep" } }, updatedAt: "2026-09-30T00:00:00.000Z" },
      { version: 1, secrets: { old: { value: "keep", updatedAt: "2026-09-30T00:00:00.000Z" } }, updatedAt: "invalid-date" },
    ]) {
      const invalid = JSON.stringify(file);
      await writeFile(secretsPath, invalid, "utf8");
      await assert.rejects(store.writeSecret("new", "value"), (error) => error instanceof FileSystemLocalDevSecretStoreError);
      assert.equal(await readFile(secretsPath, "utf8"), invalid);
    }
  });
});

test("secret revisions remain distinct across rapid writes, clock rollback and recreation", async (t) => {
  await withDirectory(async (directory) => {
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    const store = new FileSystemLocalDevSecretStore(directory);
    const first = await store.writeSecret("connection", "first-test-value");
    const second = await store.writeSecret("connection", "second-test-value");
    assert.ok(Date.parse(second.updatedAt) > Date.parse(first.updatedAt));
    clock -= 60_000;
    await store.deleteSecret("connection");
    const recreated = await new FileSystemLocalDevSecretStore(directory).writeSecret("connection", "replacement-test-value");
    assert.ok(Date.parse(recreated.updatedAt) > Date.parse(second.updatedAt));
    assert.equal(await store.readSecret("connection"), "replacement-test-value");
  });
});

async function withDirectory(operation) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synech-core-config-"));
  try { await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
}
