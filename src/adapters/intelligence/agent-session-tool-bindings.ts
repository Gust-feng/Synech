import { isDeepStrictEqual } from "node:util";
import type { ModelToolCall } from "../../domain/intelligence/index.js";
import {
  toolInvocationId,
  type AcceptedToolInvocation,
  type ProviderToolCall,
  type ToolCallRequest,
} from "../../domain/tools/index.js";

export type ToolInvocationBinding = {
  readonly invocationId: string;
  readonly parentInvocationId?: string;
};

/** Provider-call lookup scoped to exactly one active assistant tool-call round. */
export class ToolInvocationBindingTable {
  private readonly bindings = new Map<string, ToolInvocationBinding>();

  get(providerCallId: string): ToolInvocationBinding | undefined {
    return this.bindings.get(providerCallId);
  }

  replace(calls: readonly AcceptedToolInvocation[]): void {
    this.bindings.clear();
    for (const call of calls) this.remember(call);
  }

  remember(call: Pick<AcceptedToolInvocation, "providerCallId" | "invocationId" | "parentInvocationId">): void {
    this.bindings.set(call.providerCallId, {
      invocationId: call.invocationId,
      ...(call.parentInvocationId === undefined ? {} : { parentInvocationId: call.parentInvocationId }),
    });
  }
}

/** Owner-accepted nested calls keyed independently from their child-harness provider ids. */
export class AcceptedNestedToolRequestRegistry {
  private readonly requests = new Map<string, ToolCallRequest>();

  has(invocationId: string): boolean {
    return this.requests.has(invocationId);
  }

  remember(request: ToolCallRequest): void {
    this.requests.set(toolInvocationId(request), globalThis.structuredClone(request));
  }

  matches(request: ToolCallRequest): boolean {
    const accepted = this.requests.get(toolInvocationId(request));
    return accepted !== undefined && sameNestedToolRequestShape(accepted, request);
  }
}

export function providerToolCallsForRound(
  calls: readonly ModelToolCall[],
  roundId: string,
  parentInvocationId?: string,
): readonly ProviderToolCall[] {
  return calls.map((call) => ({
    providerCallId: call.providerCallId,
    toolName: call.toolName,
    input: call.input,
    ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
    roundId,
  }));
}

export function acceptedToolRequests(
  calls: readonly AcceptedToolInvocation[],
  fallbackParentInvocationId?: string,
): readonly ToolCallRequest[] {
  return calls.map((call) => {
    const parentInvocationId = call.parentInvocationId ?? fallbackParentInvocationId;
    return {
      providerCallId: call.providerCallId,
      invocationId: call.invocationId,
      ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
      toolName: call.toolName,
      input: call.input,
    };
  });
}

/** Validates the owner-issued bindings before the adapter publishes or executes them. */
export function requireAcceptedToolInvocations(
  providerCalls: readonly ProviderToolCall[],
  accepted: readonly AcceptedToolInvocation[],
  reject: (message: string) => never,
): readonly AcceptedToolInvocation[] {
  if (accepted.length !== providerCalls.length) {
    reject("Ordinary returned a different number of tool invocation bindings than the provider emitted.");
  }
  const invocationIds = new Set<string>();
  for (let index = 0; index < providerCalls.length; index += 1) {
    const providerCall = providerCalls[index]!;
    const binding = accepted[index]!;
    if (binding.providerCallId !== providerCall.providerCallId ||
        binding.roundId !== providerCall.roundId ||
        binding.parentInvocationId !== providerCall.parentInvocationId ||
        binding.toolName !== providerCall.toolName ||
        !isDeepStrictEqual(binding.input, providerCall.input) ||
        binding.invocationId.trim().length === 0 ||
        invocationIds.has(binding.invocationId)) {
      reject("Ordinary returned tool invocation bindings that do not match the provider-issued order and definition.");
    }
    invocationIds.add(binding.invocationId);
  }
  return accepted;
}

function sameNestedToolRequestShape(left: ToolCallRequest, right: ToolCallRequest): boolean {
  return left.providerCallId === right.providerCallId
    && left.invocationId === right.invocationId
    && left.parentInvocationId === right.parentInvocationId
    && left.toolName === right.toolName
    && isDeepStrictEqual(left.input, right.input);
}
