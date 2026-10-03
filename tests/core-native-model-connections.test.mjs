import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai";

import { ConfigCenter, createLocalConfigCenter } from "../dist/app/config-center/index.js";
import { ConfigCenterValidationError } from "../dist/app/config-center/config-center-error.js";
import { createModelProviderAuthApplication } from "../dist/app/panel-server/composition/model-provider-auth-runtime.js";
import {
  createNativeModelProviderCollection,
  nativeModelProviderRegistryId,
} from "../dist/adapters/intelligence/native-model-provider.js";
import { providerFailureFromAssistant } from "../dist/adapters/intelligence/provider-result-projection.js";

// Use coordinator-built dist. Pi login callbacks are simulated, not live-account smoke.
test("Bedrock failures retain structured authentication, throttling and timeout facts", () => {
  for (const [details, expected] of [
    [{ status: 403, errorCode: "AccessDeniedException" }, "provider_auth"],
    [{ status: 429, errorCode: "ThrottlingException" }, "provider_rate_limit"],
    [{ status: 504, errorCode: "ModelTimeoutException" }, "provider_timeout"],
    [{ errorCode: "permission_denied" }, "provider_auth"],
  ]) {
    const message = failedAssistant([
      { type: "bedrock_response_failure", timestamp: 1, details },
      { type: "unrelated_diagnostic", timestamp: 2, details: {} },
    ]);
    const failure = providerFailureFromAssistant(message, 100_000);
    assert.equal(failure.errorCode, expected);
    assert.equal(failure.error, message.errorMessage);
  }
  const unstructured = failedAssistant([]);
  unstructured.errorMessage = "403 AccessDeniedException";
  assert.equal(providerFailureFromAssistant(unstructured, 100_000).errorCode, "provider_response");
});

test("Pi login credentials persist per connection and never appear in public profiles or login responses", async (t) => {
  await withConfig(async ({ configCenter, auth, directory }) => {
    const firstId = "custom_native_first";
    const secondId = "custom_native_second";
    const firstCredential = credential("first-private-token");
    const secondCredential = credential("second-private-token");
    simulatePiLogins(t, {
      [firstId]: async (interaction) => {
        await interaction.prompt({ type: "manual_code", message: "Enter test authorization code" });
        return firstCredential;
      },
      [secondId]: async () => secondCredential,
    });
    await createProfile(configCenter, firstId);
    await createProfile(configCenter, secondId);
    const login = await auth.login(firstId);
    const pending = await waitForAuth(auth, firstId, (response) => response.authSession?.prompt !== undefined);
    assert.equal(pending.authSession.sessionId, login.authSession.sessionId);
    const responded = await auth.respond(firstId, {
      sessionId: pending.authSession.sessionId,
      promptId: pending.authSession.prompt.promptId,
      value: "private-authorization-code",
    });
    const completed = await waitForAuth(auth, firstId, (response) => response.authSession?.status === "completed");
    await auth.login(secondId);
    await waitForAuth(auth, secondId, (response) => response.authSession?.status === "completed");
    assert.equal(completed.configured, true);

    const reopened = createLocalConfigCenter({ configDirectory: directory }).configCenter;
    assert.deepEqual(await (await reopened.createModelProviderCredentialStore(firstId)).read(), firstCredential);
    assert.deepEqual(await (await reopened.createModelProviderCredentialStore(secondId)).read(), secondCredential);
    assert.equal(await reopened.getModelProviderApiKey(firstId), undefined);
    const profiles = await reopened.listModelProviderProfiles();
    const publicPayload = JSON.stringify([login, pending, responded, completed, profiles]);
    for (const secret of [firstCredential.access, firstCredential.refresh, secondCredential.access, "private-authorization-code"]) {
      assert.equal(publicPayload.includes(secret), false);
      assert.equal((await readFile(path.join(directory, "settings.json"), "utf8")).includes(secret), false);
    }

    await auth.logout(firstId);
    assert.equal(await (await configCenter.createModelProviderCredentialStore(firstId)).read(), undefined);
    assert.deepEqual(await (await configCenter.createModelProviderCredentialStore(secondId)).read(), secondCredential);
  });
});

