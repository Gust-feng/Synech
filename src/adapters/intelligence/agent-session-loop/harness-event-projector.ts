import { createHash } from "node:crypto";
import {
  type AgentHarness,
  type AgentHarnessEvent,
  type AgentMessage,
  type Session,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentLoopInput,
  ProviderToolCall,
} from "../../../app/model-runtime/agent-loop.js";
import type { AgentSessionExecutionRefs } from "../../../app/model-runtime/agent-session.js";
import {
  serializeModelVisibleToolDefinitions,
  type ModelVisibleToolDefinitionSerialization,
} from "../../../app/model-runtime/tool-definition-visibility-cost.js";
import type { ModelUsage } from "../../../domain/intelligence/index.js";
import {
  cloneToolInputSchema,
  stableToolSchemaStringify,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDefinition,
} from "../../../domain/tools/index.js";
import { errorMessage } from "../../../kernel/values/index.js";
import { compactSessionContextIfNeeded } from "../session-context-compaction.js";
import { replaceUnsupportedImageBlocks } from "../session-image-placeholder.js";
import {
  piImmediateToolResult,
  toolResultFromDetails,
} from "../tool-result-transport.js";
import {
  modelMessageFromAssistant,
  modelUsageFromProvider,
} from "../provider-result-projection.js";
import { AgentSessionProviderTiming, mergeModelUsage } from "../agent-session-provider-timing.js";
import {
  ToolInvocationBindingTable,
  providerToolCallsForRound,
  requireAcceptedToolInvocations,
} from "../agent-session-tool-bindings.js";
import type { AgentSessionLoopOptions } from "./contracts.js";

type PendingToolRequest = {
  readonly request: ToolCallRequest;
  /** Visibility at the provider request that produced this call, before any same-batch load. */
  readonly modelVisibleAtRequest: boolean;
};

export type HarnessProjectionResultPort = {
  acceptObserved(result: ToolCallResult): Promise<void>;
  deliverPendingMessage(
    message: Extract<AgentMessage, { readonly role: "toolResult" }>,
    parentInvocationId?: string,
  ): Promise<void>;
};

type RootProjectionInput = Pick<
  AgentLoopInput,
  | "abortSignal"
  | "onModelContent"
  | "onSessionWriteCheckpoint"
  | "acceptToolInvocations"
  | "onToolRequested"
>;

export class RootHarnessEventProjector {
  private readonly pendingToolRequests = new Map<string, PendingToolRequest>();
  private readonly preparedToolCallIds = new Set<string>();
  private readonly compactionEntryIds: string[] = [];
  private readonly timing: AgentSessionProviderTiming;
  private inputEntryId: string | undefined;
  private latestLeafEntryId: string | null;
  private safeLeafEntryId: string | null;
  private currentUsage: ModelUsage = {};
  private currentMaintenanceFailure: { readonly code: string; readonly error: string } | undefined;
  private currentToolRequestAcceptanceFailure: unknown;

  constructor(private readonly options: {
    readonly input: RootProjectionInput;
    readonly loopOptions: AgentSessionLoopOptions;
    readonly sessionId: string;
    readonly agentSession: Session;
    readonly runtimeSession: Session;
    readonly startLeafEntryId: string | null;
    readonly modelInputSupportsImage: boolean;
    readonly rootBindings: ToolInvocationBindingTable;
    readonly resultPort: HarnessProjectionResultPort;
    readonly isCancellationRequested: () => boolean;
  }) {
    this.latestLeafEntryId = options.startLeafEntryId;
    this.safeLeafEntryId = options.startLeafEntryId;
    this.timing = new AgentSessionProviderTiming(options.loopOptions.now ?? (() => Date.now()));
  }

