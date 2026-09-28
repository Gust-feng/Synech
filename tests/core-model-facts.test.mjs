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

test("a known model whose Pi api this product cannot serve fails explicitly at binding time", async () => {
  // A custom profile may declare any pi provider; pi's MiniMax catalog speaks
  // anthropic-messages, which this product has no transport for.
  const facts = resolveDiscoveredModelFacts({ piProviderId: "minimax-cn", modelId: "MiniMax-M2.7" });
  assert.equal(facts.status, "confirmed");
  assert.equal(facts.transport, undefined);
  assert.throws(
    () => createModelProviderBinding(
      bindingOptions({ piProviderId: "minimax-cn", model: "MiniMax-M2.7" }),
    ),
    /anthropic-messages/,
  );
});
