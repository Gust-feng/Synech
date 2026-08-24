import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_MODEL_DEFINITIONS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  createRunCapabilityPlan,
  hasModelCapabilityOverride,
  resolveModelCapabilities,
  resolveProtocolToolCallCapabilities,
} from "../dist/app/model-runtime/model-capability-registry.js";

test("specific built-in definitions retain priority over family patterns", () => {
  const miniIndex = BUILTIN_MODEL_DEFINITIONS.findIndex((item) => item.modelPattern === "gpt-5.4-mini");
  const familyIndex = BUILTIN_MODEL_DEFINITIONS.findIndex((item) => item.modelPattern === "gpt-5.4");
  assert.ok(miniIndex >= 0 && familyIndex >= 0 && miniIndex < familyIndex);

  const capabilities = resolveModelCapabilities({
    profile: profile({ model: "gpt-5.4-mini-2026-08-01", baseUrl: "https://api.openai.com/v1" }),
  });
  assert.equal(capabilities.contextWindowTokens, 400_000);
  assert.equal(capabilities.maxOutputTokens, 128_000);
  assert.equal(capabilities.protocolProfileId, "openai");
  assert.equal(capabilities.reasoningControl, "none");
  assert.deepEqual(capabilities.imageInput, {
    status: "supported",
    source: "registry",
    verifiedAt: "2026-06-28",
  });
});

test("provider profile signals select provider-specific model definitions", () => {
  const capabilities = resolveModelCapabilities({
    profile: profile({
      profileId: "custom",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-preview",
    }),
  });

  assert.equal(capabilities.contextWindowTokens, 1_000_000);
  assert.equal(capabilities.maxOutputTokens, 384_000);
  assert.equal(capabilities.protocolProfileId, "deepseek");
  assert.equal(capabilities.reasoningControl, "deepseek_reasoning_effort");
  assert.equal(capabilities.supportsParallelToolCalls, false);
});

test("unknown models keep the protocol fallback semantics", () => {
  const capabilities = resolveModelCapabilities({
    profile: profile({
      profileId: "private-gateway",
      label: "Private gateway",
      baseUrl: "https://models.example.test/v1",
      model: "company-model",
    }),
  });

  assert.equal(capabilities.contextWindowTokens, DEFAULT_CONTEXT_WINDOW_TOKENS);
  assert.equal(capabilities.maxOutputTokens, 32_768);
  assert.equal(capabilities.supportsToolCalling, true);
  assert.equal(capabilities.supportsParallelToolCalls, false);
  assert.equal(capabilities.supportsVisionInput, false);
  assert.equal(capabilities.preferredApiStyle, "chat_completions");
  assert.equal(capabilities.protocolProfileId, "openai_compatible");
  assert.deepEqual(capabilities.imageInput, {
    status: "unknown",
    source: "protocol_default",
    verifiedAt: "2026-06-28",
  });
});

test("profile-specific override wins while retaining provider-scoped fields", () => {
  const activeProfile = profile({ profileId: "work", model: "gpt-5.6-sol" });
  const overrides = [
    {
      providerKind: "openai_compatible",
      model: "GPT-5.6-SOL",
      capabilities: {
        contextWindowTokens: 111_000,
        supportsStructuredOutputs: false,
      },
      updatedAt: "2026-08-23T00:00:00.000Z",
    },
    {
      profileId: "work",
      providerKind: "openai_compatible",
      model: "gpt-5.6-sol",
      capabilities: {
        contextWindowTokens: 333_000,
        maxOutputTokens: 22_000,
        supportsVisionInput: false,
      },
      updatedAt: "2026-08-24T00:00:00.000Z",
    },
  ];

  assert.equal(hasModelCapabilityOverride({ profile: activeProfile, overrides }), true);
  const capabilities = resolveModelCapabilities({ profile: activeProfile, overrides });
  assert.equal(capabilities.contextWindowTokens, 333_000);
  assert.equal(capabilities.maxOutputTokens, 22_000);
  assert.equal(capabilities.supportsStructuredOutputs, false);
  assert.equal(capabilities.supportsVisionInput, false);
  assert.deepEqual(capabilities.imageInput, { status: "unsupported", source: "override" });
});

test("override matching remains exact by model and scoped by provider", () => {
  const activeProfile = profile({ profileId: "work", model: "gpt-5.6-sol-preview" });
  const overrides = [{
    providerKind: "openai_compatible",
    model: "gpt-5.6-sol",
    capabilities: { contextWindowTokens: 123 },
    updatedAt: "2026-08-24T00:00:00.000Z",
  }];

  assert.equal(hasModelCapabilityOverride({ profile: activeProfile, overrides }), false);
  assert.equal(resolveModelCapabilities({ profile: activeProfile, overrides }).contextWindowTokens, 1_050_000);
});

test("protocol query and run plan expose the same tool-call facts", () => {
  const activeProfile = profile({ protocolKind: "openai_responses", model: "gpt-5.6-sol" });
  const modelCapabilities = resolveModelCapabilities({ profile: activeProfile });
  const protocol = resolveProtocolToolCallCapabilities("openai_responses");

  assert.deepEqual(protocol, {
    protocolKind: "openai_responses",
    canSendToolDefinitions: true,
    canReceiveToolCalls: true,
    canRoundTripToolResults: true,
  });
  assert.deepEqual(createRunCapabilityPlan({ profile: activeProfile, modelCapabilities }), {
    protocolToolCallCapabilities: protocol,
    modelCapabilities,
    canExposeModelTools: true,
  });
});

function profile(overrides = {}) {
  return {
    profileId: "default",
    label: "OpenAI",
    providerKind: "openai_compatible",
    protocolKind: "openai_compatible_chat_completions",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-sol",
    defaultAiMode: "openai-compatible",
    secretRef: "secret://model/default",
    enabled: true,
    secretConfigured: true,
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}