  attach(harness: AgentHarness, metadataByName: ReadonlyMap<string, ToolDefinition["metadata"]>): void {
    attachProviderPayloadHook(harness, this.options.loopOptions, metadataByName);
    harness.on("context", async ({ messages: contextMessages }) => {
      const messages = [...replaceUnsupportedImageBlocks(contextMessages, this.options.modelInputSupportsImage)];
      const sessionCompaction = await compactSessionContextIfNeeded({
        agentSession: this.options.runtimeSession,
        activeContextMessages: messages,
        modelRegistry: this.options.loopOptions.modelRegistry,
        selectedModel: harness.getModel(),
        thinkingLevel: harness.getThinkingLevel(),
        abortSignal: this.options.input.abortSignal,
        ...(this.options.loopOptions.compactionSettings === undefined
          ? {}
          : { compactionSettings: this.options.loopOptions.compactionSettings }),
      });
      if (sessionCompaction.status === "failed") {
        this.failMaintenance(sessionCompaction.code, sessionCompaction.error);
      }
      if (sessionCompaction.status === "compacted") {
        this.compactionEntryIds.push(sessionCompaction.compactionEntryRef.entryId);
        this.latestLeafEntryId = sessionCompaction.compactionEntryRef.entryId;
        try {
          await this.options.input.onSessionWriteCheckpoint?.({
            kind: "compaction_entry_committed",
            sessionId: this.options.sessionId,
            compactionEntryRef: sessionCompaction.compactionEntryRef,
            tokensBefore: sessionCompaction.tokensBefore,
          });
        } catch (error) {
          this.recordMaintenanceFailure({ code: "context_compaction_fact_rejected", error: errorMessage(error) });
          throw error;
        }
        this.safeLeafEntryId = sessionCompaction.compactionEntryRef.entryId;
        return { messages: [...sessionCompaction.compactedContextMessages] };
      }
      return { messages: [...messages] };
    });
    harness.on("session_before_compact", ({ preparation }) => {
      if (!compactionPreparationContainsImage(preparation)) return undefined;
      return { cancel: true };
    });
    harness.on("tool_result", ({ details }) => {
      const result = toolResultFromDetails(details);
      return result === undefined ? undefined : { isError: result.status !== "completed" };
    });
    harness.on("tool_call", ({ toolCallId }) => {
      this.preparedToolCallIds.add(toolCallId);
      return undefined;
    });
    harness.on("before_provider_request", () => {
      this.timing.startRequest();
      return undefined;
    });
    harness.subscribe(async (event) => { await this.project(event, harness); });
  }

  get usage(): ModelUsage {
    return this.currentUsage;
  }

  get maintenanceFailure(): { readonly code: string; readonly error: string } | undefined {
    return this.currentMaintenanceFailure;
  }

  get toolRequestAcceptanceFailure(): unknown {
    return this.currentToolRequestAcceptanceFailure;
  }

  mergeUsage(usage: ModelUsage | undefined, preserveLatestAgentRequest = false): void {
    this.currentUsage = mergeModelUsage(
      this.currentUsage,
      usage,
      preserveLatestAgentRequest ? { preserveLatestAgentRequest: true } : {},
    );
  }

  sessionExecutionRefs(): AgentSessionExecutionRefs {
    return {
      sessionId: this.options.sessionId,
      startLeafRef: this.options.startLeafEntryId === null
        ? null
        : { sessionId: this.options.sessionId, entryId: this.options.startLeafEntryId },
      ...(this.inputEntryId === undefined
        ? {}
        : { inputEntryRef: { sessionId: this.options.sessionId, entryId: this.inputEntryId } }),
      safeLeafRef: this.safeLeafEntryId === null
        ? null
        : { sessionId: this.options.sessionId, entryId: this.safeLeafEntryId },
      latestLeafRef: this.latestLeafEntryId === null
        ? null
        : { sessionId: this.options.sessionId, entryId: this.latestLeafEntryId },
      compactionEntryRefs: this.compactionEntryIds.map((entryId) => ({ sessionId: this.options.sessionId, entryId })),
    };
  }

  recordMaintenanceFailure(failure: { readonly code: string; readonly error: string }): void {
    this.currentMaintenanceFailure ??= failure;
  }

  failMaintenance(code: string, message: string): never {
    this.recordMaintenanceFailure({ code, error: message });
    throw new Error(message);
  }

  recordToolRequestAcceptanceFailure(error: unknown): void {
    this.currentToolRequestAcceptanceFailure ??= error;
  }