test("switching authentication modes preserves both stored credentials", async (t) => {
  await withConfig(async ({ configCenter, auth, directory }) => {
    const profileId = "custom_native_modeswitch";
    const oauthCredential = credential("mode-switch-oauth-token");
    simulatePiLogins(t, {
      [profileId]: async () => oauthCredential,
    });
    await createProfile(configCenter, profileId);
    await auth.login(profileId);
    await waitForAuth(auth, profileId, (response) => response.authSession?.status === "completed");
    assert.deepEqual(await (await configCenter.createModelProviderCredentialStore(profileId)).read(), oauthCredential);

    // 账号登录 → API Key：OAuth 凭据必须保留。
    await configCenter.updateModelProviderConfig({
      profileId,
      connection: { authMode: "api_key" },
      apiKey: "mode-switch-api-key",
    });
    assert.equal(await configCenter.getModelProviderApiKey(profileId), "mode-switch-api-key");
    const profilesInApiKeyMode = await configCenter.listModelProviderProfiles();
    assert.equal(profilesInApiKeyMode.find((profile) => profile.profileId === profileId)?.secretConfigured, true);

    // API Key → 账号登录：无需重新登录，凭据原样恢复。
    await configCenter.updateModelProviderConfig({ profileId, connection: { authMode: "oauth" } });
    assert.equal(await configCenter.getModelProviderApiKey(profileId), undefined,
      "an OAuth-mode connection must not surface the API key slot");
    assert.deepEqual(await (await configCenter.createModelProviderCredentialStore(profileId)).read(), oauthCredential);
    const profilesInOAuthMode = await configCenter.listModelProviderProfiles();
    assert.equal(profilesInOAuthMode.find((profile) => profile.profileId === profileId)?.secretConfigured, true);

    // 再切回 API Key：两边凭据都还在。
    await configCenter.updateModelProviderConfig({ profileId, connection: { authMode: "api_key" } });
    assert.equal(await configCenter.getModelProviderApiKey(profileId), "mode-switch-api-key");
    const secretsFile = await readFile(path.join(directory, "local-dev-secrets.json"), "utf8");
    assert.ok(secretsFile.includes("mode-switch-oauth-token"), "the OAuth credential must survive mode switches");
    assert.ok(secretsFile.includes("mode-switch-api-key"));
  });
});

test("Copilot default account prompts lead to browser authorization without coupling login to browser availability", async (t) => {
  for (const scenario of ["opened", "browser-failed", "unsafe-url", "embedded-credentials"]) {
    await t.test(scenario, async (t) => {
      const opened = [];
      const authorizationUrl = scenario === "unsafe-url"
        ? "file:///C:/Windows/System32/calc.exe"
        : scenario === "embedded-credentials"
          ? "https://user:password@github.com/login/device" : "https://github.com/login/device";
      await withConfig(async ({ configCenter, auth }) => {
        const profileId = "copilot-default-account";
        simulatePiLogins(t, {
          [profileId]: async (interaction) => {
            const domain = await interaction.prompt({
              type: "text", message: "GitHub account domain", placeholder: "company.ghe.com",
            });
            assert.equal(domain, "");
            interaction.notify({
              type: "device_code", verificationUri: authorizationUrl, userCode: "TEST-CODE",
            });
            interaction.notify({ type: "auth_url", url: authorizationUrl });
            await interaction.prompt({ type: "manual_code", message: "Complete test authorization" });
            return credential("copilot-authorized");
          },
        });
        await createProfile(configCenter, profileId, "github-copilot");
        await auth.login(profileId);
        const pending = await waitForAuth(auth, profileId, (response) => response.authSession?.prompt?.type === "text");
        await auth.respond(profileId, {
          sessionId: pending.authSession.sessionId, promptId: pending.authSession.prompt.promptId, value: "",
        });
        const authorizing = await waitForAuth(auth, profileId, (response) =>
          response.authSession?.prompt?.type === "manual_code" &&
          (scenario === "opened" || response.authSession.events.some((event) => event.type === "info")),
        );
        assert.deepEqual(opened, scenario === "unsafe-url" || scenario === "embedded-credentials"
          ? [] : [{ kind: "url", value: authorizationUrl }]);
        assert.equal(JSON.stringify(authorizing).includes("private-browser-error"), false);
        await auth.respond(profileId, {
          sessionId: authorizing.authSession.sessionId,
          promptId: authorizing.authSession.prompt.promptId,
          value: "test-authorization",
        });
        const completed = await waitForAuth(auth, profileId, (response) => response.authSession?.status === "completed");
        assert.equal(completed.configured, true);
      }, undefined, async (target) => {
        opened.push(target);
        if (scenario === "browser-failed") throw new Error("private-browser-error");
      });
    });
  }
});

