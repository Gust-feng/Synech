import type {
  ConfiguredModelProtocolKind,
  ModelCapabilities,
  ProtocolToolCallCapabilities,
} from "../../domain/config/index.js";

const PROTOCOL_TOOL_CALL_CAPABILITIES: Record<ConfiguredModelProtocolKind, ProtocolToolCallCapabilities> = {
  openai_compatible_chat_completions: {
    protocolKind: "openai_compatible_chat_completions",
    canSendToolDefinitions: true,
    canReceiveToolCalls: true,
    canRoundTripToolResults: true,
  },
  openai_responses: {
    protocolKind: "openai_responses",
    canSendToolDefinitions: true,
    canReceiveToolCalls: true,
    canRoundTripToolResults: true,
  },
};

export function resolveProtocolToolCallCapabilities(
  protocolKind: ConfiguredModelProtocolKind,
): ProtocolToolCallCapabilities {
  return PROTOCOL_TOOL_CALL_CAPABILITIES[protocolKind];
}

export function supportsProtocolToolCalling(capabilities: ProtocolToolCallCapabilities): boolean {
  return capabilities.canSendToolDefinitions &&
    capabilities.canReceiveToolCalls &&
    capabilities.canRoundTripToolResults;
}

export function constrainCapabilitiesToProtocolToolCalling(
  capabilities: ModelCapabilities,
  protocolCapabilities: ProtocolToolCallCapabilities,
): ModelCapabilities {
  if (supportsProtocolToolCalling(protocolCapabilities)) return capabilities;
  return {
    ...capabilities,
    supportsToolCalling: false,
    supportsParallelToolCalls: false,
  };
}

export function preferredApiStyleForProtocol(
  protocolKind: ConfiguredModelProtocolKind,
): ModelCapabilities["preferredApiStyle"] {
  switch (protocolKind) {
    case "openai_compatible_chat_completions":
      return "chat_completions";
    case "openai_responses":
      return "responses";
  }
}