  private async project(event: AgentHarnessEvent, harness: AgentHarness): Promise<void> {
    if (event.type === "tool_execution_end") {
      await projectToolExecutionEnd({
        event,
        pendingRequest: this.pendingToolRequests.get(event.toolCallId),
        prepared: this.preparedToolCallIds.has(event.toolCallId),
        cancellationRequested: this.options.isCancellationRequested(),
        abortSignal: this.options.input.abortSignal,
        forget: () => {
          this.pendingToolRequests.delete(event.toolCallId);
          this.preparedToolCallIds.delete(event.toolCallId);
        },
        acceptObserved: (result) => this.options.resultPort.acceptObserved(result),
        emitRequested: (request) => emitToolRequested(this.options.input, request),
        failMaintenance: (code, message) => this.failMaintenance(code, message),
      });
      return;
    }
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        if (event.assistantMessageEvent.delta.length > 0) this.timing.observeVisibleOutput();
        await this.options.input.onModelContent?.({
          contentIndex: event.assistantMessageEvent.contentIndex,
          kind: "text",
          phase: "delta",
          content: event.assistantMessageEvent.delta,
        });
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        await this.options.input.onModelContent?.({
          contentIndex: event.assistantMessageEvent.contentIndex,
          kind: "thinking",
          phase: "delta",
          content: event.assistantMessageEvent.delta,
        });
      }
      if (event.assistantMessageEvent.type === "thinking_end") {
        await this.options.input.onModelContent?.({
          contentIndex: event.assistantMessageEvent.contentIndex,
          kind: "thinking",
          phase: "completed",
          content: event.assistantMessageEvent.content,
        });
      }
      return;
    }
    if (event.type === "turn_end") {
      if (event.message.role !== "assistant") return;
      const providerCallIds = (modelMessageFromAssistant(event.message).toolCalls ?? [])
        .map((call) => call.providerCallId);
      if (providerCallIds.length === 0) return;
      const invocationIds = providerCallIds.map((providerCallId) => {
        const binding = this.options.rootBindings.get(providerCallId);
        if (binding === undefined) {
          this.failMaintenance(
            "session_tool_request_missing",
            "Pi Session turn ended before Ordinary bound every assistant tool call.",
          );
        }
        return binding.invocationId;
      });
      const resultIds = event.toolResults.map((result) => result.toolCallId);
      if (!sameIds(providerCallIds, resultIds)) {
        this.failMaintenance(
          "session_tool_result_group_incomplete",
          "Pi Session turn ended without one tool result for every assistant tool call.",
        );
      }
      const entryId = await this.options.agentSession.getLeafId();
      if (entryId === null) throw new Error("Session did not expose the completed tool-result group leaf.");
      this.latestLeafEntryId = entryId;
      await this.options.input.onSessionWriteCheckpoint?.({
        kind: "tool_result_entries_committed",
        sessionId: this.options.sessionId,
        toolRoundLeafRef: { sessionId: this.options.sessionId, entryId },
        providerCallIds,
        invocationIds,
      });
      this.safeLeafEntryId = entryId;
      return;
    }
    if (event.type !== "message_end") return;
    const entryId = await this.options.agentSession.getLeafId();
    if (entryId === null) throw new Error("Session did not expose the entry appended by message_end.");
    this.latestLeafEntryId = entryId;
    if (event.message.role === "toolResult") {
      await this.options.resultPort.deliverPendingMessage(event.message);
      return;
    }
    if (event.message.role === "user") {
      this.inputEntryId ??= entryId;
      await this.options.input.onSessionWriteCheckpoint?.({
        kind: "input_entry_committed",
        sessionId: this.options.sessionId,
        inputEntryRef: { sessionId: this.options.sessionId, entryId },
      });
      this.safeLeafEntryId = entryId;
      return;
    }
    if (event.message.role !== "assistant") return;

    for (const [contentIndex, block] of event.message.content.entries()) {
      if (block.type !== "thinking") continue;
      await this.options.input.onModelContent?.({
        contentIndex,
        kind: "thinking",
        phase: "completed",
        content: block.thinking,
      });
    }
    const toolCalls = modelMessageFromAssistant(event.message).toolCalls ?? [];
    if (toolCalls.length > 0) {
      const providerCalls: readonly ProviderToolCall[] = providerToolCallsForRound(toolCalls, entryId);
      const boundRequests = requireAcceptedToolInvocations(
        providerCalls,
        await this.options.input.acceptToolInvocations(providerCalls),
        (message) => this.failMaintenance("session_tool_binding_mismatch", message),
      );
      this.options.rootBindings.replace(boundRequests);
      const providerCallIds = boundRequests.map((call) => call.providerCallId);
      const invocationIds = boundRequests.map((call) => call.invocationId);
      await this.options.input.onSessionWriteCheckpoint?.({
        kind: "assistant_tool_call_entry_committed",
        sessionId: this.options.sessionId,
        assistantEntryRef: { sessionId: this.options.sessionId, entryId },
        providerCallIds,
        invocationIds,
      });
      for (const call of boundRequests) emitToolRequested(this.options.input, call);
      this.rememberPendingToolRequests(boundRequests, harness.getActiveTools().map((tool) => tool.name));
    } else {
      await this.options.input.onSessionWriteCheckpoint?.({
        kind: "assistant_response_entry_committed",
        sessionId: this.options.sessionId,
        assistantEntryRef: { sessionId: this.options.sessionId, entryId },
      });
    }
    this.mergeUsage(modelUsageFromProvider(event.message.usage));
    this.currentUsage = this.timing.completeUsage(this.currentUsage, event.message.usage.output);
  }

  private rememberPendingToolRequests(
    requests: readonly ToolCallRequest[],
    activeToolNames: readonly string[],
  ): void {
    const active = new Set(activeToolNames);
    for (const request of requests) {
      if (this.pendingToolRequests.has(request.providerCallId)) {
        this.failMaintenance(
          "session_tool_request_duplicate",
          `Pi emitted duplicate pending tool call id ${request.providerCallId}.`,
        );
      }
      this.pendingToolRequests.set(request.providerCallId, {
        request: globalThis.structuredClone(request),
        modelVisibleAtRequest: active.has(request.toolName),
      });
    }
  }
}

