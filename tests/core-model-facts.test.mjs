import assert from "node:assert/strict";
import test from "node:test";

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

const PI_CATALOG = await import("@earendil-works/pi-ai/providers/all");

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
    const binding = createModelProviderBinding(bindingOptions({ piProviderId, model: modelId }));
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

test("a known model's transport follows the real Pi Model.api, not the connection protocol", async () => {
  // gpt-4o's real api is openai-responses even though this connection declares
  // chat completions; the model's own api wins.
  const binding = createModelProviderBinding(bindingOptions({ piProviderId: "openai" }));
  assert.equal(binding.selectedModel.api, "openai-responses");
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
  assert.equal(resolvedContextWindowTokens(resolved), undefined);
  assert.equal(resolvedSupportsVisionInput(resolved), undefined);
  assert.equal(resolvedThinkingLevels(resolved), undefined);

  // Run start is not gated: the binding constructs and keeps the model id as-is.
  const chatBinding = createModelProviderBinding(
    bindingOptions({ piProviderId: "openai", model: modelId }),
  );
  assert.equal(chatBinding.selectedModel.id, modelId);
  assert.equal(chatBinding.selectedModel.api, "openai-completions");
  const responsesBinding = createModelProviderBinding(
    bindingOptions({
      piProviderId: "openai",
      model: modelId,
      protocol: "openai_responses",
    }),
  );
  assert.equal(responsesBinding.selectedModel.api, "openai-responses");

  // Anthropic Messages has no wire-level "omit max_tokens" convention: Pi will
  // send Model.maxTokens as max_tokens. An unconfirmed model has no factual
  // budget, so the Adapter must reject it instead of constructing max_tokens: 0.
  assert.throws(
    () => createModelProviderBinding(
      bindingOptions({
        piProviderId: "minimax-cn",
        model: modelId,
        protocol: "anthropic_messages",
      }),
    ),
    /has no factual max_tokens/,
  );

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

test("a known Anthropic Messages model binds through the Anthropic transport", async () => {
  // pi's MiniMax provider speaks anthropic-messages; the connection protocol is
  // irrelevant once the model is known.
  const facts = resolveDiscoveredModelFacts({ piProviderId: "minimax-cn", modelId: "MiniMax-M3" });
  assert.equal(facts.status, "confirmed");
  assert.equal(facts.transport, "anthropic_messages");

  const binding = createModelProviderBinding(
    bindingOptions({ piProviderId: "minimax-cn", model: "MiniMax-M3" }),
  );
  assert.equal(binding.selectedModel.api, "anthropic-messages");
  // Anthropic transport carries no OpenAI payload policy: never a dialect rewrite.
  assert.equal(binding.transformProviderPayload, undefined);
});

test("a known model whose Pi api this product cannot serve fails explicitly at binding time", async () => {
  // A custom profile may declare any pi provider. Bedrock's converse-stream api
  // has no transport here, so the binding must fail loudly instead of silently
  // substituting the connection protocol.
  const facts = resolveDiscoveredModelFacts({ piProviderId: "amazon-bedrock", modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" });
  if (facts.status === "confirmed") {
    assert.equal(facts.transport, undefined);
    assert.throws(
      () => createModelProviderBinding(
        bindingOptions({ piProviderId: "amazon-bedrock", model: "anthropic.claude-sonnet-4-5-20250929-v1:0" }),
      ),
      /bedrock-converse-stream/,
    );
  }
});

test("built-in web search cannot be silently applied to the Anthropic transport", async () => {
  assert.throws(
    () => createModelProviderBinding(
      bindingOptions({ piProviderId: "minimax-cn", model: "MiniMax-M3", protocol: "anthropic_messages", enableWebSearch: true }),
    ),
    /Built-in web search is not supported by the Anthropic Messages protocol binding/,
  );
});

test("run reasoning levels are exactly the model's real Pi thinking levels", async () => {
  // gpt-5.6 on openai carries xhigh and max; the product must not clip them to a
  // fixed three-level vocabulary.
  const facts = resolveDiscoveredModelFacts({ piProviderId: "openai", modelId: "gpt-5.6-sol" });
  assert.equal(facts.status, "confirmed");
  assert.ok(facts.thinkingLevels.length > 0, "expected real Pi thinking levels");

  const labelKeys = Object.keys(MODEL_RUN_REASONING_EFFORT_LABELS);
  for (const level of facts.thinkingLevels) {
    if (level === "off") continue; // not a selectable run level, see below
    assert.ok(labelKeys.includes(level), `Pi level ${level} has no product label`);
  }
  // "off" means the model can be told not to reason; the run-level vocabulary
  // expresses that by absence, so it must never be offered as an option.
  assert.ok(!labelKeys.includes("off"), "off must not be a selectable run level");

  // An unconfirmed model must not gain levels, and a confirmed one must not lose them.
  assert.deepEqual(resolvedThinkingLevels({ facts }), facts.thinkingLevels);
  const unconfirmed = resolveDiscoveredModelFacts({ piProviderId: "openai", modelId: "not-in-catalog" });
  assert.deepEqual(resolvedThinkingLevels({ facts: unconfirmed }), undefined);
});

test("the product level vocabulary covers every Pi level the label table names", async () => {
  // Guards against a new Pi level landing without a product label: the UI could
  // not render it and the request parser would reject it.
  const real = PI_CATALOG.getBuiltinModel("openai", "gpt-5.6-sol");
  const piLevels = Object.entries(real.thinkingLevelMap ?? {})
    .filter(([, value]) => value !== null)
    .map(([level]) => level);
  const labelKeys = Object.keys(MODEL_RUN_REASONING_EFFORT_LABELS);
  for (const level of piLevels) {
    if (level === "off") continue;
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
