import { createHash } from "node:crypto";
import {
  type AgentHarness,
  type AgentLane,
  type HarnessEvent,
  type AgentMessage,
  type Session,
} from "@earendil-works/pi-agent-core";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentSessionCheckpointKind,
  AgentSessionCheckpointRef,
} from "../../../app/model-runtime/agent-session.js";
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
import { replaceUnsupportedImageBlocks } from "../session-image-placeholder.js";
import {
  piImmediateToolResult,
  toolResultFromDetails,
} from "../tool-result-transport.js";
import {
  assistantText,
  modelMessageFromAssistant,
  modelUsageFromProvider,
} from "../provider-result-projection.js";
import { AgentSessionProviderTiming, mergeModelUsage } from "../agent-session-provider-timing.js";
import {
  ToolInvocationBindingTable,
  providerToolCallsForRound,
  requireAcceptedToolInvocations,
} from "../agent-session-tool-bindings.js";
import { getMainLeafId } from "../session-write-fence.js";
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
  private readonly compactionCheckpoints: AgentSessionCheckpointRef[] = [];
  private readonly timing: AgentSessionProviderTiming;
  private safeCheckpoint: AgentSessionCheckpointRef | null;
  private latestCheckpoint: AgentSessionCheckpointRef | null;
  private startCheckpoint: AgentSessionCheckpointRef | null = null;
  private currentUsage: ModelUsage = {};
  private currentMaintenanceFailure: { readonly code: string; readonly error: string } | undefined;
  private projectionAbort?: Promise<void>;
  private currentToolRequestAcceptanceFailure: unknown;
  private currentAssistant: Extract<AgentMessage, { readonly role: "assistant" }> | undefined;
  private latestAssistantEntryId: string | undefined;
  private readonly checkpointOrdinals = new Map<AgentSessionCheckpointKind, number>();

  constructor(private readonly options: {
    readonly input: RootProjectionInput;
    readonly loopOptions: AgentSessionLoopOptions;
    readonly sessionId: string;
    readonly agentSession: Session;
    readonly modelInputSupportsImage: boolean;
    readonly rootBindings: ToolInvocationBindingTable;
    readonly resultPort: HarnessProjectionResultPort;
    readonly isCancellationRequested: () => boolean;
  }) {
    this.latestCheckpoint = null;
    this.safeCheckpoint = null;
    this.timing = new AgentSessionProviderTiming(options.loopOptions.now ?? (() => Date.now()));
  }

  /**
   * Mints and records the product identity of the leaf this run started from.
   *
   * A run whose Session had no leaf yet gets no durable start checkpoint, which
   * the product ledger reads as "nothing before this run to roll back to".
   */
  async captureStart(providerEntryId: string | null): Promise<AgentSessionCheckpointRef | null> {
    if (providerEntryId === null) return null;
    const checkpoint = await this.checkpointFor("run_started", providerEntryId);
    this.startCheckpoint = checkpoint;
    this.latestCheckpoint = checkpoint;
    this.safeCheckpoint = checkpoint;
    return checkpoint;
  }

  /**
   * Mints and records the product identity of the run's final assistant entry.
   *
   * Pi commits several assistant entries per run — empty retries and
   * intermediate messages among them — and commits each entry only after its
   * message_end event, so "no tool calls" cannot identify the answer at
   * message_end time. Only the completed run knows which entry is the answer,
   * and by then that entry is durable.
   */
  async captureResponse(): Promise<AgentSessionCheckpointRef | null> {
    const entryId = this.latestAssistantEntryId;
    if (entryId === undefined) return null;
    const checkpoint = await this.checkpointFor("assistant_response_committed", entryId);
    this.latestCheckpoint = checkpoint;
    return checkpoint;
  }

  attach(
    harness: AgentHarness,
    lane: AgentLane,
    metadataByName: ReadonlyMap<string, ToolDefinition["metadata"]>,
  ): void {
    attachProviderPayloadHook(harness, lane, this.options.loopOptions, metadataByName);
    // Product context contributions enter through the runtime hook, not by
    // re-running compaction at the request boundary: Pi owns the threshold and
    // the summarization decision.
    harness.hooks.on("transform_context", async ({ messages }) => {
      const guarded = replaceUnsupportedImageBlocks(messages, this.options.modelInputSupportsImage);
      return await withMemoryBackground(guarded, this.options.loopOptions);
    });
    harness.hooks.on("after_tool", ({ details }) => {
      const result = toolResultFromDetails(details);
      return result === undefined ? undefined : { isError: result.status !== "completed" };
    });
    harness.hooks.on("before_tool", ({ toolCallId }) => {
      this.preparedToolCallIds.add(toolCallId);
      return undefined;
    });
    harness.hooks.on("before_request", () => {
      if (this.currentMaintenanceFailure !== undefined) {
        throw new Error(this.currentMaintenanceFailure.error);
      }
      this.timing.startRequest();
      return undefined;
    });
    harness.hooks.on("before_drive", () => {
      if (this.currentMaintenanceFailure !== undefined) {
        throw new Error(this.currentMaintenanceFailure.error);
      }
      return undefined;
    });
    // Returning the projection makes Pi await it before the next provider
    // request or tool execution. Dropping it would let tool execution outrun
    // invocation binding, or a checkpoint outrun its durable acceptance.
    harness.events.on("tool_end", (event) => this.project(event, harness, lane));
    harness.events.on("message_update", (event) => this.project(event, harness, lane));
    harness.events.on("turn_end", (event) => this.project(event, harness, lane));
    harness.events.on("message_end", (event) => this.project(event, harness, lane));
    harness.events.on("usage", (event) => {
      this.mergeUsage(modelUsageFromProvider(event.row.usage));
    });
    harness.events.on("compaction_end", (event) => this.projectCompaction(event, lane));
    harness.events.on("handler_error", (event) => {
      this.recordMaintenanceFailure({
        code: "runtime_handler_failed",
        error: event.error,
      });
      this.abortCurrentOperation(lane);
    });
  }

  private async projectCompaction(
    event: Extract<HarnessEvent, { readonly type: "compaction_end" }>,
    lane: AgentLane,
  ): Promise<void> {
    if (event.status !== "completed") return;
    if (this.currentMaintenanceFailure !== undefined) return;
    try {
      const checkpoint = await this.reportCompaction(event.entryId);
      this.compactionCheckpoints.push(checkpoint);
      this.latestCheckpoint = checkpoint;
      this.safeCheckpoint = checkpoint;
    } catch (error) {
      this.recordMaintenanceFailure({ code: "runtime_projection_failed", error: errorMessage(error) });
      this.abortCurrentOperation(lane);
      throw error;
    }
  }

  private abortCurrentOperation(lane: AgentLane): void {
    // Abort publishes events itself. Waiting here would deadlock the event bus
    // against its current delivery; the drive gate also rejects further work.
    this.projectionAbort ??= lane.inspectExecution(TODO_CONTEXT).then(async (execution) => {
      if (execution.current === null) return;
      const result = await lane.requestAbort(execution.current.id, TODO_CONTEXT);
      if (!result.ok) throw result.error;
    }).catch(() => undefined);
  }

  /**
   * Projection failures are reported by Pi's passive event bus, so the event
   * callback cannot wait for lane.abort without waiting on its own delivery
   * tail. The owning run waits here after Pi returns, allowing the abort to
   * finish the durable operation before the product outcome is settled.
   */
  async settleProjectionFailure(lane: AgentLane): Promise<void> {
    if (this.currentMaintenanceFailure === undefined) return;
    await this.projectionAbort;
    const inspected = await lane.inspectExecution(TODO_CONTEXT);
    if (inspected.current === null) return;
    const aborted = await lane.abort(TODO_CONTEXT);
    if (!aborted.ok && (aborted.error as { readonly _tag?: string })._tag !== "NoActiveOperation") {
      throw aborted.error;
    }
  }

  /**
   * Records one durable compaction checkpoint.
   *
   * Pi owns the compaction result. Synech records only the durable product
   * checkpoint for that result; it does not inspect or rewrite image history.
   */
  private async reportCompaction(entryId: string): Promise<AgentSessionCheckpointRef> {
    const entries = await this.options.agentSession.getEntries([entryId], TODO_CONTEXT);
    const entry = entries.get(entryId);
    if (entry === undefined || entry.type !== "compaction") {
      this.failMaintenance(
        "context_compaction_entry_missing",
        `Pi committed compaction entry ${entryId} that is not readable as a compaction entry.`,
      );
    }
    try {
      const checkpoint = await this.checkpointFor("compaction_committed", entryId);
      await this.options.input.onSessionWriteCheckpoint?.({
        kind: "compaction_entry_committed",
        checkpoint,
        sessionId: this.options.sessionId,
        tokensBefore: entry.tokensBefore,
      });
      return checkpoint;
    } catch (error) {
      this.recordMaintenanceFailure({ code: "context_compaction_fact_rejected", error: errorMessage(error) });
      throw error;
    }
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

  /** Latest assistant message observed for this run, carried by `message_end`. */
  get latestAssistant(): Extract<AgentMessage, { readonly role: "assistant" }> | undefined {
    return this.currentAssistant;
  }

  async checkpointFor(
    kind: AgentSessionCheckpointKind,
    providerEntryId: string,
  ): Promise<AgentSessionCheckpointRef> {
    return this.options.loopOptions.checkpointPort?.record(kind, providerEntryId) ??
      this.mintEphemeralCheckpoint(kind);
  }

  /**
   * Identity for a run without a durable minting authority. Product code never
   * sees it: no Session writer means no durable checkpoint to name.
   */
 private mintEphemeralCheckpoint(kind: AgentSessionCheckpointKind): Promise<AgentSessionCheckpointRef> {
    const ordinal = (this.checkpointOrdinals.get(kind) ?? 0) + 1;
    this.checkpointOrdinals.set(kind, ordinal);
    return Promise.resolve({
      sessionId: this.options.sessionId,
      checkpointId: `${kind}#${ordinal}`,
      kind,
    });
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
      startCheckpoint: this.startCheckpoint,
      safeCheckpoint: this.safeCheckpoint,
      latestCheckpoint: this.latestCheckpoint,
      compactionCheckpoints: [...this.compactionCheckpoints],
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

  private async project(event: HarnessEvent, harness: AgentHarness, lane: AgentLane): Promise<void> {
    if (this.currentMaintenanceFailure !== undefined) return;
    try {
      await this.projectEvent(event, harness, lane);
    } catch (error) {
      // A projection failure must converge the run, not escape as an unhandled
      // rejection. The first, most specific failure wins.
      this.recordMaintenanceFailure({ code: "runtime_projection_failed", error: errorMessage(error) });
      this.abortCurrentOperation(lane);
      throw error;
    }
  }

  private async projectEvent(event: HarnessEvent, harness: AgentHarness, lane: AgentLane): Promise<void> {
    if (event.type === "tool_end") {
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
      if (event.event.type === "text_delta") {
        if (event.event.delta.length > 0) this.timing.observeVisibleOutput();
        await this.options.input.onModelContent?.({
          contentIndex: event.event.contentIndex,
          kind: "text",
          phase: "delta",
          content: event.event.delta,
        });
      }
      if (event.event.type === "thinking_delta") {
        await this.options.input.onModelContent?.({
          contentIndex: event.event.contentIndex,
          kind: "thinking",
          phase: "delta",
          content: event.event.delta,
        });
      }
      if (event.event.type === "thinking_end") {
        await this.options.input.onModelContent?.({
          contentIndex: event.event.contentIndex,
          kind: "thinking",
          phase: "completed",
          content: event.event.content,
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
      const entryId = await getMainLeafId(this.options.agentSession);
      if (entryId === null) throw new Error("Session did not expose the completed tool-result group leaf.");
      const cp = await this.checkpointFor("tool_results_committed", entryId);
      this.latestCheckpoint = cp;
      await this.options.input.onSessionWriteCheckpoint?.({
        kind: "tool_result_entries_committed",
        checkpoint: cp,
        sessionId: this.options.sessionId,
        providerCallIds,
        invocationIds,
      });
      this.safeCheckpoint = cp;
      return;
    }
    if (event.type !== "message_end") return;
    // Pi reports the committed entry id on the event. Reading the branch tip
    // here would observe the previous entry: the lane advances the tip in the
    // commit that follows `message_end`, so the tip read is stale by one entry.
    if (event.entryId === undefined) {
      throw new Error("Pi message_end event did not report the committed entry id.");
    }
      const entryId = event.entryId;
      if (event.message.role === "toolResult") {
        await this.options.resultPort.deliverPendingMessage(event.message);
        return;
      }
      if (event.message.role === "user") {
        const cp = await this.checkpointFor("input_committed", entryId);
        this.latestCheckpoint = cp;
        await this.options.input.onSessionWriteCheckpoint?.({
          kind: "input_entry_committed",
          checkpoint: cp,
          sessionId: this.options.sessionId,
        });
        this.safeCheckpoint = cp;
        return;
    }
    if (event.message.role !== "assistant") return;
    this.currentAssistant = event.message;
    this.latestAssistantEntryId = entryId;

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
      const cp = await this.checkpointFor("assistant_tool_calls_committed", entryId);
      this.latestCheckpoint = cp;
      await this.options.input.onSessionWriteCheckpoint?.({
        kind: "assistant_tool_call_entry_committed",
        checkpoint: cp,
        sessionId: this.options.sessionId,
        // Pi commits this entry after the event, so the text travels with the
        // checkpoint instead of being read back from the Session.
        assistantText: assistantText(event.message),
        providerCallIds,
        invocationIds,
      });
      for (const call of boundRequests) emitToolRequested(this.options.input, call);
      this.rememberPendingToolRequests(boundRequests, await lane.getActiveTools(TODO_CONTEXT));
    }
    // No else branch: a tool-free assistant message is not necessarily the
    // answer. Pi commits several assistant entries per run — empty retries and
    // intermediate messages among them — and commits each entry only after its
    // message_end event, so minting here would both misclassify non-final
    // entries and name entries that are not durable yet. The final answer's
    // checkpoint is minted by captureResponse() when the run completes.
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

export type ToolExecutionEndEvent = Extract<HarnessEvent, { readonly type: "tool_end" }>;

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
  lane: AgentLane,
  options: Pick<
    AgentSessionLoopOptions,
    | "transformProviderPayload"
    | "onProviderToolDefinitionMetrics"
    | "toolDefinitionTokenCounter"
  >,
  metadataByName: ReadonlyMap<string, ToolDefinition["metadata"]>,
): void {
  if (options.transformProviderPayload === undefined && options.onProviderToolDefinitionMetrics === undefined) return;
  harness.hooks.on("before_payload", async ({ model, payload }) => {
    const tools = await activeModelVisibleToolDefinitions(harness, lane, metadataByName);
    const transformedPayload = options.transformProviderPayload?.({ model, payload, tools }) ?? payload;
    observeProviderToolDefinitionMetrics(options, tools, model);
    return { payload: transformedPayload };
  });
}

async function activeModelVisibleToolDefinitions(
  harness: AgentHarness,
  lane: AgentLane,
  metadataByName: ReadonlyMap<string, ToolDefinition["metadata"]>,
): Promise<ToolDefinition[]> {
  const harnessTools = await harness.getTools(TODO_CONTEXT);
  const activeToolNames = new Set(await lane.getActiveTools(TODO_CONTEXT));
  return harnessTools
    .filter((tool) => activeToolNames.has(tool.name))
    .map((tool) => {
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
  const api = toolDefinitionSerializationApiFor(model.api);
  const compat = model.compat as { readonly supportsStrictMode?: boolean } | undefined;
  return {
    api,
    includeStrict: api === "openai-responses" || compat?.supportsStrictMode !== false,
  };
}

function toolDefinitionSerializationApiFor(piApi: Api): ModelVisibleToolDefinitionSerialization["api"] {
  switch (piApi) {
    case "anthropic-messages":
      return "anthropic-messages";
    case "openai-completions":
      return "openai-completions";
    case "openai-responses":
      return "openai-responses";
    default:
      throw new Error(`Harness event projector cannot map Pi api ${JSON.stringify(piApi)} to a tool definition serialization.`);
  }
}

function defaultToolDefinitionTokenCount(serializedDefinition: string): number {
  return Math.ceil(serializedDefinition.length / 4);
}

function normalizedToolDefinitionTokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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

/**
 * 0.6.0 记忆背景：每次冻结前复核供给并作为独立临时 contribution 插入 provider
 * 上下文（置于会话历史之前、当前请求之后由消息序列自然满足）。pi 的 LLM 上下文
 * 中 systemPrompt 是独立字段、消息流没有 system 角色，因此合成 user 消息携带
 * advisory 头部承载背景；该消息不写入 Session 持久化、不进入 JSONL 投影，撤销/
 * 关闭后下一次冻结即消失。无可供给背景时按原样返回。
 */
async function withMemoryBackground(
  messages: readonly AgentMessage[],
  loopOptions: AgentSessionLoopOptions,
): Promise<{ readonly messages: AgentMessage[] }> {
  const resolver = loopOptions.resolveMemoryBackgroundBlock;
  if (resolver === undefined) return { messages: [...messages] };
  const block = await resolver();
  if (block === undefined || block.trim().length === 0) return { messages: [...messages] };
  const backgroundMessage: AgentMessage = {
    role: "user",
    content: block,
    timestamp: Date.now(),
  };
  return { messages: [backgroundMessage, ...messages] };
}