test("cancelling a pending login rejects stale prompts, browser notifications and a late Pi provider credential", async (t) => {
  const opened = [];
  await withConfig(async ({ configCenter, auth, directory }) => {
    const profileId = "custom_native_cancel";
    const providerEntered = deferred();
    const providerResult = deferred();
    simulatePiLogins(t, {
      [profileId]: async (interaction) => {
        providerEntered.resolve();
        // Deliberately ignore abort: the runtime/store must reject late publication.
        const result = await providerResult.promise;
        interaction.notify({ type: "auth_url", url: "https://github.com/login/device" });
        return result;
      },
    });
    await createProfile(configCenter, profileId);
    try {
      const login = await auth.login(profileId);
      await providerEntered.promise;
      const cancelled = await auth.cancel(profileId, login.authSession.sessionId);
      assert.equal(cancelled.authSession.status, "cancelled");
      await assert.rejects(auth.respond(profileId, {
        sessionId: login.authSession.sessionId,
        promptId: "expired-prompt",
        value: "stale-code",
      }), (error) => error.code === "model_auth_session_stale");
      providerResult.resolve(credential("late-private-token"));
      await providerResult.promise;
      const status = await auth.status(profileId);
      assert.equal(status.authSession.status, "cancelled");
      assert.equal(status.configured, false);
      const reopened = createLocalConfigCenter({ configDirectory: directory }).configCenter;
      assert.equal(await (await reopened.createModelProviderCredentialStore(profileId)).read(), undefined);
    } finally {
      providerResult.resolve(credential("late-private-token"));
    }
  }, undefined, async (target) => { opened.push(target); });
  assert.deepEqual(opened, []);
});

test("cancellation during the final async identity check prevents credential publication", async () => {
  let settings;
  const secrets = new Map();
  const controller = new AbortController();
  let cancelOnRead = false;
  let publicationStarted = false;
  const center = new ConfigCenter({
    settingsStore: {
      readSettings: async () => {
        if (cancelOnRead) {
          cancelOnRead = false;
          controller.abort(new Error("Test cancel during identity read"));
        }
        return settings === undefined ? undefined : structuredClone(settings);
      },
      writeSettings: async (next) => { settings = structuredClone(next); },
    },
    secretStore: {
      readSecret: async (ref) => secrets.get(ref)?.value,
      getMetadata: async (ref) => secrets.has(ref)
        ? { configured: true, updatedAt: secrets.get(ref).updatedAt } : { configured: false },
      writeSecret: async (ref, value) => {
        const updatedAt = new Date().toISOString();
        secrets.set(ref, { value, updatedAt });
        return { configured: true, updatedAt };
      },
      deleteSecret: async (ref) => { secrets.delete(ref); return { configured: false }; },
    },
  });
  await createProfile(center, "final-cancel-test");
  const store = await center.createModelProviderCredentialStore("final-cancel-test", {
    rotateRevisionOnWrite: true,
    onPublicationStarted: () => { publicationStarted = true; },
  });
  await assert.rejects(store.modify(async () => {
    cancelOnRead = true;
    return credential("never-published-test-token");
  }, { signal: controller.signal }), /Test cancel during identity read/);
  assert.equal(publicationStarted, false);
  assert.equal(await store.read(), undefined);
});

