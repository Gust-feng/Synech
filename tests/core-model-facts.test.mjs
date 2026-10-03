import assert from "node:assert/strict";
import test from "node:test";
import { createModels, createProvider } from "@earendil-works/pi-ai";

import {
  resolveDiscoveredModel,
  resolveDiscoveredModelFacts,
} from "../dist/adapters/intelligence/pi-model-facts.js";
import { createModelProviderBinding } from "../dist/adapters/intelligence/model-provider-binding.js";
import {
  resolvedContextWindowTokens,
  resolvedSupportsVisionInput,
  resolvedThinkingLevels,
} from "../dist/domain/config/model-facts.js";
import { resolveModelCapabilities } from "../dist/app/model-runtime/model-capability-resolution.js";
import { MODEL_RUN_REASONING_EFFORT_LABELS } from "../dist/domain/config/index.js";
import { DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS } from "../dist/domain/config/model-configuration.js";
import { trackNativeModelRegistry } from "../dist/adapters/intelligence/native-provider-model-scope.js";
import { createNativeModelProviderCollection } from "../dist/adapters/intelligence/native-model-provider.js";
import { modelToolDefinitionSerialization } from "../dist/adapters/intelligence/model-tool-definition-cost.js";
import { providerToolDefinitions } from "../dist/adapters/intelligence/agent-session-loop/harness-event-projector.js";
import { serializeModelVisibleToolDefinitions } from "../dist/app/model-runtime/tool-definition-visibility-cost.js";
import { resolveMcpFirstToolVisibilityPlan } from "../dist/app/capability/run-tool-visibility-policy.js";
import { resolveConfiguredModel } from "../dist/adapters/intelligence/model-catalog-binding.js";
import { resolveModelCapabilitiesForProfile } from "../dist/app/panel-server/settings/model-facts.js";
import { resolvedMaxOutputTokens } from "../dist/domain/config/model-facts.js";

const PI_CATALOG = await import("@earendil-works/pi-ai/providers/all");