export type ToolExecutionEndEvent = Extract<AgentHarnessEvent, { readonly type: "tool_execution_end" }>;

export async function projectToolExecutionEnd(input: {
  readonly event: ToolExecutionEndEvent;
  readonly pendingRequest: PendingToolRequest | undefined;
  readonly prepared: boolean;
  readonly cancellationRequested: boolean;
  readonly abortSignal: AbortSignal;
  readonly forget: () => void;
  readonly acceptObserved: (result: ToolCallResult) => Promise<void>;
  readonly emitRequested: (request: ToolCallRequest) => void;
  readonly failMaintenance: (code: string, message: string) => never;
}): Promise<void> {
  const canonical = toolResultFromDetails(input.event.result.details);
  if (canonical !== undefined) {
    input.forget();
    if (canonical.providerCallId !== input.event.toolCallId || canonical.toolName !== input.event.toolName) {
      input.failMaintenance(
        "session_tool_result_identity_mismatch",
        "Pi returned canonical tool details that do not match the active tool call.",
      );
    }
    return;
  }
  const pending = input.pendingRequest;
  if (pending === undefined || pending.request.toolName !== input.event.toolName) {
    input.failMaintenance(
      "session_tool_request_missing",
      "Pi returned a tool result without the matching accepted assistant tool request.",
    );
  }
  const request = pending.request;
  if (!input.prepared) input.emitRequested(request);
  const immediate = piImmediateToolResult({
    request,
    rawResult: input.event.result,
    prepared: input.prepared,
    knownActiveTool: pending.modelVisibleAtRequest,
    cancellationRequested: input.cancellationRequested || input.abortSignal.aborted,
  });
  await input.acceptObserved(immediate);
  input.forget();
}