test("login diagnostics retain the cause but redact provider messages and authorization data", async (t) => {
  const diagnostics = [];
  const original = Object.assign(new Error("private-test-token code=private-authorization-code"), { code: "ECONNRESET" });
  await withConfig(async ({ configCenter, auth }) => {
    const id = "safe-diagnostic-test";
    await createProfile(configCenter, id);
    simulatePiLogins(t, { [id]: async () => { throw original; } });
    await auth.login(id);
    const failed = await waitForAuth(auth, id, (response) => response.authSession?.status === "failed");
    assert.equal(failed.authSession.error.code, "model_auth_network");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].diagnostic.code, "model_auth_network");
    let cause = diagnostics[0].failure;
    while (cause instanceof Error && cause !== original) cause = cause.cause;
    assert.equal(cause, original);
    const publicData = JSON.stringify([failed, diagnostics.map((item) => item.diagnostic)]);
    assert.equal(publicData.includes("private-test-token"), false);
    assert.equal(publicData.includes("private-authorization-code"), false);
  }, (diagnostic, failure) => diagnostics.push({ diagnostic, failure }));
});

test("in-flight credential refresh cannot publish after login cancellation or profile deletion and recreation", async (t) => {
  for (const action of ["cancel", "delete"]) {
    await t.test(action, async (t) => {
      await withConfig(async ({ configCenter, auth, directory }) => {
        const profileId = "custom_native_revoked";
        const providerEntered = deferred();
        const providerResult = deferred();
        const refreshEntered = deferred();
        const finishRefresh = deferred();
        simulatePiLogins(t, {
          [profileId]: async () => {
            providerEntered.resolve();
            return providerResult.promise;
          },
        });
        await createProfile(configCenter, profileId);
        await (await configCenter.createModelProviderCredentialStore(profileId))
          .modify(async () => credential("original-private-token"));
        const login = await auth.login(profileId);
        await providerEntered.promise;
        const obsoleteStore = await configCenter.createModelProviderCredentialStore(profileId);
        const refresh = obsoleteStore.modify(async (current) => {
          assert.equal(current.access, "original-private-token");
          refreshEntered.resolve();
          await finishRefresh.promise;
          return credential("stale-refreshed-token");
        });
        const rejectedRefresh = assert.rejects(refresh, ConfigCenterValidationError);
        try {
          await refreshEntered.promise;
          if (action === "cancel") {
            await auth.cancel(profileId, login.authSession.sessionId);
          } else {
            await auth.deleteProfile(profileId);
            assert.equal((await configCenter.listModelProviderProfiles()).some((profile) => profile.profileId === profileId), false);
            await createProfile(configCenter, profileId);
          }
          const currentCredential = credential("replacement-private-token");
          const currentStore = await configCenter.createModelProviderCredentialStore(profileId);
          const replacement = currentStore.modify(async () => currentCredential);
          finishRefresh.resolve();
          await rejectedRefresh;
          await replacement;
          providerResult.resolve(credential("stale-login-token"));
          await providerResult.promise;
          await assert.rejects(obsoleteStore.read(), ConfigCenterValidationError);
          const reopened = createLocalConfigCenter({ configDirectory: directory }).configCenter;
          assert.deepEqual(await (await reopened.createModelProviderCredentialStore(profileId)).read(), currentCredential);
          if (action === "delete") {
            await assert.rejects(auth.respond(profileId, {
              sessionId: login.authSession.sessionId,
              promptId: "removed-prompt",
              value: "stale-code",
            }), (error) => error.code === "model_auth_session_stale");
          }
        } finally {
          finishRefresh.resolve();
          providerResult.resolve(credential("stale-login-token"));
          await Promise.allSettled([refresh, rejectedRefresh]);
        }
      });
    });
  }
});

