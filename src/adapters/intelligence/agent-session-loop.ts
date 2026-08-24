import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentHarnessEvent,
  type AgentMessage,
  type AgentTool,
  type AgentToolUpdateCallback,
  type CompactionSettings,
  type ExecutionEnv,
  type Session,
  type SessionTreeEntry,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import {
  Type,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import type {
  AgentLoop,
  AgentLoopAgentTool,
  AgentLoopAgentToolInvocation,
  AgentLoopContinuation,
  AgentLoopInput,
  AgentLoopResult,
  AgentLoopToolBoundary,
} from "../../app/model-runtime/agent-loop.js";
import {
  serializeModelVisibleToolDefinitions,
  type ModelVisibleToolDefinitionSerialization,
} from "../../app/model-runtime/tool-definition-visibility-cost.js";
import type { ConfirmationDecision, ConfirmationRequest } from "../../domain/confirmation/index.js";
import type { ModelUsage } from "../../domain/intelligence/index.js";
import {
  cloneToolInputSchema,
  modelVisibleToolDescription,
  normalizeToolFactValue,
  stableToolSchemaStringify,
  toolCallFactId,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDefinition,
  type ToolFactValue,
  type ToolOperationType,
} from "../../domain/tools/index.js";
import { compactSessionContextIfNeeded } from "./session-context-compaction.js";
import { replaceUnsupportedImageBlocks } from "./session-image-placeholder.js";
import type { ModelProviderPayloadTransformer } from "./model-provider-binding.js";
import {
  createToolVisibilitySession,
  narrowToolVisibilityPlan,
  type ToolVisibilityToolSet,
} from "./tool-visibility-session.js";
import {
  cancelledApprovalResult,
  cloneToolResult,
  deniedToolResult,
  harnessToolResult,
  pendingToolResultForMessage,
  piImmediateToolResult,
  requireApprovalRequiredResult,
  requireConfirmationRequest,
  toolRequestFromResult,
  toolResultAcceptanceFailure,
  toolResultForPiTransport,
  toolResultFromDetails,
  toolResultHasInlineImage,
  type PendingToolResultDelivery,
  type ToolExecutionDetails,
} from "./tool-result-transport.js";
import {
  assistantText,
  imageContentFromAttachments,
  modelMessageFromAssistant,
  modelUsageFromProvider,
  providerFailureFromAssistant,
  providerRefusalFromAssistant,
} from "./provider-result-projection.js";
import { errorMessage } from "../../kernel/values/index.js";

export type AgentSessionLoopOptions = {
  readonly executionEnvironment: ExecutionEnv;
  readonly modelRegistry: Models;
  readonly selectedModel: Model<Api>;
  /** Frozen Ordinary capability; Pi model.input remains the transport projection. */
  readonly supportsVisionInput?: boolean;
  readonly agentSession: Session;
  readonly thinkingLevel?: ThinkingLevel;
  readonly transformProviderPayload?: ModelProviderPayloadTransformer;
  readonly toolDefinitionTokenCounter?: AgentSessionToolDefinitionTokenCounter;
  readonly onProviderToolDefinitionMetrics?: AgentSessionToolDefinitionMetricsObserver;
  readonly compactionSettings?: CompactionSettings;
  /** Injectable clock for request timing observation. */
  readonly now?: () => number;
};

export type AgentSessionToolDefinitionTokenCounter = (serializedDefinition: string) => number;

export type AgentSessionToolDefinitionMetric = {
  readonly toolName: string;
  readonly operationType: ToolOperationType;
  readonly definitionHash: string;
  readonly definitionTokens: number;
};

export type AgentSessionToolDefinitionMetrics = {
  readonly toolCount: number;
  readonly totalTokens: number;
  readonly tools: readonly AgentSessionToolDefinitionMetric[];
};

export type AgentSessionToolDefinitionMetricsObserver = (
  metrics: AgentSessionToolDefinitionMetrics,
) => void;

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

type PendingApproval = {
  readonly result: ToolCallResult & { readonly status: "approval_required" };
  readonly decision: Deferred<ApprovalResolution>;
};

type PendingToolRequest = {
  readonly request: ToolCallRequest;
  /** Visibility at the provider request that produced this call, before any same-batch load. */
  readonly modelVisibleAtRequest: boolean;
};

type ApprovalResolution = {
  readonly kind: "resolved";
  readonly decision: ConfirmationDecision;
  readonly abortSignal: AbortSignal;
};

type DelegatedAgentResultGateway = AgentLoopToolBoundary["gateway"] & {
  readonly deliverResult: NonNullable<AgentLoopToolBoundary["gateway"]["deliverResult"]>;
};

type AgentSessionExecutionState = {
  readonly toolResults: Map<string, ToolCallResult>;
  readonly pendingToolResults: Map<string, PendingToolResultDelivery>;
  readonly approvals: ApprovalDecisionCoordinator;
  readonly sessionId: string;
  readonly agentSession: Session;
  readonly supportsVisionInput: boolean;
  readonly modelInputSupportsImage: boolean;
  readonly startLeafEntryId: string | null;
  readonly compactionEntryIds: string[];
  readonly abortSignalCleanups: Set<() => void>;
  readonly pendingRootToolRequests: Map<string, PendingToolRequest>;
  readonly preparedRootToolCallIds: Set<string>;
  readonly acceptedNestedToolRequests: Map<string, ToolCallRequest>;
  readonly now: () => number;
  readonly timing: ProviderTimingAccumulator;
  inputEntryId?: string;
  latestLeafEntryId: string | null;
  safeLeafEntryId: string | null;
  cancellationRequested: boolean;
  abortRun?: () => Promise<void>;
  usage: ModelUsage;
  maintenanceFailure?: { readonly code: string; readonly error: string };
  toolRequestAcceptanceFailure?: unknown;
  toolAcceptanceFailure?: unknown;
};

type ProviderRequestTiming = {
  readonly startedAtMs: number;
  firstVisibleOutputAtMs?: number;
};

type ProviderTimingAccumulator = {
  latencyTotalMs: number;
  latencySampleCount: number;
  firstTokenLatencyTotalMs: number;
  firstTokenLatencySampleCount: number;
  outputDurationTotalMs: number;
  outputDurationSampleCount: number;
  visibleOutputTokens: number;
  visibleOutputDurationMs: number;
  activeRequest?: ProviderRequestTiming;
};

type ActiveAgentLoopExecution = {
  readonly run: Promise<AssistantMessage>;
  readonly cancel: () => Promise<void>;
};

type DelegatedAgentExecutionMetrics = {
  modelRounds: number;
  toolCallCount: number;
  usage: ModelUsage;
};

/** Provider-neutral mechanical loop whose transcript is owned by one agent Session. */
export function createAgentSessionLoop(options: AgentSessionLoopOptions): AgentLoop {
  let activeExecution: ActiveAgentLoopExecution | undefined;
  let released = false;

  return {
    async execute(input) {
      if (released) throw new Error("Agent session loop has been released.");
      if (activeExecution !== undefined) throw new Error("Agent session loop is already executing.");
      if (input.abortSignal.aborted) return cancelledBeforeStart(input);
      const sessionId = (await options.agentSession.getMetadata()).id;
      const startEntryId = await options.agentSession.getLeafId();
      const state: AgentSessionExecutionState = {
        toolResults: new Map(),
        pendingToolResults: new Map(),
        approvals: new ApprovalDecisionCoordinator(),
        sessionId,
        agentSession: options.agentSession,
        supportsVisionInput: options.supportsVisionInput ?? options.selectedModel.input.includes("image"),
        modelInputSupportsImage: options.selectedModel.input.includes("image"),
        startLeafEntryId: startEntryId,
        compactionEntryIds: [],
        abortSignalCleanups: new Set(),
        pendingRootToolRequests: new Map(),
        preparedRootToolCallIds: new Set(),
        acceptedNestedToolRequests: new Map(),
        now: options.now ?? (() => Date.now()),
        timing: emptyProviderTimingAccumulator(),
        latestLeafEntryId: startEntryId,
        safeLeafEntryId: startEntryId,
        cancellationRequested: false,
        usage: {},
      };
      const prompt = preparePromptInput(input);
      await input.onSessionWriteCheckpoint?.({
        kind: "start_leaf_captured",
        sessionId,
        startLeafRef: startEntryId === null ? null : { sessionId, entryId: startEntryId },
      });
      const runtimeSession = createRunLocalContextSession(options.agentSession);
      const harnessTools = createHarnessTools(input, state, options);
      const harness = new AgentHarness({
        env: options.executionEnvironment,
        session: runtimeSession,
        models: options.modelRegistry,
        model: options.selectedModel,
        thinkingLevel: options.thinkingLevel,
        systemPrompt: input.instructions,
        tools: [...harnessTools.tools],
        activeToolNames: [...harnessTools.activeToolNames],
      });
      harnessTools.bind?.(harness);
      await harness.setActiveTools([...harnessTools.activeToolNames]);
      attachHarnessHooks(harness, input, state, options, runtimeSession, harnessTools.metadataByName);
      const run = harness.prompt(prompt.text, { images: prompt.images });
      let abortPromise: Promise<void> | undefined;
      const abort = (): Promise<void> => {
        abortPromise ??= harness.abort().then(() => undefined);
        return abortPromise;
      };
      const cancel = (): Promise<void> => {
        state.cancellationRequested = true;
        return abort();
      };
      state.abortRun = abort;
      const currentExecution: ActiveAgentLoopExecution = { run, cancel };
      activeExecution = currentExecution;
      bindRunAbortSignal(state, input.abortSignal);
      const clearActiveRun = (): void => {
        clearRunAbortSignals(state);
        if (activeExecution === currentExecution) activeExecution = undefined;
      };
      void run.then(clearActiveRun, clearActiveRun);
      const settle = async (): Promise<AgentLoopResult> => {
        try {
          const assistant = await run;
          return finalResult(assistant, input, state, options.selectedModel.contextWindow);
        } catch (error) {
          return failedRunResult(error, input, state);
        }
      };
      return state.approvals.wait(settle, () => approvalResult(input, state, settle));
    },
    async release() {
      released = true;
      const currentExecution = activeExecution;
      if (currentExecution !== undefined) {
        try {
          await currentExecution.cancel();
        } finally {
          await currentExecution.run.catch(() => undefined);
          if (activeExecution === currentExecution) activeExecution = undefined;
        }
      }
    },
  };
}

function preparePromptInput(
  input: AgentLoopInput,
): { readonly text: string; readonly images?: ImageContent[] } {
  const withoutSystem = input.messages.filter((message) => message.role !== "system");
  const current = withoutSystem.at(-1);
  if (current?.role !== "user") {
    throw new Error("Agent loop input must end with the current user message.");
  }
  const images = imageContentFromAttachments(current.attachments);
  return {
    text: current.content,
    ...(images.length === 0 ? {} : { images }),
  };
}

/** Keeps dynamic tool activation markers scoped to the run that produced them. */
function createRunLocalContextSession(session: Session): Session {
  const currentRunMessageEntryIds = new Set<string>();
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === "appendMessage") {
        return async (message: AgentMessage) => {
          const entryId = await target.appendMessage(message);
          currentRunMessageEntryIds.add(entryId);
          return entryId;
        };
      }
      if (property === "buildContext") {
        return async (...args: Parameters<Session["buildContext"]>) => {
          const options = args[0] ?? {};
          return target.buildContext({
            ...options,
            entryTransforms: [
              ...(options.entryTransforms ?? []),
              (entries: readonly SessionTreeEntry[]) => entries.map((entry) =>
                stripPriorRunToolActivationMarker(entry, currentRunMessageEntryIds)),
            ],
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Session;
}

function stripPriorRunToolActivationMarker(
  entry: SessionTreeEntry,
  currentRunMessageEntryIds: ReadonlySet<string>,
): SessionTreeEntry {
  if (entry.type !== "message" || entry.message.role !== "toolResult" ||
      currentRunMessageEntryIds.has(entry.id) || entry.message.addedToolNames === undefined) {
    return entry;
  }
  const { addedToolNames: _historicalActivation, ...message } = entry.message;
  return { ...entry, message };
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

function createHarnessTools(
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  options: AgentSessionLoopOptions,
): ToolVisibilityToolSet {
  const allowed = new Set(input.tools.permission.allowedTools);
  const agentTools = input.agentTools ?? [];
  const agentToolNames = new Set(agentTools.map((tool) => tool.toolName));
  const definitionsByName = new Map(input.tools.definitions.map((definition) => [definition.name, definition]));
  const mechanicalDefinitions = input.tools.definitions
    .filter((definition) => allowed.has(definition.name) && !agentToolNames.has(definition.name));
  const mechanicalTools = mechanicalDefinitions
    .map((definition) => createHarnessTool(definition, input, state, input.tools));
  const delegatedTools = agentTools.length === 0
    ? []
    : agentTools.map((agentTool) => createDelegatedAgentTool(
        requireFrozenToolDefinition(definitionsByName, agentTool.toolName),
        agentTool,
        input,
        state,
        options,
        requireDelegatedAgentResultGateway(input.tools.gateway),
      ));
  return createToolVisibilitySession({
    tools: [...mechanicalTools, ...delegatedTools],
    metadataByName: new Map([
      ...mechanicalDefinitions.map((definition) => [definition.name, definition.metadata] as const),
      ...agentTools.map((agentTool) => [agentTool.toolName, undefined] as const),
    ]),
    visibilityPlan: input.toolVisibilityPlan,
    host: toolVisibilityHost(input, state),
  });
}

function toolVisibilityHost(
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  requestScope?: (request: ToolCallRequest) => ToolCallRequest,
  onToolInvoked?: () => void,
) {
  return {
    abortSignal: input.abortSignal,
    ...(requestScope === undefined ? {} : { requestScope }),
    onToolRequested: (request: ToolCallRequest) => emitToolRequested(input, request),
    ...(onToolInvoked === undefined ? {} : { onToolInvoked }),
    acceptResult: (result: ToolCallResult) => acceptToolResultForDelivery(input, state, result),
    projectResult: (
      result: ToolCallResult,
      terminate: boolean,
      addedToolNames?: readonly string[],
    ) => harnessToolResult(result, state, terminate, addedToolNames),
    recordMaintenanceFailure: (failure: { readonly code: string; readonly error: string }) => {
      state.maintenanceFailure ??= failure;
    },
  };
}

function createHarnessTool(
  definition: ToolDefinition,
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  boundary: AgentLoopToolBoundary,
  requestScope?: (request: ToolCallRequest) => ToolCallRequest,
  onToolInvoked?: () => void,
): AgentTool {
  return {
    name: definition.name,
    label: definition.name,
    description: modelVisibleToolDescription(definition),
    parameters: Type.Unsafe(globalThis.structuredClone(definition.inputSchema)),
    executionMode: "parallel",
    async execute(callId, parameters, signal, onUpdate) {
      const unscopedRequest: ToolCallRequest = {
        callId,
        toolName: definition.name,
        input: normalizeToolFactValue(parameters),
      };
      const request = requestScope?.(unscopedRequest) ?? unscopedRequest;
      emitToolRequested(input, request);
      assertNestedToolRequestAccepted(state, request);
      onToolInvoked?.();
      let context = toolExecutionContext(input, boundary, request, signal, onUpdate);
      const preflight = boundary.gateway.preflight(request, context, boundary.permission);
      if (preflight.status === "blocked") {
        const deliveryFailure = await acceptToolResultForDelivery(input, state, preflight.result);
        if (deliveryFailure !== undefined) return deliveryFailure;
        return harnessToolResult(preflight.result, state, preflight.result.status === "cancelled");
      }
      let approvedConfirmationIds = boundary.permission.approvedConfirmationIds;
      if (preflight.status === "approval_required") {
        const approval = requireApprovalRequiredResult(preflight.result);
        const resolution = await resolveApproval(input, state, approval, context);
        if (resolution.kind === "delivery_failure") return resolution.response;
        if (resolution.kind === "cancelled") return harnessToolResult(resolution.result, state, true);
        if (resolution.kind === "denied") return harnessToolResult(resolution.result, state, false);
        approvedConfirmationIds = uniqueStrings([
          ...(approvedConfirmationIds ?? []),
          requireConfirmationRequest(approval).confirmationId,
        ]);
        context = toolExecutionContext(
          input,
          boundary,
          request,
          continuedToolAbortSignal(context.abortSignal, input.abortSignal, resolution.abortSignal),
          onUpdate,
        );
      }
      let executionRequest = preflight.status === "ready" ? preflight.request : toolRequestFromResult(preflight.result);
      while (true) {
        const result = await boundary.gateway.execute(
          executionRequest,
          context,
          { ...boundary.permission, approvedConfirmationIds },
        );
        if (result.status !== "approval_required") {
          const deliveryFailure = await acceptToolResultForDelivery(input, state, result);
          if (deliveryFailure !== undefined) return deliveryFailure;
          return harnessToolResult(result, state, result.status === "cancelled");
        }

        // ToolCenter may discover a gate after starting a read-only operation. Keep
        // that partial result as a fact before waiting, then retry only after the
        // matching confirmation has been accepted.
        const approval = requireApprovalRequiredResult(result);
        const resolution = await resolveApproval(input, state, approval, context);
        if (resolution.kind === "delivery_failure") return resolution.response;
        if (resolution.kind === "cancelled") return harnessToolResult(resolution.result, state, true);
        if (resolution.kind === "denied") return harnessToolResult(resolution.result, state, false);
        approvedConfirmationIds = uniqueStrings([
          ...(approvedConfirmationIds ?? []),
          requireConfirmationRequest(approval).confirmationId,
        ]);
        context = toolExecutionContext(
          input,
          boundary,
          executionRequest,
          continuedToolAbortSignal(context.abortSignal, input.abortSignal, resolution.abortSignal),
          onUpdate,
        );
        executionRequest = toolRequestFromResult(approval);
      }
    },
  };
}

function createDelegatedAgentTool(
  definition: ToolDefinition,
  contribution: AgentLoopAgentTool,
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  options: AgentSessionLoopOptions,
  resultGateway: DelegatedAgentResultGateway,
): AgentTool {
  return {
    name: definition.name,
    label: definition.name,
    description: modelVisibleToolDescription(definition),
    parameters: Type.Unsafe(globalThis.structuredClone(definition.inputSchema)),
    executionMode: "parallel",
    async execute(callId, parameters, signal) {
      const request: ToolCallRequest = {
        callId,
        toolName: contribution.toolName,
        input: normalizeToolFactValue(parameters),
      };
      emitToolRequested(input, request);
      const startedAt = Date.now();
      let result: ToolCallResult;
      try {
        const invocation = validateDelegatedToolBoundary(
          input.tools,
          input.agentTools ?? [],
          await contribution.resolve(requiredDelegatedAgentInput(request)),
        );
        result = await runDelegatedAgent({
          invocation,
          request,
          input,
          state,
          options,
          abortSignal: signal ?? input.abortSignal,
          startedAt,
        });
      } catch (error) {
        result = delegatedAgentFailure(request, error, signal?.aborted === true || input.abortSignal.aborted, startedAt);
      }
      const delivered = await deliverDelegatedAgentResult(input, resultGateway, result);
      const acceptanceFailure = await acceptToolResultForDelivery(input, state, delivered);
      return acceptanceFailure ?? harnessToolResult(
        delivered,
        state,
        state.toolRequestAcceptanceFailure !== undefined ||
          state.toolAcceptanceFailure !== undefined ||
          state.maintenanceFailure !== undefined ||
          delivered.status === "cancelled",
      );
    },
  };
}

async function runDelegatedAgent(input: {
  readonly invocation: AgentLoopAgentToolInvocation;
  readonly request: ToolCallRequest;
  readonly input: AgentLoopInput;
  readonly state: AgentSessionExecutionState;
  readonly options: AgentSessionLoopOptions;
  readonly abortSignal: AbortSignal;
  readonly startedAt: number;
}): Promise<ToolCallResult> {
  const parentFactId = toolCallFactId(input.request);
  const boundary = delegatedToolBoundary(input.input.tools, input.invocation);
  const metrics: DelegatedAgentExecutionMetrics = { modelRounds: 0, toolCallCount: 0, usage: {} };
  const session = await new InMemorySessionRepo().create({ id: `delegated-agent:${parentFactId}` });
  const toolDefinitions = boundary.definitions
    .filter((definition) => boundary.permission.allowedTools.includes(definition.name));
  const tools = toolDefinitions.map((definition) => createHarnessTool(
    definition,
    input.input,
    input.state,
    boundary,
    (request) => scopedDelegatedToolRequest(parentFactId, request),
    () => { metrics.toolCallCount += 1; },
  ));
  const requestScope = (request: ToolCallRequest): ToolCallRequest =>
    scopedDelegatedToolRequest(parentFactId, request);
  const harnessTools = createToolVisibilitySession({
    tools,
    metadataByName: new Map(toolDefinitions.map((definition) => [definition.name, definition.metadata] as const)),
    visibilityPlan: narrowToolVisibilityPlan(
      input.input.toolVisibilityPlan,
      input.invocation.allowedTools,
      toolDefinitions,
      input.options.toolDefinitionTokenCounter,
    ),
    host: toolVisibilityHost(
      input.input,
      input.state,
      requestScope,
      () => { metrics.toolCallCount += 1; },
    ),
  });
  const harness = new AgentHarness({
    env: input.options.executionEnvironment,
    session,
    models: input.options.modelRegistry,
    model: input.options.selectedModel,
    thinkingLevel: input.options.thinkingLevel,
    systemPrompt: input.invocation.instructions,
    tools: [...harnessTools.tools],
    activeToolNames: [...harnessTools.activeToolNames],
  });
  harnessTools.bind?.(harness);
  await harness.setActiveTools([...harnessTools.activeToolNames]);
  attachDelegatedHarnessHooks(
    harness,
    session,
    parentFactId,
    input.input,
    input.state,
    input.options,
    input.abortSignal,
    harnessTools.metadataByName,
    metrics,
  );
  const handleAbort = (): void => { void harness.abort().catch(() => undefined); };
  input.abortSignal.addEventListener("abort", handleAbort, { once: true });
  if (input.abortSignal.aborted) handleAbort();
  try {
    const assistant = await harness.prompt(input.invocation.input);
    if (input.abortSignal.aborted || assistant.stopReason === "aborted") {
      return delegatedAgentFailure(input.request, input.abortSignal.reason ?? assistant.errorMessage, true, input.startedAt, metrics);
    }
    if (assistant.stopReason !== "stop") {
      return delegatedAgentFailure(
        input.request,
        assistant.errorMessage ?? `Delegated agent stopped with ${assistant.stopReason}.`,
        false,
        input.startedAt,
        metrics,
      );
    }
    return {
      ...input.request,
      output: assistantText(assistant),
      status: "completed",
      delegatedExecution: delegatedExecutionMetadata(metrics),
      durationMs: Math.max(0, Date.now() - input.startedAt),
    };
  } finally {
    input.abortSignal.removeEventListener("abort", handleAbort);
  }
}

function attachDelegatedHarnessHooks(
  harness: AgentHarness,
  agentSession: Session,
  parentFactId: string,
  loopInput: AgentLoopInput,
  state: AgentSessionExecutionState,
  options: AgentSessionLoopOptions,
  abortSignal: AbortSignal,
  metadataByName: ReadonlyMap<string, ToolDefinition["metadata"]>,
  metrics: DelegatedAgentExecutionMetrics,
): void {
  const pendingRequests = new Map<string, PendingToolRequest>();
  const preparedToolCallIds = new Set<string>();
  attachProviderPayloadHook(harness, options, metadataByName);
  harness.on("context", async ({ messages: contextMessages }) => {
    // A text-only model cannot see image blocks already present in the
    // Session; replace them with an observable text notice so the turn still
    // runs. The Session itself keeps the original image bytes so a later
    // vision-capable model can still reference them.
    const messages = [...replaceUnsupportedImageBlocks(contextMessages, state.modelInputSupportsImage)];
    const compaction = await compactSessionContextIfNeeded({
      agentSession,
      activeContextMessages: messages,
      modelRegistry: options.modelRegistry,
      selectedModel: harness.getModel(),
      thinkingLevel: harness.getThinkingLevel(),
      abortSignal,
      ...(options.compactionSettings === undefined ? {} : { compactionSettings: options.compactionSettings }),
    });
    if (compaction.status === "failed") throw new Error(compaction.error);
    return compaction.status === "compacted"
      ? { messages: [...compaction.compactedContextMessages] }
      : { messages: [...messages] };
  });
  harness.on("session_before_compact", ({ preparation }) => {
    // Pi-native compaction cannot summarize image content for a text-only
    // model; the request-boundary compaction path already replaces images
    // with text notices. Skipping this compaction must not fail the run.
    if (!compactionPreparationContainsImage(preparation)) return undefined;
    return { cancel: true };
  });
  harness.on("tool_result", ({ details }) => {
    const result = toolResultFromDetails(details);
    return result === undefined ? undefined : { isError: result.status !== "completed" };
  });
  harness.on("tool_call", ({ toolCallId }) => {
    preparedToolCallIds.add(toolCallId);
    return undefined;
  });
  harness.subscribe(async (event) => {
    if (event.type === "tool_execution_end") {
      await projectToolExecutionEnd({
        event,
        input: loopInput,
        state,
        pendingRequests,
        preparedToolCallIds,
        abortSignal,
      });
      return;
    }
    if (event.type === "message_end" && event.message.role === "toolResult") {
      const delivery = pendingToolResultForMessage(
        state.pendingToolResults,
        event.message,
        parentFactId,
        (error) => throwHarnessMaintenanceFailure(state, "session_tool_result_identity_mismatch", error),
      );
      if (delivery !== undefined) {
        await deliverAcceptedToolResult(loopInput, state, delivery);
      }
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const requests = (modelMessageFromAssistant(event.message).toolCalls ?? [])
        .map((request) => scopedDelegatedToolRequest(parentFactId, request));
      const batchFactIds = new Set<string>();
      for (const scoped of requests) {
        const factId = toolCallFactId(scoped);
        if (batchFactIds.has(factId) || state.acceptedNestedToolRequests.has(factId)) {
          throwHarnessMaintenanceFailure(
            state,
            "session_tool_request_duplicate",
            `Pi reused delegated tool fact ${factId}.`,
          );
        }
        batchFactIds.add(factId);
        if (pendingRequests.has(scoped.callId)) {
          throwHarnessMaintenanceFailure(
            state,
            "session_tool_request_duplicate",
            `Pi emitted duplicate delegated tool call id ${scoped.callId}.`,
          );
        }
      }
      if (requests.length > 0) {
        try {
          await loopInput.onNestedToolRequestsAccepted?.(
            requests.map((request) => globalThis.structuredClone(request)),
          );
        } catch (error) {
          state.toolRequestAcceptanceFailure ??= error;
          throw error;
        }
      }
      for (const scoped of requests) {
        state.acceptedNestedToolRequests.set(toolCallFactId(scoped), globalThis.structuredClone(scoped));
        pendingRequests.set(scoped.callId, {
          request: scoped,
          modelVisibleAtRequest: harness.getActiveTools().some((tool) => tool.name === scoped.toolName),
        });
      }
      const usage = modelUsageFromProvider(event.message.usage);
      metrics.modelRounds += 1;
      metrics.usage = mergeUsage(metrics.usage, usage);
      // A child request contributes to the run total but is not a parent model
      // request, so it must not replace the parent's context-capacity snapshot.
      state.usage = mergeUsage(state.usage, usage, { preserveLatestAgentRequest: true });
    }
  });
}

function attachHarnessHooks(
  harness: AgentHarness,
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  options: AgentSessionLoopOptions,
  runtimeSession: Session,
  metadataByName: ReadonlyMap<string, ToolDefinition["metadata"]>,
): void {
  attachProviderPayloadHook(harness, options, metadataByName);
  harness.on("context", async ({ messages: contextMessages }) => {
    // A text-only model cannot see image blocks already present in the
    // Session; replace them with an observable text notice so the turn still
    // runs. The Session itself keeps the original image bytes so a later
    // vision-capable model can still reference them.
    const messages = [...replaceUnsupportedImageBlocks(contextMessages, state.modelInputSupportsImage)];
    const sessionCompaction = await compactSessionContextIfNeeded({
      agentSession: runtimeSession,
      activeContextMessages: messages,
      modelRegistry: options.modelRegistry,
      selectedModel: harness.getModel(),
      thinkingLevel: harness.getThinkingLevel(),
      abortSignal: input.abortSignal,
      ...(options.compactionSettings === undefined
        ? {}
        : { compactionSettings: options.compactionSettings }),
    });
    if (sessionCompaction.status === "failed") {
      state.maintenanceFailure = { code: sessionCompaction.code, error: sessionCompaction.error };
      throw new Error(sessionCompaction.error);
    }
    if (sessionCompaction.status === "compacted") {
      state.compactionEntryIds.push(sessionCompaction.compactionEntryRef.entryId);
      state.latestLeafEntryId = sessionCompaction.compactionEntryRef.entryId;
      try {
        await input.onSessionWriteCheckpoint?.({
          kind: "compaction_entry_committed",
          sessionId: state.sessionId,
          compactionEntryRef: sessionCompaction.compactionEntryRef,
          tokensBefore: sessionCompaction.tokensBefore,
        });
      } catch (error) {
        state.maintenanceFailure = { code: "context_compaction_fact_rejected", error: errorMessage(error) };
        throw error;
      }
      state.safeLeafEntryId = sessionCompaction.compactionEntryRef.entryId;
      return { messages: [...sessionCompaction.compactedContextMessages] };
    }
    return { messages: [...messages] };
  });
  harness.on("session_before_compact", ({ preparation }) => {
    // Pi-native compaction cannot summarize image content for a text-only
    // model; the request-boundary compaction path already replaces images
    // with text notices. Skipping this compaction must not fail the run.
    if (!compactionPreparationContainsImage(preparation)) return undefined;
    return { cancel: true };
  });
  harness.on("tool_result", ({ details }) => {
    const result = toolResultFromDetails(details);
    return result === undefined ? undefined : { isError: result.status !== "completed" };
  });
  harness.on("tool_call", ({ toolCallId }) => {
    state.preparedRootToolCallIds.add(toolCallId);
    return undefined;
  });
  harness.on("before_provider_request", () => {
    state.timing.activeRequest = { startedAtMs: state.now() };
    return undefined;
  });
  harness.subscribe(async (event) => {
    await projectHarnessEvent(event, input, state, harness);
  });
}

function attachProviderPayloadHook(
  harness: AgentHarness,
  options: AgentSessionLoopOptions,
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
  options: AgentSessionLoopOptions,
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
      tools: definitions.map((definition, index) => {
        const serializedDefinition = JSON.stringify(serialized[index]);
        return {
          toolName: definition.name,
          operationType: definition.metadata?.operationType ?? "read-write",
          definitionHash: createHash("sha256")
            .update(stableToolSchemaStringify(serialized[index]))
            .digest("hex"),
          definitionTokens: normalizedToolDefinitionTokenCount(countTokens(serializedDefinition)),
        };
      }),
    });
  } catch {
    // Observability must never alter the provider request or the owning run fact.
  }
}

function modelVisibleDefinitionSerialization(
  model: Model<Api>,
): ModelVisibleToolDefinitionSerialization {
  const api = model.api === "openai-completions"
    ? "openai-completions"
    : "openai-responses";
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

async function projectHarnessEvent(
  event: AgentHarnessEvent,
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  harness: AgentHarness,
): Promise<void> {
  if (event.type === "tool_execution_end") {
    await projectToolExecutionEnd({
      event,
      input,
      state,
      pendingRequests: state.pendingRootToolRequests,
      preparedToolCallIds: state.preparedRootToolCallIds,
      abortSignal: input.abortSignal,
    });
    return;
  }
  if (event.type === "message_update") {
    if (event.assistantMessageEvent.type === "text_delta") {
      const activeRequest = state.timing.activeRequest;
      if (
        event.assistantMessageEvent.delta.length > 0 &&
        activeRequest !== undefined &&
        activeRequest.firstVisibleOutputAtMs === undefined
      ) {
        activeRequest.firstVisibleOutputAtMs = state.now();
      }
      input.onTextDelta?.(event.assistantMessageEvent.delta);
    }
    if (event.assistantMessageEvent.type === "thinking_delta") input.onReasoningDelta?.(event.assistantMessageEvent.delta);
    return;
  }
  if (event.type === "turn_end") {
    if (event.message.role !== "assistant") return;
    const toolCallIds = (modelMessageFromAssistant(event.message).toolCalls ?? []).map((call) => call.callId);
    if (toolCallIds.length === 0) return;
    const resultIds = event.toolResults.map((result) => result.toolCallId);
    if (!sameIds(toolCallIds, resultIds)) {
      state.maintenanceFailure = {
        code: "session_tool_result_group_incomplete",
        error: "Pi Session turn ended without one tool result for every assistant tool call.",
      };
      throw new Error(state.maintenanceFailure.error);
    }
    const entryId = await state.agentSession.getLeafId();
    if (entryId === null) throw new Error("Session did not expose the completed tool-result group leaf.");
    state.latestLeafEntryId = entryId;
    await input.onSessionWriteCheckpoint?.({
      kind: "tool_result_entries_committed",
      sessionId: state.sessionId,
      toolRoundLeafRef: { sessionId: state.sessionId, entryId },
      toolCallIds,
    });
    state.safeLeafEntryId = entryId;
    return;
  }
  if (event.type !== "message_end") return;
  const entryId = await state.agentSession.getLeafId();
  if (entryId === null) throw new Error("Session did not expose the entry appended by message_end.");
  state.latestLeafEntryId = entryId;
  if (event.message.role === "toolResult") {
    const delivery = pendingToolResultForMessage(
      state.pendingToolResults,
      event.message,
      undefined,
      (error) => throwHarnessMaintenanceFailure(state, "session_tool_result_identity_mismatch", error),
    );
    if (delivery !== undefined) {
      await deliverAcceptedToolResult(input, state, delivery);
    }
    return;
  }
  if (event.message.role === "user") {
    state.inputEntryId ??= entryId;
    await input.onSessionWriteCheckpoint?.({
      kind: "input_entry_committed",
      sessionId: state.sessionId,
      inputEntryRef: { sessionId: state.sessionId, entryId },
    });
    state.safeLeafEntryId = entryId;
    return;
  }
  if (event.message.role === "assistant") {
    const message = modelMessageFromAssistant(event.message);
    const toolCalls = message.toolCalls ?? [];
    // 先落思考完成事实，再落消息正文检查点：模型在同一轮里先思考、后输出正文、
    // 再调用工具，思考的持久位置必须保持在正文与工具之前（尊重原始流顺序）。
    const reasoning = event.message.content
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join("\n");
    if (reasoning.length > 0) await input.onReasoningCompleted?.(reasoning);
    if (toolCalls.length > 0) {
      const toolCallIds = toolCalls.map((call) => call.callId);
      await input.onSessionWriteCheckpoint?.({
        kind: "assistant_tool_call_entry_committed",
        sessionId: state.sessionId,
        assistantEntryRef: { sessionId: state.sessionId, entryId },
        toolCallIds,
      });
      rememberPendingToolRequests(
        state,
        toolCalls,
        harness.getActiveTools().map((tool) => tool.name),
      );
    } else {
      await input.onSessionWriteCheckpoint?.({
        kind: "assistant_response_entry_committed",
        sessionId: state.sessionId,
        assistantEntryRef: { sessionId: state.sessionId, entryId },
      });
    }
    state.usage = mergeUsage(state.usage, modelUsageFromProvider(event.message.usage));
    state.usage = applyCompletedProviderTiming(state, event.message.usage.output);
    return;
  }
}

type ToolExecutionEndEvent = Extract<AgentHarnessEvent, { readonly type: "tool_execution_end" }>;

async function projectToolExecutionEnd(input: {
  readonly event: ToolExecutionEndEvent;
  readonly input: AgentLoopInput;
  readonly state: AgentSessionExecutionState;
  readonly pendingRequests: Map<string, PendingToolRequest>;
  readonly preparedToolCallIds: Set<string>;
  readonly abortSignal: AbortSignal;
}): Promise<void> {
  const canonical = toolResultFromDetails(input.event.result.details);
  if (canonical !== undefined) {
    input.pendingRequests.delete(input.event.toolCallId);
    input.preparedToolCallIds.delete(input.event.toolCallId);
    if (canonical.callId !== input.event.toolCallId || canonical.toolName !== input.event.toolName) {
      throwHarnessMaintenanceFailure(
        input.state,
        "session_tool_result_identity_mismatch",
        "Pi returned canonical tool details that do not match the active tool call.",
      );
    }
    return;
  }

  const pending = input.pendingRequests.get(input.event.toolCallId);
  if (pending === undefined || pending.request.toolName !== input.event.toolName) {
    throwHarnessMaintenanceFailure(
      input.state,
      "session_tool_request_missing",
      "Pi returned a tool result without the matching accepted assistant tool request.",
    );
  }
  const request = pending.request;
  const prepared = input.preparedToolCallIds.has(input.event.toolCallId);
  if (!prepared) emitToolRequested(input.input, request);
  const result = piImmediateToolResult({
    request,
    rawResult: input.event.result,
    prepared,
    knownActiveTool: pending.modelVisibleAtRequest,
    cancellationRequested: input.abortSignal.aborted || input.state.cancellationRequested,
  });
  await acceptToolResult(input.input, input.state, result);
  input.pendingRequests.delete(input.event.toolCallId);
  input.preparedToolCallIds.delete(input.event.toolCallId);
}

function rememberPendingToolRequests(
  state: AgentSessionExecutionState,
  requests: readonly ToolCallRequest[],
  activeToolNames: readonly string[],
): void {
  const active = new Set(activeToolNames);
  for (const request of requests) {
    if (state.pendingRootToolRequests.has(request.callId)) {
      throwHarnessMaintenanceFailure(
        state,
        "session_tool_request_duplicate",
        `Pi emitted duplicate pending tool call id ${request.callId}.`,
      );
    }
    state.pendingRootToolRequests.set(request.callId, {
      request: globalThis.structuredClone(request),
      modelVisibleAtRequest: active.has(request.toolName),
    });
  }
}

function throwHarnessMaintenanceFailure(
  state: AgentSessionExecutionState,
  code: string,
  error: string,
): never {
  state.maintenanceFailure ??= { code, error };
  throw new Error(error);
}

function approvalResult(
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  settle: () => Promise<AgentLoopResult>,
): AgentLoopResult {
  return {
    status: "approval_required",
    toolResults: [...state.toolResults.values()].map(cloneToolResult),
    usage: state.usage,
    confirmationRequests: state.approvals.requests(),
    session: sessionExecutionRefs(state),
    continuation: approvalContinuation(input, state, settle),
  };
}

function approvalContinuation(
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  settle: () => Promise<AgentLoopResult>,
): AgentLoopContinuation {
  let consumed = false;
  return {
    availability: "live_only",
    async decide(decisionInput) {
      if (consumed) {
        return failedResult(state, "Agent loop approval continuation has already been decided.", "confirmation_already_decided");
      }
      if (decisionInput.abortSignal.aborted || input.abortSignal.aborted) {
        state.cancellationRequested = true;
        await abortRun(state);
        return cancelledResult(state, decisionInput.abortSignal.reason ?? input.abortSignal.reason);
      }
      try {
        bindRunAbortSignal(state, decisionInput.abortSignal);
        state.approvals.decide(
          "decisions" in decisionInput ? decisionInput.decisions : [decisionInput.decision],
          decisionInput.abortSignal,
        );
      } catch (error) {
        await abortRun(state);
        return failedResult(state, errorMessage(error), "confirmation_decision_mismatch");
      }
      consumed = true;
      // Let each released request resume before returning the next remaining
      // approval set. This preserves one-at-a-time UI decisions without
      // turning an approved tool into a batch barrier.
      await Promise.resolve();
      return state.approvals.wait(settle, () => approvalResult(input, state, settle));
    },
  };
}

function finalResult(
  assistant: AssistantMessage,
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  contextWindow: number,
): AgentLoopResult {
  const facts = resultFacts(state);
  if (input.abortSignal.aborted || state.cancellationRequested) {
    return { ...facts, status: "cancelled", error: abortMessage(input.abortSignal.reason) };
  }
  if (state.maintenanceFailure !== undefined) {
    return {
      ...facts,
      status: "failed",
      error: state.maintenanceFailure.error,
      errorCode: state.maintenanceFailure.code,
    };
  }
  if (state.toolRequestAcceptanceFailure !== undefined) {
    return {
      ...facts,
      status: "failed",
      error: errorMessage(state.toolRequestAcceptanceFailure),
      errorCode: "tool_request_acceptance_failed",
    };
  }
  if (state.toolAcceptanceFailure !== undefined) {
    return { ...facts, status: "failed", error: errorMessage(state.toolAcceptanceFailure), errorCode: "tool_result_acceptance_failed" };
  }
  if (assistant.stopReason === "aborted") {
    return { ...facts, status: "cancelled", error: assistant.errorMessage ?? "cancelled" };
  }
  const refusal = providerRefusalFromAssistant(assistant);
  if (refusal !== undefined) {
    return {
      ...facts,
      status: "failed",
      error: refusal.length === 0
        ? "The model refused the request without an explanation."
        : `The model refused the request: ${refusal}`,
      errorCode: "model_refusal",
    };
  }
  const providerFailure = providerFailureFromAssistant(assistant, contextWindow);
  if (providerFailure !== undefined) {
    return { ...facts, status: "failed", ...providerFailure };
  }
  if (assistant.stopReason === "length") {
    const incompleteReason = assistant.providerMetadata?.incompleteReason?.trim();
    return {
      ...facts,
      status: "failed",
      error: incompleteReason === undefined || incompleteReason.length === 0
        ? "Model stopped before completing its response."
        : `Model response was incomplete: ${incompleteReason}.`,
      errorCode: incompleteReason === "content_filter" ? "content_filtered" : "output_truncated",
    };
  }
  if (assistant.stopReason !== "stop") {
    return {
      ...facts,
      status: "failed",
      error: assistant.errorMessage ?? `Model stopped with ${assistant.stopReason}.`,
      errorCode: "agent_loop_failed",
    };
  }
  return { ...facts, status: "completed", finalText: assistantText(assistant) };
}

function failedRunResult(error: unknown, input: AgentLoopInput, state: AgentSessionExecutionState): AgentLoopResult {
  if (input.abortSignal.aborted || state.cancellationRequested) {
    return cancelledResult(state, input.abortSignal.reason ?? error);
  }
  if (state.maintenanceFailure !== undefined) {
    return failedResult(state, state.maintenanceFailure.error, state.maintenanceFailure.code);
  }
  if (state.toolRequestAcceptanceFailure !== undefined) {
    return failedResult(state, errorMessage(state.toolRequestAcceptanceFailure), "tool_request_acceptance_failed");
  }
  if (state.toolAcceptanceFailure !== undefined) {
    return failedResult(state, errorMessage(state.toolAcceptanceFailure), "tool_result_acceptance_failed");
  }
  if (isAbortError(error)) return cancelledResult(state, error);
  return failedResult(state, errorMessage(error), "agent_loop_failed");
}

function failedResult(state: AgentSessionExecutionState, error: string, errorCode: string): AgentLoopResult {
  return { ...resultFacts(state), status: "failed", error, errorCode };
}

function cancelledResult(state: AgentSessionExecutionState, reason: unknown): AgentLoopResult {
  return { ...resultFacts(state), status: "cancelled", error: abortMessage(reason) };
}

function cancelledBeforeStart(input: AgentLoopInput): AgentLoopResult {
  return {
    status: "cancelled",
    toolResults: [],
    usage: {},
    confirmationRequests: [],
    error: abortMessage(input.abortSignal.reason),
  };
}

function resultFacts(state: AgentSessionExecutionState) {
  return {
    toolResults: [...state.toolResults.values()].map(cloneToolResult),
    usage: state.usage,
    confirmationRequests: [] as const,
    session: sessionExecutionRefs(state),
  };
}

function sessionExecutionRefs(state: AgentSessionExecutionState) {
  const entry = (entryId: string) => ({ sessionId: state.sessionId, entryId });
  return {
    sessionId: state.sessionId,
    startLeafRef: state.startLeafEntryId === null ? null : entry(state.startLeafEntryId),
    ...(state.inputEntryId === undefined ? {} : { inputEntryRef: entry(state.inputEntryId) }),
    safeLeafRef: state.safeLeafEntryId === null ? null : entry(state.safeLeafEntryId),
    latestLeafRef: state.latestLeafEntryId === null ? null : entry(state.latestLeafEntryId),
    compactionEntryRefs: state.compactionEntryIds.map(entry),
  };
}

async function abortRun(state: AgentSessionExecutionState): Promise<void> {
  try {
    await state.abortRun?.();
  } catch {
    // The owning resource lease reports cleanup failures without replacing the primary run outcome.
  }
}

type ResolvedToolApproval =
  | { readonly kind: "approved"; readonly abortSignal: AbortSignal }
  | { readonly kind: "denied"; readonly result: ToolCallResult }
  | { readonly kind: "cancelled"; readonly result: ToolCallResult }
  | { readonly kind: "delivery_failure"; readonly response: ReturnType<typeof harnessToolResult> };

async function resolveApproval(
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  approval: ToolCallResult & { readonly status: "approval_required" },
  context: ReturnType<typeof toolExecutionContext>,
): Promise<ResolvedToolApproval> {
  const deliveryFailure = await acceptToolResultForDelivery(input, state, approval);
  if (deliveryFailure !== undefined) {
    return { kind: "delivery_failure", response: deliveryFailure };
  }
  let resolution: ApprovalResolution;
  try {
    resolution = await state.approvals.request(approval, context.abortSignal);
  } catch (error) {
    if (!context.abortSignal.aborted && !input.abortSignal.aborted) throw error;
    const cancelled = cancelledApprovalResult(approval, error);
    const cancellationDeliveryFailure = await acceptToolResultForDelivery(input, state, cancelled);
    return cancellationDeliveryFailure === undefined
      ? { kind: "cancelled", result: cancelled }
      : { kind: "delivery_failure", response: cancellationDeliveryFailure };
  }
  if (resolution.decision.decision !== "approve_once") {
    const denied = deniedToolResult(approval, resolution.decision);
    const denialDeliveryFailure = await acceptToolResultForDelivery(input, state, denied);
    return denialDeliveryFailure === undefined
      ? { kind: "denied", result: denied }
      : { kind: "delivery_failure", response: denialDeliveryFailure };
  }
  return { kind: "approved", abortSignal: resolution.abortSignal };
}

class ApprovalDecisionCoordinator {
  private readonly pending = new Map<string, PendingApproval>();
  private change = deferred<void>();

  async request(
    result: ToolCallResult & { readonly status: "approval_required" },
    abortSignal: AbortSignal,
  ): Promise<ApprovalResolution> {
    if (abortSignal.aborted) throw abortReason(abortSignal);
    const confirmationId = requireConfirmationRequest(result).confirmationId;
    if (this.pending.has(confirmationId)) throw new Error(`Duplicate confirmation ${confirmationId}.`);
    const decision = deferred<ApprovalResolution>();
    this.pending.set(confirmationId, { result, decision });
    this.notifyChange();
    const handleAbort = (): void => {
      decision.reject(abortReason(abortSignal));
    };
    abortSignal.addEventListener("abort", handleAbort, { once: true });
    try {
      return await decision.promise;
    } finally {
      abortSignal.removeEventListener("abort", handleAbort);
      if (this.pending.get(confirmationId)?.decision === decision) {
        this.pending.delete(confirmationId);
        this.notifyChange();
      }
    }
  }

  requests(): ConfirmationRequest[] {
    return [...this.pending.values()].map((entry) =>
      globalThis.structuredClone(requireConfirmationRequest(entry.result)));
  }

  decide(decisions: readonly ConfirmationDecision[], abortSignal: AbortSignal): void {
    const unique = new Map(decisions.map((decision) => [decision.confirmationId, decision]));
    if (unique.size !== decisions.length || [...unique.keys()].some((id) => !this.pending.has(id))) {
      throw new Error("Agent loop confirmation decisions do not match pending confirmations.");
    }
    for (const [id, decision] of unique) {
      const entry = this.pending.get(id)!;
      this.pending.delete(id);
      entry.decision.resolve({ kind: "resolved", decision, abortSignal });
    }
    this.notifyChange();
  }

  async wait(
    settle: () => Promise<AgentLoopResult>,
    approval: () => AgentLoopResult,
  ): Promise<AgentLoopResult> {
    if (this.pending.size > 0) return approval();
    const change = this.change.promise;
    return Promise.race([
      settle(),
      change.then(async () => {
        await Promise.resolve();
        return this.pending.size > 0 ? approval() : this.wait(settle, approval);
      }),
    ]);
  }

  private notifyChange(): void {
    const previous = this.change;
    this.change = deferred<void>();
    previous.resolve(undefined);
  }
}

async function acceptToolResult(
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  result: ToolCallResult,
): Promise<PendingToolResultDelivery> {
  const deliverable = toolResultForPiTransport(
    result,
    state.supportsVisionInput,
    state.modelInputSupportsImage,
  );
  const factId = toolCallFactId(deliverable);
  state.toolResults.set(factId, cloneToolResult(deliverable));
  const delivery: PendingToolResultDelivery = { result: deliverable };
  if (toolResultHasInlineImage(deliverable)) {
    state.pendingToolResults.set(factId, delivery);
  } else {
    await deliverAcceptedToolResult(input, state, { result: deliverable });
  }
  return delivery;
}

async function deliverAcceptedToolResult(
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  delivery: PendingToolResultDelivery,
): Promise<void> {
  const result = delivery.result;
  state.pendingToolResults.delete(toolCallFactId(result));
  try {
    await input.onToolResult?.(cloneToolResult(result));
  } catch (error) {
    state.toolAcceptanceFailure ??= error;
    state.toolResults.set(toolCallFactId(result), toolResultAcceptanceFailure(result, error));
    throw error;
  }
}

function assertNestedToolRequestAccepted(
  state: AgentSessionExecutionState,
  request: ToolCallRequest,
): void {
  if (request.parentToolCallFactId === undefined) return;
  const accepted = state.acceptedNestedToolRequests.get(toolCallFactId(request));
  if (accepted !== undefined && JSON.stringify(accepted) === JSON.stringify(request)) return;
  throwHarnessMaintenanceFailure(
    state,
    "nested_tool_request_not_accepted",
    `Nested tool request ${toolCallFactId(request)} reached execution without owner acceptance.`,
  );
}

async function acceptToolResultForDelivery(
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  result: ToolCallResult,
) {
  try {
    await acceptToolResult(input, state, result);
    return undefined;
  } catch (error) {
    const failure = toolResultAcceptanceFailure(result, error);
    state.toolResults.set(toolCallFactId(failure), failure);
    return harnessToolResult(failure, state, true);
  }
}

function toolExecutionContext(
  input: AgentLoopInput,
  boundary: AgentLoopToolBoundary,
  request: ToolCallRequest,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<ToolExecutionDetails> | undefined,
) {
  return {
    ...boundary.context,
    toolCallId: toolCallFactId(request),
    abortSignal: signal ?? input.abortSignal,
    ...(input.onToolProgress === undefined ? {} : {
      reportProgress: (progress: Parameters<NonNullable<typeof input.onToolProgress>>[0]["progress"]) => {
        input.onToolProgress?.({
          callId: request.callId,
          ...(request.factId === undefined ? {} : { factId: request.factId }),
          toolName: request.toolName,
          progress,
        });
        onUpdate?.({
          content: [{ type: "text", text: "Tool progress updated." }],
          details: { kind: "progress" },
        });
      },
    }),
  };
}

/**
 * Approval continuation adds a decision-scoped signal; it must not replace the
 * run or Pi tool signal that was already governing the operation.
 */
function continuedToolAbortSignal(
  toolSignal: AbortSignal,
  runSignal: AbortSignal,
  decisionSignal: AbortSignal,
): AbortSignal {
  return AbortSignal.any([toolSignal, runSignal, decisionSignal]);
}

function validateDelegatedToolBoundary(
  parent: AgentLoopToolBoundary,
  agentTools: readonly AgentLoopAgentTool[],
  invocation: AgentLoopAgentToolInvocation,
): AgentLoopAgentToolInvocation {
  const parentAllowed = new Set(parent.permission.allowedTools);
  const delegatedNames = new Set(agentTools.map((tool) => tool.toolName));
  const requested = uniqueStrings(invocation.allowedTools);
  const unavailable = requested.filter((name) =>
    !parentAllowed.has(name) || !parent.gateway.has(name) || delegatedNames.has(name));
  if (unavailable.length > 0) {
    throw new Error(`Delegated agent requested tools outside the parent boundary: ${unavailable.join(", ")}`);
  }
  return { ...invocation, allowedTools: requested };
}

function requiredDelegatedAgentInput(request: ToolCallRequest): ToolFactValue {
  if (request.input === undefined) {
    throw new Error(`Delegated agent tool ${request.toolName} requires a JSON input value.`);
  }
  return request.input;
}

function delegatedToolBoundary(
  parent: AgentLoopToolBoundary,
  invocation: AgentLoopAgentToolInvocation,
): AgentLoopToolBoundary {
  return {
    definitions: parent.definitions.filter((definition) => invocation.allowedTools.includes(definition.name)),
    gateway: parent.gateway,
    context: { ...parent.context, callerAgentId: invocation.callerAgentId },
    permission: {
      ...parent.permission,
      callerAgentId: invocation.callerAgentId,
      allowedTools: [...invocation.allowedTools],
    },
  };
}

function requireFrozenToolDefinition(
  definitions: ReadonlyMap<string, ToolDefinition>,
  toolName: string,
): ToolDefinition {
  const definition = definitions.get(toolName);
  if (definition === undefined) {
    throw new Error(`Agent tool ${toolName} has no frozen definition in this run.`);
  }
  return definition;
}

function scopedDelegatedToolRequest(parentFactId: string, request: ToolCallRequest): ToolCallRequest {
  return {
    ...request,
    factId: delegatedToolFactId(parentFactId, request.callId),
    parentToolCallFactId: parentFactId,
  };
}

function delegatedToolFactId(parentFactId: string, providerCallId: string): string {
  return `agent-tool:${parentFactId.length}:${parentFactId}/tool:${providerCallId}`;
}

async function deliverDelegatedAgentResult(
  input: AgentLoopInput,
  gateway: DelegatedAgentResultGateway,
  result: ToolCallResult,
): Promise<ToolCallResult> {
  try {
    return await gateway.deliverResult.call(
      gateway,
      result,
      input.tools.permission,
      input.tools.context.traceId,
    );
  } catch (error) {
    return {
      ...result,
      output: undefined,
      status: "failed",
      error: `Delegated agent output could not be delivered: ${errorMessage(error)}`,
      errorDomain: "runtime_error",
      errorFacts: {
        code: "sub_agent_result_delivery_failed",
        sourceExecutionStatus: result.status,
        doNotBlindlyRetry: true,
      },
      confirmationRequest: undefined,
    };
  }
}

function requireDelegatedAgentResultGateway(
  gateway: AgentLoopToolBoundary["gateway"],
): DelegatedAgentResultGateway {
  if (gateway.deliverResult === undefined) {
    throw new Error("Delegated agent tools require a gateway with complete result delivery.");
  }
  return gateway as DelegatedAgentResultGateway;
}

function delegatedAgentFailure(
  request: ToolCallRequest,
  error: unknown,
  cancelled: boolean,
  startedAt: number,
  metrics?: DelegatedAgentExecutionMetrics,
): ToolCallResult {
  return {
    ...request,
    output: undefined,
    status: cancelled ? "cancelled" : "failed",
    error: cancelled
      ? `Delegated agent was cancelled: ${abortMessage(error)}`
      : `Delegated agent failed: ${errorMessage(error)}`,
    errorDomain: cancelled ? "runtime_error" : "model_error",
    errorFacts: { code: cancelled ? "sub_agent_cancelled" : "sub_agent_execution_failed" },
    ...(metrics === undefined ? {} : { delegatedExecution: delegatedExecutionMetadata(metrics) }),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function delegatedExecutionMetadata(metrics: DelegatedAgentExecutionMetrics) {
  return {
    modelRounds: metrics.modelRounds,
    toolCallCount: metrics.toolCallCount,
    usage: globalThis.structuredClone(metrics.usage),
  };
}

function bindRunAbortSignal(state: AgentSessionExecutionState, signal: AbortSignal): void {
  const abort = (): void => {
    state.cancellationRequested = true;
    void state.abortRun?.().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const cleanup = (): void => signal.removeEventListener("abort", abort);
  state.abortSignalCleanups.add(cleanup);
  if (signal.aborted) abort();
}

function clearRunAbortSignals(state: AgentSessionExecutionState): void {
  for (const cleanup of state.abortSignalCleanups) cleanup();
  state.abortSignalCleanups.clear();
}

function emitToolRequested(input: AgentLoopInput, request: ToolCallRequest): void {
  try {
    input.onToolRequested?.(globalThis.structuredClone(request));
  } catch {
    // Requested activity is observational and cannot change execution.
  }
}

function emptyProviderTimingAccumulator(): ProviderTimingAccumulator {
  return {
    latencyTotalMs: 0,
    latencySampleCount: 0,
    firstTokenLatencyTotalMs: 0,
    firstTokenLatencySampleCount: 0,
    outputDurationTotalMs: 0,
    outputDurationSampleCount: 0,
    visibleOutputTokens: 0,
    visibleOutputDurationMs: 0,
  };
}

/**
 * Pi exposes stream deltas but not request timings. Keep this run-local
 * accumulator separate from the durable Session so completed Ordinary usage
 * contains only timing facts we actually observed at the root harness.
 */
function applyCompletedProviderTiming(
  state: AgentSessionExecutionState,
  outputTokens: number,
): ModelUsage {
  const request = state.timing.activeRequest;
  state.timing.activeRequest = undefined;
  if (request === undefined) return state.usage;

  const completedAtMs = state.now();
  const latencyMs = elapsedMs(request.startedAtMs, completedAtMs);
  state.timing.latencyTotalMs += latencyMs;
  state.timing.latencySampleCount += 1;

  if (request.firstVisibleOutputAtMs !== undefined) {
    const firstTokenLatencyMs = elapsedMs(request.startedAtMs, request.firstVisibleOutputAtMs);
    const outputDurationMs = elapsedMs(request.firstVisibleOutputAtMs, completedAtMs);
    state.timing.firstTokenLatencyTotalMs += firstTokenLatencyMs;
    state.timing.firstTokenLatencySampleCount += 1;
    state.timing.outputDurationTotalMs += outputDurationMs;
    state.timing.outputDurationSampleCount += 1;
    if (Number.isFinite(outputTokens) && outputTokens > 0 && outputDurationMs > 0) {
      state.timing.visibleOutputTokens += Math.floor(outputTokens);
      state.timing.visibleOutputDurationMs += outputDurationMs;
    }
  }

  return {
    ...state.usage,
    latencyMs: averageDuration(state.timing.latencyTotalMs, state.timing.latencySampleCount),
    ...(state.timing.firstTokenLatencySampleCount === 0 ? {} : {
      firstTokenLatencyMs: averageDuration(
        state.timing.firstTokenLatencyTotalMs,
        state.timing.firstTokenLatencySampleCount,
      ),
      outputDurationMs: averageDuration(
        state.timing.outputDurationTotalMs,
        state.timing.outputDurationSampleCount,
      ),
    }),
    ...(state.timing.visibleOutputDurationMs === 0 ? {} : {
      outputTokensPerSecond: Number((
        state.timing.visibleOutputTokens / (state.timing.visibleOutputDurationMs / 1_000)
      ).toFixed(2)),
    }),
  };
}

function elapsedMs(startedAtMs: number, completedAtMs: number): number {
  return Math.max(0, Math.round(completedAtMs - startedAtMs));
}

function averageDuration(totalMs: number, sampleCount: number): number {
  return Math.round(totalMs / sampleCount);
}

function mergeUsage(
  current: ModelUsage,
  next: ModelUsage | undefined,
  options: { readonly preserveLatestAgentRequest?: boolean } = {},
): ModelUsage {
  if (next === undefined) return current;
  return {
    requestCount: (current.requestCount ?? 0) + (next.requestCount ?? 0),
    inputTokens: (current.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (current.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0),
    cachedInputTokens: (current.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    cacheWriteInputTokens: (current.cacheWriteInputTokens ?? 0) + (next.cacheWriteInputTokens ?? 0),
    uncachedInputTokens: (current.uncachedInputTokens ?? 0) + (next.uncachedInputTokens ?? 0),
    reasoningOutputTokens: (current.reasoningOutputTokens ?? 0) + (next.reasoningOutputTokens ?? 0),
    estimatedCostUsd: (current.estimatedCostUsd ?? 0) + (next.estimatedCostUsd ?? 0),
    ...(current.latencyMs === undefined ? {} : { latencyMs: current.latencyMs }),
    ...(current.firstTokenLatencyMs === undefined ? {} : { firstTokenLatencyMs: current.firstTokenLatencyMs }),
    ...(current.outputDurationMs === undefined ? {} : { outputDurationMs: current.outputDurationMs }),
    ...(current.outputTokensPerSecond === undefined ? {} : { outputTokensPerSecond: current.outputTokensPerSecond }),
    latestAgentRequest: options.preserveLatestAgentRequest
      ? current.latestAgentRequest
      : next.latestAgentRequest ?? current.latestAgentRequest,
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function sameIds(expected: readonly string[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length) return false;
  const actualIds = new Set(actual);
  return actualIds.size === actual.length && expected.every((id) => actualIds.has(id));
}


function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Agent loop was cancelled.", "AbortError");
}

function abortMessage(reason: unknown): string {
  return reason === undefined ? "cancelled" : errorMessage(reason);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