export function attachProviderPayloadHook(
  harness: AgentHarness,
  options: Pick<
    AgentSessionLoopOptions,
    | "transformProviderPayload"
    | "onProviderToolDefinitionMetrics"
    | "toolDefinitionTokenCounter"
  >,
  metadataByName: ReadonlyMap<string, ToolDefinition["metadata"]>,
): void {
  if (options.transformProviderPayload === undefined && options.onProviderToolDefinitionMetrics === undefined) return;
  harness.on("before_provider_payload", ({ model, payload }) => {
    const tools = activeModelVisibleToolDefinitions(harness, metadataByName);
    const transformedPayload = options.transformProviderPayload?.({ model, payload, tools }) ?? payload;
    observeProviderToolDefinitionMetrics(options, tools, model);
    return { payload: transformedPayload };
  });
}

function activeModelVisibleToolDefinitions(
  harness: AgentHarness,
  metadataByName: ReadonlyMap<string, ToolDefinition["metadata"]>,
): ToolDefinition[] {
  return harness.getActiveTools().map((tool) => {
    const metadata = metadataByName.get(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: cloneToolInputSchema(tool.parameters),
      ...(metadata === undefined ? {} : { metadata: globalThis.structuredClone(metadata) }),
    };
  });
}

function observeProviderToolDefinitionMetrics(
  options: Pick<
    AgentSessionLoopOptions,
    "onProviderToolDefinitionMetrics" | "toolDefinitionTokenCounter"
  >,
  definitions: readonly ToolDefinition[],
  model: Model<Api>,
): void {
  const observer = options.onProviderToolDefinitionMetrics;
  if (observer === undefined) return;
  try {
    const countTokens = options.toolDefinitionTokenCounter ?? defaultToolDefinitionTokenCount;
    const serialized = serializeModelVisibleToolDefinitions(
      definitions,
      modelVisibleDefinitionSerialization(model),
    );
    const totalTokens = definitions.length === 0
      ? 0
      : normalizedToolDefinitionTokenCount(countTokens(JSON.stringify(serialized)));
    observer({
      toolCount: definitions.length,
      totalTokens,
      tools: definitions.map((definition, index) => ({
        toolName: definition.name,
        operationType: definition.metadata?.operationType ?? "read-write",
        definitionHash: createHash("sha256")
          .update(stableToolSchemaStringify(serialized[index]))
          .digest("hex"),
        definitionTokens: normalizedToolDefinitionTokenCount(countTokens(JSON.stringify(serialized[index]))),
      })),
    });
  } catch {
    // Observability must never alter the provider request or the owning run fact.
  }
}

function modelVisibleDefinitionSerialization(model: Model<Api>): ModelVisibleToolDefinitionSerialization {
  const api = model.api === "openai-completions" ? "openai-completions" : "openai-responses";
  const compat = model.compat as { readonly supportsStrictMode?: boolean } | undefined;
  return {
    api,
    includeStrict: api === "openai-responses" || compat?.supportsStrictMode !== false,
  };
}

function defaultToolDefinitionTokenCount(serializedDefinition: string): number {
  return Math.ceil(serializedDefinition.length / 4);
}

function normalizedToolDefinitionTokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function messageContainsImage(message: AgentMessage): boolean {
  return "content" in message && Array.isArray(message.content) && message.content.some((block) =>
    typeof block === "object" && block !== null && "type" in block && block.type === "image");
}

function compactionPreparationContainsImage(preparation: {
  readonly messagesToSummarize: readonly AgentMessage[];
  readonly turnPrefixMessages: readonly AgentMessage[];
}): boolean {
  return preparation.messagesToSummarize.some(messageContainsImage) ||
    preparation.turnPrefixMessages.some(messageContainsImage);
}

function emitToolRequested(input: RootProjectionInput, request: ToolCallRequest): void {
  try {
    input.onToolRequested?.(globalThis.structuredClone(request));
  } catch {
    // Requested activity is observational and cannot change execution.
  }
}

function sameIds(expected: readonly string[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length) return false;
  const actualIds = new Set(actual);
  return actualIds.size === actual.length && expected.every((id) => actualIds.has(id));
}