test("concurrent Pi OAuth requests share rotated credentials without blocking another connection", async (t) => {
  await withConfig(async ({ configCenter, directory }) => {
    const firstId = "custom_native_serial";
    const secondId = "custom_native_independent";
    await createProfile(configCenter, firstId);
    await createProfile(configCenter, secondId);
    const first = await configCenter.createModelProviderCredentialStore(firstId);
    const second = await configCenter.createModelProviderCredentialStore(secondId);
    await first.modify(async () => ({ ...credential("first"), expires: 0 }));
    await second.modify(async () => credential("second"));
    const entered = deferred();
    const release = deferred();
    simulatePiLogins(t, {
      [firstId]: {
        refresh: async (current) => {
          entered.resolve();
          await release.promise;
          return credential(`${current.access}-refreshed`);
        },
        toAuth: async (current) => ({ apiKey: current.access }),
      },
      [secondId]: {
        toAuth: async (current) => ({ apiKey: current.access }),
      },
    });
    const nativeOptions = {
      piProviderId: "openai-codex", baseUrl: "", connection: { authMode: "oauth" },
    };
    const firstCollection = createNativeModelProviderCollection({
      ...nativeOptions, profileId: firstId, credentialStore: first,
    });
    const secondCollection = createNativeModelProviderCollection({
      ...nativeOptions, profileId: secondId, credentialStore: second,
    });
    const firstRefresh = firstCollection.modelRegistry.getAuth(firstCollection.providerId);
    let secondRefresh;
    try {
      await entered.promise;
      secondRefresh = firstCollection.modelRegistry.getAuth(firstCollection.providerId);
      // A slow OAuth exchange on one connection must not lock every profile.
      const independent = await secondCollection.modelRegistry.getAuth(secondCollection.providerId);
      assert.equal(independent.auth.apiKey, "second");
      release.resolve();
      const results = await Promise.all([firstRefresh, secondRefresh]);
      assert.deepEqual(results.map((result) => result.auth.apiKey), ["first-refreshed", "first-refreshed"]);
      const reopened = createLocalConfigCenter({ configDirectory: directory }).configCenter;
      const stored = await (await reopened.createModelProviderCredentialStore(firstId)).read();
      assert.equal(stored.access, "first-refreshed");
      assert.equal(stored.refresh, "first-refreshed-refresh");
      assert.equal((await (await reopened.createModelProviderCredentialStore(secondId)).read()).access, "second");
    } finally {
      release.resolve();
      await Promise.allSettled([firstRefresh, secondRefresh]);
    }
  });
});

