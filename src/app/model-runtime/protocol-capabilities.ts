import type {
  ConfiguredModelProtocolKind,
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
  anthropic_messages: {
    protocolKind: "anthropic_messages",
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
