import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigCenter,
  ConfigCenterValidationError,
} from "../dist/app/config-center/index.js";

class MemorySettingsStore {
  value;
  writes = 0;
  readDelayMs = 0;

  async readSettings() {
    const snapshot = this.value === undefined ? undefined : structuredClone(this.value);
    if (this.readDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.readDelayMs));
    }
    return snapshot;
  }

  async writeSettings(settings) {
    this.value = structuredClone(settings);
    this.writes += 1;
  }
}

class MemorySecretStore {
  values = new Map();
  updatedAt = new Map();

  async getMetadata(secretRef) {
    return {
      configured: this.values.has(secretRef),
      updatedAt: this.updatedAt.get(secretRef),
    };
  }

  async readSecret(secretRef) {
    return this.values.get(secretRef);
  }

  async writeSecret(secretRef, value) {
    const updatedAt = new Date().toISOString();
    this.values.set(secretRef, value);
    this.updatedAt.set(secretRef, updatedAt);
    return { configured: true, updatedAt };
  }

  async deleteSecret(secretRef) {
    this.values.delete(secretRef);
    this.updatedAt.delete(secretRef);
    return { configured: false };
  }
}

async function createCenter() {
  const settingsStore = new MemorySettingsStore();
  const secretStore = new MemorySecretStore();
  const configCenter = new ConfigCenter({ settingsStore, secretStore });
  await configCenter.getModelProviderConfig();
  settingsStore.writes = 0;
  return { configCenter, settingsStore, secretStore };
}

test("ConfigCenter keeps model profile changes behind one settings write", async () => {
  const { configCenter, settingsStore, secretStore } = await createCenter();

  const created = await configCenter.createModelProviderProfile({
    profileId: "custom_local",
    label: "Local model",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "local-model",
    apiKey: "local-secret",
  });

  assert.equal(settingsStore.writes, 1);
  assert.equal(created.profileId, "custom_local");
  assert.equal(created.secretConfigured, true);
  assert.equal(await secretStore.readSecret(created.secretRef), "local-secret");

  settingsStore.writes = 0;
  const active = await configCenter.activateModelProviderProfile("custom_local");
  assert.equal(settingsStore.writes, 1);
  assert.equal(active.profileId, "custom_local");

  await assert.rejects(
    configCenter.deleteModelProviderProfile("custom_local"),
    (error) => error instanceof ConfigCenterValidationError && /active model profile/u.test(error.message),
  );
});

test("ConfigCenter keeps MCP cache only while connection settings stay unchanged", async () => {
  const { configCenter, settingsStore, secretStore } = await createCenter();
  const bearerRef = "secret://local-dev/mcp/demo/bearer";
  const headerRef = "secret://local-dev/mcp/demo/client";

  await configCenter.upsertMcpServer({
    serverId: "demo",
    commandLine: "node server.mjs",
    envSecretRefs: ["DEMO_TOKEN"],
    headerSecretRefs: [`X-Client=${headerRef}`],
    bearerTokenSecretRef: bearerRef,
    enabled: true,
  });
  assert.equal(settingsStore.writes, 1);

  await configCenter.writeMcpServerSecretValue({ serverId: "demo", secretRef: bearerRef, value: "bearer" });
  await configCenter.writeMcpServerSecretValue({ serverId: "demo", secretRef: headerRef, value: "client" });
  await secretStore.writeSecret("DEMO_TOKEN", "env-secret");
  await configCenter.updateMcpServerConnectionState({
    serverId: "demo",
    connectedAt: "2026-08-24T00:00:00.000Z",
    cachedTools: [{ name: "inspect", inputSchema: { type: "object" } }],
  });

  const renamed = await configCenter.upsertMcpServer({ serverId: "demo", label: "Demo server" });
  assert.equal(renamed[0].cachedTools?.[0]?.name, "inspect");

  const changed = await configCenter.upsertMcpServer({ serverId: "demo", commandLine: "node next-server.mjs" });
  assert.equal(changed[0].cachedTools, undefined);

  const runtime = await configCenter.createMcpRuntimeEnvironment({
    baseEnv: { DEMO_TOKEN: "run-value" },
  });
  assert.equal(runtime.DEMO_TOKEN, "run-value");
  assert.equal(runtime[bearerRef], "bearer");
  assert.equal(runtime[headerRef], "client");

  await assert.rejects(
    configCenter.writeMcpServerSecretValue({
      serverId: "demo",
      secretRef: "secret://local-dev/mcp/demo/undeclared",
      value: "ignored",
    }),
    (error) => error instanceof ConfigCenterValidationError && /not declared/u.test(error.message),
  );
});

test("ConfigCenter projects model runtime values without exposing the settings store", async () => {
  const { configCenter, secretStore } = await createCenter();
  const model = await configCenter.getModelProviderConfig();
  await secretStore.writeSecret(model.secretRef, "model-secret");
  await configCenter.updateInformationAccessConfig({ provider: "model_builtin" });

  const runtime = await configCenter.createModelRuntimeEnvironment();

  assert.equal(runtime.SYNECH_MODEL_API_KEY, "model-secret");
  assert.equal(runtime.SYNECH_MODEL_BUILTIN_WEB_SEARCH, "true");
  assert.equal(runtime.OPENAI_API_KEY, undefined);
});

test("ConfigCenter serializes concurrent read-modify-write mutations", async () => {
  const { configCenter, settingsStore } = await createCenter();
  settingsStore.readDelayMs = 20;

  await Promise.all([
    configCenter.updateToolState({ name: "Read", enabled: false }),
    configCenter.updateSkillTriggerConfig({ mode: "keyword" }),
  ]);

  assert.deepEqual(await configCenter.listToolStates(), [
    {
      name: "Read",
      enabled: false,
      updatedAt: settingsStore.value.toolStates[0].updatedAt,
    },
  ]);
  assert.equal((await configCenter.getSkillTriggerConfig()).mode, "keyword");
});