test("logout can read its own empty credential while revoking old stores and in-flight refresh", async (t) => {
  await withConfig(async ({ configCenter, directory }) => {
    const profileId = "custom_native_logout";
    await createProfile(configCenter, profileId);
    const owner = await configCenter.createModelProviderCredentialStore(profileId);
    await owner.modify(async () => ({ ...credential("before-logout"), expires: 0 }));
    const obsolete = await configCenter.createModelProviderCredentialStore(profileId);
    const entered = deferred();
    const release = deferred();
    simulatePiLogins(t, {
      [profileId]: {
        refresh: async () => {
          entered.resolve();
          await release.promise;
          return credential("late-logout-refresh");
        },
        toAuth: async (current) => ({ apiKey: current.access }),
      },
    });
    const collection = createNativeModelProviderCollection({
      profileId, piProviderId: "openai-codex", baseUrl: "",
      connection: { authMode: "oauth" }, credentialStore: owner,
    });
    const refresh = collection.modelRegistry.getAuth(collection.providerId);
    const rejectedRefresh = assert.rejects(refresh, (error) =>
      error.code === "auth" && error.cause instanceof ConfigCenterValidationError);
    try {
      await entered.promise;
      await collection.modelRegistry.logout(collection.providerId);
      assert.equal(await owner.read(), undefined);
      assert.equal(await collection.modelRegistry.checkAuth(collection.providerId), undefined);
      assert.equal(await collection.modelRegistry.getAuth(collection.providerId), undefined);
      release.resolve();
      await rejectedRefresh;
      await assert.rejects(
        obsolete.modify(async () => credential("obsolete-store-republication")),
        ConfigCenterValidationError,
      );
      const reopened = createLocalConfigCenter({ configDirectory: directory }).configCenter;
      assert.equal(await (await reopened.createModelProviderCredentialStore(profileId)).read(), undefined);
    } finally {
      release.resolve();
      await Promise.allSettled([refresh, rejectedRefresh]);
    }
  });
});

test("native OpenAI streams isolate connection aliases and restore same-connection history identities", async () => {
  const options = { piProviderId: "openai", connection: { authMode: "api_key" } };
  const first = createNativeModelProviderCollection({
    ...options, profileId: "custom_stream_first",
    baseUrl: "https://native-first.example.invalid/v1", apiKey: "first-test-key",
  });
  const other = createNativeModelProviderCollection({
    ...options, profileId: "custom_stream_other",
    baseUrl: "https://native-other.example.invalid/v1", apiKey: "other-test-key",
  });
  const model = first.modelRegistry.getModels(first.providerId).find((item) => item.api === "openai-responses");
  assert.ok(model, "installed Pi must provide an OpenAI Responses model");
  const otherModel = other.modelRegistry.getModel(other.providerId, model.id);
  const item = {
    type: "function_call", id: "fc_native_alias", call_id: "call_native_alias",
    name: "read_file", namespace: "files", arguments: JSON.stringify({ path: "README.md" }),
  };
  const textItem = {
    type: "message", id: "msg_native_alias", role: "assistant", phase: "commentary",
    status: "completed", content: [{ type: "output_text", text: "Reading file.", annotations: [] }],
  };
  const replayRequests = new Map();
  const mockFetch = async (input, init) => {
    const request = new Request(input, init);
    const payload = await request.json();
    const replay = payload.input.some((entry) => entry.type === "function_call_output");
    if (replay) replayRequests.set(new URL(request.url).hostname, payload);
    const outputs = replay ? [{ ...textItem, id: "msg_followup", phase: "final_answer" }] : [textItem, item];
    return openAIEventResponse(outputs);
  };
  const user = { role: "user", content: "Read README.md", timestamp: Date.now() };
  const stream = first.modelRegistry.streamSimple(model, { messages: [user] }, { fetch: mockFetch, maxRetries: 0 });
  for await (const event of stream) {
    const message = event.partial ?? event.message ?? event.error;
    assert.equal(message.provider, first.providerId);
  }
  const assistant = await stream.result();
  assert.equal(assistant.provider, first.providerId);
  assert.equal(assistant.api, "openai-responses");
  assert.equal(assistant.stopReason, "toolUse", assistant.errorMessage);
  const stored = JSON.parse(JSON.stringify(assistant));
  const call = stored.content.find((block) => block.type === "toolCall");
  assert.equal(call.id, "call_native_alias|fc_native_alias");
  const history = {
    messages: [
      user, stored,
      { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "File contents" }], isError: false, timestamp: Date.now() },
      { role: "user", content: "Continue.", timestamp: Date.now() },
    ],
  };
  const continued = await first.modelRegistry.completeSimple(model, history, { fetch: mockFetch, maxRetries: 0 });
  assert.equal(continued.stopReason, "stop", continued.errorMessage);
  assert.equal(continued.provider, first.providerId);
  const ownInput = replayRequests.get("native-first.example.invalid").input;
  assert.equal(ownInput.find((entry) => entry.type === "function_call").id, item.id);
  assert.equal(ownInput.find((entry) => entry.type === "function_call").namespace, item.namespace);
  assert.equal(ownInput.find((entry) => entry.role === "assistant").id, textItem.id);
  assert.equal(ownInput.find((entry) => entry.type === "function_call_output").call_id, item.call_id);

  const switched = await other.modelRegistry.completeSimple(otherModel, history, { fetch: mockFetch, maxRetries: 0 });
  assert.equal(switched.stopReason, "stop", switched.errorMessage);
  assert.equal(switched.provider, other.providerId);
  const foreignInput = replayRequests.get("native-other.example.invalid").input;
  assert.notEqual(foreignInput.find((entry) => entry.type === "function_call").id, item.id);
  assert.equal(foreignInput.find((entry) => entry.type === "function_call").namespace, undefined);
  assert.notEqual(foreignInput.find((entry) => entry.role === "assistant").id, textItem.id);
  assert.equal(stored.provider, first.providerId, "request adaptation must not mutate persisted history");
});