test("native and compatible tool cost estimates follow Pi's actual payload and preserve authorized tools", async () => {
  const definition = {
    name: "Read",
    description: "Read an authorized file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  };
  for (const piProviderId of ["anthropic", "openai", "deepseek"]) {
    const collection = createNativeModelProviderCollection({
      piProviderId, profileId: `tool-cost-${piProviderId}`, baseUrl: "", apiKey: "tool-cost-test-key",
      connection: { authMode: "api_key" },
    });
    const model = collection.modelRegistry.getModels(collection.providerId)[0];
    let payload;
    await collection.modelRegistry.completeSimple(model, {
      messages: [{ role: "user", content: "Read a file.", timestamp: 0 }],
      tools: [{ name: definition.name, description: definition.description, parameters: definition.inputSchema }],
    }, {
      maxRetries: 0,
      onPayload: (assembled) => {
        payload = assembled;
        throw new Error("Stop before any network request.");
      },
      fetch: async () => { throw new Error("Tool cost tests must not issue network requests."); },
    });
    assert.ok(payload, `${piProviderId} must expose its actual assembled payload`);
    const wire = providerToolDefinitions(payload, [definition]);
    assert.equal(wire.length, 1);
    const comparable = wire.map(({ cache_control, ...tool }) => tool);
    const serialization = modelToolDefinitionSerialization(model);
    assert.deepEqual(serializeModelVisibleToolDefinitions([definition], serialization), comparable);

    const longDefinition = {
      ...definition,
      inputSchema: {
        ...definition.inputSchema,
        properties: { path: { type: "string", description: "A large authorized schema field. ".repeat(4000) } },
      },
    };
    const facts = resolveDiscoveredModelFacts({ piProviderId, modelId: model.id });
    const snapshot = {
      snapshotId: `tool-cost-${piProviderId}`,
      activeModel: { protocolKind: "native" },
      modelCapabilities: { facts },
      mcpCatalog: [{
        serverId: "test-mcp", label: "Test", enabled: true, availability: "configured",
        exposedTools: [{ name: "Read", definitionHash: "frozen-schema", displayName: "Read", description: longDefinition.description }],
      }],
    };
    const input = {
      snapshot, executionAllowedToolNames: ["Read"], allowedAgentToolNames: [], frozenDefinitions: [longDefinition],
      toolDefinitionTokenCounter: (value) => Math.ceil(value.length / 4),
      toolDefinitionSerialization: serialization,
    };
    const plan = resolveMcpFirstToolVisibilityPlan(input);
    assert.ok(plan, "native connections must not disable a supported model's cost optimization");
    assert.deepEqual(plan.deferredTools.map((tool) => tool.name), ["Read"]);
    assert.equal(plan.costGate.definitionSerialization.api, model.api);
    const compatible = resolveMcpFirstToolVisibilityPlan({
      ...input, snapshot: { ...snapshot, activeModel: { protocolKind: facts.transport } },
    });
    assert.deepEqual(compatible, plan);
  }
});

test("dynamic Pi facts remain connection-scoped and an older refresh cannot restore removed models", async () => {
  const model = PI_CATALOG.builtinModels().getModels("radius")[0];
  assert.ok(model);
  const scope = {
    profileId: "dynamic-facts-test", piProviderId: "radius",
    baseUrl: "https://custom-radius.example.invalid/v1",
    connection: { authMode: "api_key" }, secretUpdatedAt: "2026-09-30T00:00:00.000Z",
  };
  const lookup = { ...scope, modelId: model.id };
  const build = (fetchModels) => {
    const registry = createModels();
    const providerId = "synech-dynamic-facts-test";
    registry.setProvider(createProvider({
      id: providerId, models: [],
      auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
      fetchModels,
      api: {
        stream: () => { throw new Error("Model facts tests must not issue requests."); },
        streamSimple: () => { throw new Error("Model facts tests must not issue requests."); },
      },
    }));
    trackNativeModelRegistry(scope, providerId, registry);
    return registry;
  };
  assert.equal(resolveDiscoveredModelFacts(lookup).status, "unconfirmed",
    "a custom gateway must not borrow the default Radius catalog");
  const first = build(async () => {
    return [model];
  });
  await first.refresh({ allowNetwork: true, force: true });
  assert.equal(resolveDiscoveredModelFacts(lookup).status, "confirmed");
  assert.equal(resolveDiscoveredModelFacts({ ...lookup, profileId: "another-connection" }).status, "unconfirmed");
  assert.equal(resolveDiscoveredModelFacts({ ...lookup, secretUpdatedAt: "2026-09-30T00:00:00.001Z" }).status, "unconfirmed");

  let completeOld;
  const oldResult = new Promise((resolve) => { completeOld = resolve; });
  let startedOld;
  const oldStarted = new Promise((resolve) => { startedOld = resolve; });
  const old = build(async () => { startedOld(); return oldResult; });
  const pending = old.refresh({ allowNetwork: true, force: true });
  await oldStarted;
  await build(async () => []).refresh({ allowNetwork: true, force: true });
  completeOld([model]);
  await pending;
  assert.equal(resolveDiscoveredModelFacts(lookup).status, "unconfirmed",
    "late older success cannot overwrite the newer catalog where the model is absent");
});

function bindingOptions(overrides) {
  return {
    protocol: "openai_compatible_chat_completions",
    baseUrl: "https://connect.example.invalid/v1",
    model: "gpt-4o",
    profileId: "facts-test",
    apiKey: "test-key",
    ...overrides,
  };
}

test("known models take their runtime facts from the real Pi catalog", async () => {
  for (const [piProviderId, modelId] of [
    ["openai", "gpt-4o"],
    ["deepseek", "deepseek-v4-pro"],
    ["moonshotai-cn", "kimi-k3"],
  ]) {
    const real = PI_CATALOG.getBuiltinModel(piProviderId, modelId);
    assert.notEqual(real, undefined, `pi catalog should hold ${piProviderId}/${modelId}`);
    const binding = createModelProviderBinding(bindingOptions({
      piProviderId, model: modelId,
      protocol: real.api === "openai-responses" ? "openai_responses" : "openai_compatible_chat_completions",
    }));
    const selected = binding.selectedModel;
    assert.equal(selected.api, real.api);
    assert.equal(selected.contextWindow, real.contextWindow);
    assert.equal(selected.maxTokens, real.maxTokens);
    assert.deepEqual(selected.input, real.input);
    assert.equal(selected.reasoning, real.reasoning);
    assert.deepEqual(selected.compat, real.compat);
    assert.deepEqual(selected.thinkingLevelMap, real.thinkingLevelMap);
    assert.deepEqual(selected.cost, real.cost);
    // Only connection facts override the real model: registry key and baseUrl.
    assert.equal(selected.provider, "synech-facts-test");
    assert.equal(selected.baseUrl, "https://connect.example.invalid/v1");

    const facts = resolveDiscoveredModelFacts({ piProviderId, modelId });
    assert.equal(facts.status, "confirmed");
    assert.equal(facts.contextWindowTokens, real.contextWindow);
    assert.equal(facts.maxOutputTokens, real.maxTokens);
    assert.equal(facts.supportsVisionInput, real.input.includes("image"));
    assert.equal(facts.supportsReasoningOutput, real.reasoning === true);
    const supportedLevels = Object.entries(real.thinkingLevelMap ?? {})
      .filter(([, value]) => value !== null)
      .map(([level]) => level);
    assert.deepEqual([...facts.thinkingLevels].sort(), supportedLevels.sort());
  }
});

test("custom model references never replace the configured connection transport", async () => {
  const binding = createModelProviderBinding(bindingOptions({ piProviderId: "openai" }));
  assert.equal(binding.selectedModel.api, "openai-completions");
  assert.equal(binding.selectedModel.compat, undefined, "Responses compat must not leak into Chat Completions");
  const deepseek = createModelProviderBinding(
    bindingOptions({ piProviderId: "deepseek", model: "deepseek-v4-pro" }),
  );
  assert.equal(deepseek.selectedModel.api, "openai-completions");
});

test("unknown discovered models run on the connection default transport without fabricated facts", async () => {
  const modelId = "some-model-the-remote-listed";
  const facts = resolveDiscoveredModelFacts({ piProviderId: "openai", modelId });
  assert.deepEqual(facts, { status: "unconfirmed", modelId });

  const resolved = resolveModelCapabilities({
    profile: { profileId: "facts-test", providerKind: "openai_compatible", model: modelId },
    facts,
    overrides: [],
  });
  assert.equal(resolvedContextWindowTokens(resolved), DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS);
  assert.equal(resolvedSupportsVisionInput(resolved), undefined);
  assert.equal(resolvedThinkingLevels(resolved), undefined);

  // Run start is not gated: the binding constructs and keeps the model id as-is.
  const chatBinding = createModelProviderBinding(
    bindingOptions({ piProviderId: "openai", model: modelId }),
  );
  assert.equal(chatBinding.selectedModel.id, modelId);
  assert.equal(chatBinding.selectedModel.api, "openai-completions");
  assert.equal(chatBinding.selectedModel.contextWindow, resolvedContextWindowTokens(resolved));
  const responsesBinding = createModelProviderBinding(
    bindingOptions({
      piProviderId: "openai",
      model: modelId,
      protocol: "openai_responses",
    }),
  );
  assert.equal(responsesBinding.selectedModel.api, "openai-responses");
  assert.equal(responsesBinding.selectedModel.contextWindow, resolvedContextWindowTokens(resolved));

  // Pi must send max_tokens for Messages, while the user's setting stays optional.
  // The fallback is a request budget and must not become a confirmed model fact.
  for (const maxOutputTokens of [undefined, 2048]) {
    const binding = createModelProviderBinding(bindingOptions({
      model: modelId, protocol: "anthropic_messages",
      ...(maxOutputTokens === undefined ? {} : { modelConfiguration: { overrides: { maxOutputTokens } } }),
    }));
    let payload;
    await binding.modelRegistry.completeSimple(binding.selectedModel, {
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    }, {
      maxRetries: 0,
      onPayload: (value) => { payload = value; throw new Error("Stop before network."); },
      fetch: async () => { throw new Error("Tests must never issue requests."); },
    });
    assert.equal(payload.max_tokens, maxOutputTokens ?? 4096);
    assert.equal(payload.model, modelId);
  }
  assert.deepEqual(resolveDiscoveredModelFacts({ modelId }), { status: "unconfirmed", modelId });

  // A connection without an explicit piProviderId treats every model as unknown.
  assert.equal(
    resolveDiscoveredModelFacts({ piProviderId: undefined, modelId: "gpt-4o" }).status,
    "unconfirmed",
  );
});

test("model ids resolve only inside their explicitly declared Pi provider", async () => {
  const inScope = resolveDiscoveredModel({ piProviderId: "deepseek", modelId: "deepseek-v4-pro" });
  assert.equal(inScope.status, "known");
  assert.equal(inScope.piProviderId, "deepseek");
  // No first-match scan across providers and no fuzzy/substring matching.
  assert.equal(
    resolveDiscoveredModel({ piProviderId: "openai", modelId: "deepseek-v4-pro" }).status,
    "unknown",
  );
  assert.equal(resolveDiscoveredModel({ piProviderId: "openai", modelId: "gpt" }).status, "unknown");
  assert.equal(resolveDiscoveredModel({ piProviderId: "openai", modelId: "GPT-4O" }).status, "unknown");

  // The same model id stays scoped to the provider that was asked for.
  const global = resolveDiscoveredModelFacts({ piProviderId: "moonshotai", modelId: "kimi-k3" });
  const cn = resolveDiscoveredModelFacts({ piProviderId: "moonshotai-cn", modelId: "kimi-k3" });
  assert.equal(global.status, "confirmed");
  assert.equal(cn.status, "confirmed");
  assert.equal(global.piProviderId, "moonshotai");
  assert.equal(cn.piProviderId, "moonshotai-cn");
});

test("a known Anthropic Messages model binds through the configured Anthropic transport", async () => {
  const facts = resolveDiscoveredModelFacts({ piProviderId: "minimax-cn", modelId: "MiniMax-M3" });
  assert.equal(facts.status, "confirmed");
  assert.equal(facts.transport, "anthropic_messages");

  const binding = createModelProviderBinding(
    bindingOptions({ piProviderId: "minimax-cn", model: "MiniMax-M3", protocol: "anthropic_messages" }),
  );
  assert.equal(binding.selectedModel.api, "anthropic-messages");
  // Anthropic transport carries no OpenAI payload policy: never a dialect rewrite.
  assert.equal(binding.transformProviderPayload, undefined);
});

test("a native catalog reference on a custom gateway copies capabilities, not native auth or wire settings", async () => {
  const facts = resolveDiscoveredModelFacts({ piProviderId: "amazon-bedrock", modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" });
  if (facts.status === "confirmed") {
    assert.equal(facts.transport, "native");
    const binding = createModelProviderBinding(
      bindingOptions({ piProviderId: "amazon-bedrock", model: "anthropic.claude-sonnet-4-5-20250929-v1:0" }),
    );
    assert.equal(binding.selectedModel.api, "openai-completions");
    assert.equal(binding.selectedModel.provider, "synech-facts-test");
    assert.equal(binding.selectedModel.compat, undefined);
  }
});

test("mixed-vendor gateways resolve exact and prefixed model IDs without guessing variants or ambiguous candidates", () => {
  for (const modelId of ["deepseek-flash", "vendor/deepseek-flash", "gpt-4o", "vendor/gpt-4o"]) {
    const resolved = resolveConfiguredModel({ modelId, protocolKind: "openai_compatible_chat_completions" });
    assert.equal(resolved.status, "known");
    assert.equal(resolved.piProviderId, modelId.endsWith("gpt-4o") ? "openai" : "deepseek");
    const binding = createModelProviderBinding(bindingOptions({ model: modelId }));
    assert.equal(binding.selectedModel.id, modelId, "the gateway's ID is sent unchanged");
    assert.ok(binding.selectedModel.input.includes("image"));
    assert.equal(binding.selectedModel.api, "openai-completions");
  }
  for (const modelId of ["deepseek-flash-unknown-version", "not-deepseek-flash", "vendor/deepseek"]) {
    assert.equal(resolveConfiguredModel({ modelId }).status, "unknown");
  }
  const namespacedId = "meta-llama/llama-3.3-70b-instruct";
  const original = resolveConfiguredModel({ modelId: namespacedId });
  assert.equal(original.status, "known");
  for (const modelId of [`gateway/${namespacedId}`, `gateway/region/${namespacedId}`]) {
    const resolved = resolveConfiguredModel({ modelId });
    assert.equal(resolved.status, "known");
    assert.equal(resolved.modelId, namespacedId, "catalog namespaces remain part of the exact ID");
    const binding = createModelProviderBinding(bindingOptions({ model: modelId }));
    assert.equal(binding.selectedModel.id, modelId, "gateway prefixes remain in the upstream request");
    assert.equal(binding.selectedModel.contextWindow, original.model.contextWindow);
    assert.equal(binding.selectedModel.maxTokens, original.model.maxTokens);
  }
  const catalog = PI_CATALOG.builtinModels();
  const duplicates = new Map();
  for (const provider of catalog.getProviders()) {
    for (const model of catalog.getModels(provider.id)) {
      const group = duplicates.get(model.id) ?? [];
      group.push(model);
      duplicates.set(model.id, group);
    }
  }
  const ambiguousId = [...duplicates].find(([id, models]) =>
    models.length > 1 &&
    new Set(models.map((model) => JSON.stringify([model.contextWindow, model.maxTokens, model.input, model.thinkingLevelMap]))).size > 1 &&
    resolveConfiguredModel({ modelId: id }).status === "unknown")?.[0];
  assert.ok(ambiguousId, "Pi contains conflicts which must not resolve by catalog order");
  assert.equal(resolveConfiguredModel({ modelId: "private-alias" }).status, "unknown",
    "opaque aliases require direct capability settings, not manual catalog selection");
});

test("custom capability settings reach real Pi image and reasoning payloads without altering catalog facts", async () => {
  const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=" };
  const configuration = { overrides: {
    contextWindowTokens: 32000, maxOutputTokens: 2000, thinkingLevels: ["low", "high"], supportsVisionInput: true,
  } };
  for (const modelId of ["vendor/deepseek-flash", "private-unknown"]) {
    const profile = {
      profileId: "mixed-gateway", providerKind: "openai_compatible",
      protocolKind: "openai_compatible_chat_completions", model: modelId,
      modelSettings: { [modelId]: configuration },
    };
    const capabilities = resolveModelCapabilitiesForProfile({ profile });
    assert.equal(resolvedSupportsVisionInput(capabilities), true);
    assert.equal(resolvedContextWindowTokens(capabilities), 32000);
    assert.equal(resolvedMaxOutputTokens(capabilities), 2000);
    assert.deepEqual(resolvedThinkingLevels(capabilities), ["low", "high"]);
    const binding = createModelProviderBinding(bindingOptions({
      model: modelId, modelConfiguration: configuration, requestSettings: { reasoningEffort: "high" },
    }));
    let payload;
    const response = await binding.modelRegistry.completeSimple(binding.selectedModel, {
      messages: [
        { role: "user", content: [{ type: "text", text: "Inspect the image." }, image], timestamp: 0 },
        { role: "assistant", api: binding.selectedModel.api, provider: binding.selectedModel.provider, model: modelId,
          content: [{ type: "toolCall", id: "call-image", name: "AttachmentReadImage", arguments: {} }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
          stopReason: "toolUse", timestamp: 1 },
        { role: "toolResult", toolCallId: "call-image", toolName: "AttachmentReadImage", content: [image], isError: false, timestamp: 2 },
      ],
    }, {
      reasoning: binding.thinkingLevel, maxRetries: 0,
      onPayload: (value) => { payload = value; throw new Error("Stop before network."); },
      fetch: async () => { throw new Error("Tests must never issue requests."); },
    });
    assert.equal(response.stopReason, "error");
    assert.ok(payload);
    assert.equal(payload.model, modelId);
    assert.equal(payload.reasoning_effort, "high");
    if (modelId.includes("deepseek")) assert.equal(payload.thinking.type, "enabled");
    assert.ok((payload.max_tokens ?? payload.max_completion_tokens) <= 2000);
    const blocks = payload.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
    assert.equal(blocks.filter((block) => block.type === "image_url").length, 2,
      "both current user image and tool-read image must survive Pi serialization");
    assert.equal(capabilities.facts.status, modelId.includes("deepseek") ? "confirmed" : "unconfirmed");
  }
  const original = PI_CATALOG.getBuiltinModel("deepseek", "deepseek-flash");
  assert.notEqual(original.contextWindow, 32000, "user settings must not mutate the shared catalog");
  const disabled = createModelProviderBinding(bindingOptions({
    model: "vendor/deepseek-flash", modelConfiguration: { overrides: { supportsVisionInput: false, supportsReasoningOutput: false } },
  }));
  assert.deepEqual(disabled.selectedModel.input, ["text"]);
  assert.equal(disabled.selectedModel.reasoning, false);
});

test("native run overrides stay out of Pi catalog facts and survive Harness ID lookup", () => {
  const original = PI_CATALOG.getBuiltinModel("deepseek", "deepseek-flash");
  const binding = createModelProviderBinding(bindingOptions({
    protocol: "native", piProviderId: "deepseek", model: "deepseek-flash", baseUrl: "",
    connection: { authMode: "api_key" },
    modelConfiguration: { overrides: {
      contextWindowTokens: 64000, maxOutputTokens: 1024, supportsVisionInput: false,
      supportsReasoningOutput: false,
    } },
  }));
  const selected = binding.modelRegistry.getModel(binding.selectedModel.provider, binding.selectedModel.id);
  assert.equal(selected.contextWindow, 64000);
  assert.equal(selected.maxTokens, 1024);
  assert.deepEqual(selected.input, ["text"]);
  assert.equal(selected.reasoning, false);
  const baseline = binding.catalogRegistry.getModel(selected.provider, selected.id);
  assert.equal(baseline.contextWindow, original.contextWindow);
  assert.deepEqual(baseline.input, original.input);
  assert.equal(baseline.reasoning, original.reasoning);
});

test("built-in web search cannot be silently applied to the Anthropic transport", async () => {
  assert.throws(
    () => createModelProviderBinding(
      bindingOptions({ piProviderId: "minimax-cn", model: "MiniMax-M3", protocol: "anthropic_messages", enableWebSearch: true }),
    ),
    /Built-in web search is not supported by the Anthropic Messages protocol binding/,
  );
});

test("product reasoning choices preserve Pi facts and expose only the supported five-level subset", async () => {
  // gpt-5.6 on openai carries xhigh and max; the product must not clip them to a
  // fixed three-level vocabulary.
  const facts = resolveDiscoveredModelFacts({ piProviderId: "openai", modelId: "gpt-5.6-sol" });
  assert.equal(facts.status, "confirmed");
  assert.ok(facts.thinkingLevels.length > 0, "expected real Pi thinking levels");

  const labelKeys = Object.keys(MODEL_RUN_REASONING_EFFORT_LABELS);
  for (const level of facts.thinkingLevels) {
    if (level === "off" || level === "minimal") continue;
    assert.ok(labelKeys.includes(level), `Pi level ${level} has no product label`);
  }
  // "off" means the model can be told not to reason; the run-level vocabulary
  // expresses that by absence, so it must never be offered as an option.
  assert.ok(!labelKeys.includes("off"), "off must not be a selectable run level");
  assert.ok(!labelKeys.includes("minimal"), "minimal must not be a product choice");
  assert.deepEqual(Object.values(MODEL_RUN_REASONING_EFFORT_LABELS), ["低", "中", "高", "极高", "最高"]);

  // An unconfirmed model must not gain levels, and a confirmed one must not lose them.
  assert.deepEqual(resolvedThinkingLevels({ facts }), facts.thinkingLevels);
  const unconfirmed = resolveDiscoveredModelFacts({ piProviderId: "openai", modelId: "not-in-catalog" });
  assert.deepEqual(resolvedThinkingLevels({ facts: unconfirmed }), undefined);
});

test("the product level vocabulary uses Pi-supported encodings", async () => {
  // Guards against a new Pi level landing without a product label: the UI could
  // not render it and the request parser would reject it.
  const real = PI_CATALOG.getBuiltinModel("openai", "gpt-5.6-sol");
  const piLevels = Object.entries(real.thinkingLevelMap ?? {})
    .filter(([, value]) => value !== null)
    .map(([level]) => level);
  const labelKeys = Object.keys(MODEL_RUN_REASONING_EFFORT_LABELS);
  for (const level of piLevels) {
    if (level === "off" || level === "minimal") continue;
    assert.ok(labelKeys.includes(level), `Pi level ${level} is missing a product label`);
  }
});

test("strict tool schema support is projected from the model's real compat", async () => {
  const openai = resolveDiscoveredModelFacts({ piProviderId: "openai", modelId: "gpt-4o" });
  assert.equal(openai.status, "confirmed");
  assert.equal(openai.supportsStrictToolSchemas, true);

  const openRouter = resolveDiscoveredModelFacts({
    piProviderId: "openrouter",
    modelId: "x-ai/grok-4",
  });
  if (openRouter.status === "confirmed" && openRouter.transport === "openai_responses") {
    assert.equal(
      openRouter.supportsStrictToolSchemas,
      PI_CATALOG.getBuiltinModel("openrouter", "x-ai/grok-4").compat?.supportsStrictMode === true,
    );
  }

  const anthropic = resolveDiscoveredModelFacts({
    piProviderId: "anthropic",
    modelId: "claude-haiku-4-5",
  });
  assert.equal(anthropic.status, "confirmed");
  assert.equal(
    anthropic.supportsStrictToolSchemas,
    PI_CATALOG.getBuiltinModel("anthropic", "claude-haiku-4-5").compat?.supportsStrictTools === true,
  );
});