function simulatePiLogins(t, flows) {
  const prototype = Object.getPrototypeOf(createModels());
  const register = prototype.setProvider;
  // Replace provider callbacks only. Pi auth orchestration and product persistence stay real.
  t.mock.method(prototype, "setProvider", function (provider) {
    const profileId = Object.keys(flows).find((id) => nativeModelProviderRegistryId(id) === provider.id);
    if (profileId === undefined) return register.call(this, provider);
    assert.ok(provider.auth.oauth, "the test requires a real OAuth-capable native provider");
    return register.call(this, {
      ...provider,
      auth: {
        ...provider.auth,
        oauth: {
          ...provider.auth.oauth,
          ...(typeof flows[profileId] === "function" ? { login: flows[profileId] } : flows[profileId]),
        },
      },
    });
  });
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Native connection core tests must not make network requests.");
  });
}

async function createProfile(configCenter, profileId, piProviderId = "openai-codex") {
  return configCenter.createModelProviderProfile({
    profileId, label: "Native test connection", protocolKind: "native",
    piProviderId, connection: { authMode: "oauth" },
  });
}

function credential(access) {
  return { type: "oauth", access, refresh: `${access}-refresh`, expires: Date.now() + 60 * 60_000 };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function waitForAuth(auth, profileId, predicate) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const response = await auth.status(profileId);
    if (predicate(response)) return response;
    assert.notEqual(response.authSession?.status, "failed", "simulated Pi login unexpectedly failed");
    assert.ok(Date.now() < deadline, "simulated Pi login did not settle");
    await delay(5);
  }
}

async function withConfig(operation, onFailure, openExternalResource) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synech-core-native-connections-"));
  const { configCenter } = createLocalConfigCenter({ configDirectory: directory });
  const auth = createModelProviderAuthApplication(configCenter, onFailure, openExternalResource);
  try {
    await operation({ directory, configCenter, auth });
  } finally {
    await auth.dispose();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function failedAssistant(diagnostics) {
  return {
    role: "assistant", api: "bedrock-converse-stream", provider: "amazon-bedrock",
    model: "test-model", timestamp: 1, content: [], stopReason: "error",
    errorMessage: "Provider request failed.", diagnostics,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function openAIEventResponse(outputs) {
  const events = [
    { type: "response.created", response: { id: "resp_native_alias" } },
    ...outputs.flatMap((item, output_index) => [
      { type: "response.output_item.added", output_index, item },
      { type: "response.output_item.done", output_index, item },
    ]),
    {
      type: "response.completed",
      response: {
        id: "resp_native_alias", status: "completed", output: outputs,
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      },
    },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
