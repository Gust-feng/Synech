import {
  AgentHarness,
  MemorySessionRepo,
  type AgentMessage,
  type AgentTool,
  type AgentLane,
  type AgentHarnessOptions,
  type HarnessEvent,
  type Session,
} from "@earendil-works/pi-agent-core";
import { TODO_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context";
import {
  Type,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentLoopAgentTool,
  AgentLoopAgentToolInvocation,
  AgentLoopInput,
  AgentLoopToolBoundary,
} from "../../../app/model-runtime/agent-loop.js";
import type { ModelUsage } from "../../../domain/intelligence/index.js";
import {
  modelVisibleToolDescription,
  normalizeToolFactValue,
  toolInvocationId,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDefinition,
  type ToolFactValue,
} from "../../../domain/tools/index.js";
import { replaceUnsupportedImageBlocks } from "../session-image-placeholder.js";
import {
  harnessToolResult,
  toolResultFromDetails,
} from "../tool-result-transport.js";
import {
  assistantText,
  modelMessageFromAssistant,
  modelUsageFromProvider,
  providerFailureFromAssistant,
} from "../provider-result-projection.js";
import {
  createToolVisibilitySession,
  narrowToolVisibilityPlan,
} from "../tool-visibility-session.js";
import {
  AcceptedNestedToolRequestRegistry,
  ToolInvocationBindingTable,
  acceptedToolRequests,
  providerToolCallsForRound,
  requireAcceptedToolInvocations,
} from "../agent-session-tool-bindings.js";
import { mergeModelUsage } from "../agent-session-provider-timing.js";
import { errorMessage } from "../../../kernel/values/index.js";
import {
  attachProviderPayloadHook,
  projectToolExecutionEnd,
  type HarnessProjectionResultPort,
} from "./harness-event-projector.js";
import type { AgentSessionLoopOptions } from "./contracts.js";
import { toHarnessTool } from "../pi-agent/harness-tool-bridge.js";

type ProjectedHarnessToolResult = ReturnType<typeof harnessToolResult>;

type DelegatedAgentResultGateway = AgentLoopToolBoundary["gateway"] & {
  readonly deliverResult: NonNullable<AgentLoopToolBoundary["gateway"]["deliverResult"]>;
};

type DelegatedAgentExecutionMetrics = {
  modelRounds: number;
  toolCallCount: number;
  usage: ModelUsage;
};

type PendingToolRequest = {
  readonly request: ToolCallRequest;
  readonly modelVisibleAtRequest: boolean;
};

export type DelegatedLoopContext = Pick<
  AgentLoopInput,
  | "tools"
  | "agentTools"
  | "abortSignal"
  | "toolVisibilityPlan"
  | "acceptNestedToolInvocations"
  | "onNestedToolRequestsAccepted"
>;

export type DelegatedRuntimeOptions = Pick<
  AgentSessionLoopOptions,
  | "modelRegistry"
  | "selectedModel"
  | "thinkingLevel"
  | "toolDefinitionTokenCounter"
  | "compactionSettings"
  | "transformProviderPayload"
  | "onProviderToolDefinitionMetrics"
>;

export type DelegatedAgentFactPorts = {
  readonly results: HarnessProjectionResultPort & {
    acceptForDelivery(result: ToolCallResult): Promise<ProjectedHarnessToolResult | undefined>;
    project(result: ToolCallResult, terminate: boolean): ProjectedHarnessToolResult;
  };
  readonly run: {
    emitToolRequested(request: ToolCallRequest): void;
    observeUsage(usage: ModelUsage): void;
    recordToolRequestAcceptanceFailure(error: unknown): void;
    hasBlockingFailure(): boolean;
    isCancellationRequested(): boolean;
  };
  readonly maintenance: {
    record(failure: { readonly code: string; readonly error: string }): void;
    fail(code: string, error: string): never;
  };
};

export type DelegatedMechanicalToolFactory = (input: {
  readonly definition: ToolDefinition;
  readonly boundary: AgentLoopToolBoundary;
  readonly onToolInvoked: () => void;
  readonly bindings: ToolInvocationBindingTable;
  readonly assertAccepted: (request: ToolCallRequest) => void;
}) => AgentTool;

export type DelegatedAgentRunnerDependencies = {
  readonly createSession?: (sessionId: string) => Promise<Session>;
  readonly createHarness?: (
    options: AgentHarnessOptions<undefined>,
    context: ReturnType<typeof withAbortSignal>,
  ) => Promise<{ readonly harness: AgentHarness<undefined>; readonly lane: AgentLane }>;
};

export function createDelegatedAgentTool(input: {
  readonly definition: ToolDefinition;
  readonly contribution: AgentLoopAgentTool;
  readonly loopInput: DelegatedLoopContext;
  readonly options: DelegatedRuntimeOptions;
  readonly rootBindings: ToolInvocationBindingTable;
  readonly resultGateway: DelegatedAgentResultGateway;
  readonly createMechanicalTool: DelegatedMechanicalToolFactory;
  readonly facts: DelegatedAgentFactPorts;
  readonly dependencies?: DelegatedAgentRunnerDependencies;
}): AgentTool {
  return {
    name: input.definition.name,
    label: input.definition.name,
    description: modelVisibleToolDescription(input.definition),
    parameters: Type.Unsafe(globalThis.structuredClone(input.definition.inputSchema)),
    executionMode: "parallel",
    async execute(callId, parameters, signal) {
      const binding = input.rootBindings.get(callId);
      if (binding === undefined) {
        input.facts.maintenance.fail(
          "session_tool_request_missing",
          `Pi invoked delegated execute for ${callId} before Ordinary bound an invocation id.`,
        );
      }
      const request: ToolCallRequest = {
        providerCallId: callId,
        invocationId: binding.invocationId,
        ...(binding.parentInvocationId === undefined ? {} : { parentInvocationId: binding.parentInvocationId }),
        toolName: input.contribution.toolName,
        input: normalizeToolFactValue(parameters),
      };
      input.facts.run.emitToolRequested(request);
      const startedAt = Date.now();
      let result: ToolCallResult;
      try {
        const invocation = validateDelegatedToolBoundary(
          input.loopInput.tools,
          input.loopInput.agentTools ?? [],
          await input.contribution.resolve(requiredDelegatedAgentInput(request)),
        );
        result = await runDelegatedAgent({
          invocation,
          request,
          loopInput: input.loopInput,
          options: input.options,
          abortSignal: signal ?? input.loopInput.abortSignal,
          startedAt,
          createMechanicalTool: input.createMechanicalTool,
          facts: input.facts,
          dependencies: input.dependencies,
        });
      } catch (error) {
        result = delegatedAgentFailure(
          request,
          error,
          signal?.aborted === true || input.loopInput.abortSignal.aborted,
          startedAt,
        );
      }
      const delivered = await deliverDelegatedAgentResult(input.loopInput, input.resultGateway, result);
      const acceptanceFailure = await input.facts.results.acceptForDelivery(delivered);
      return acceptanceFailure ?? input.facts.results.project(
        delivered,
        input.facts.run.hasBlockingFailure() || delivered.status === "cancelled",
      );
    },
  };
}

async function runDelegatedAgent(input: {
  readonly invocation: AgentLoopAgentToolInvocation;
  readonly request: ToolCallRequest;
  readonly loopInput: DelegatedLoopContext;
  readonly options: DelegatedRuntimeOptions;
  readonly abortSignal: AbortSignal;
  readonly startedAt: number;
  readonly createMechanicalTool: DelegatedMechanicalToolFactory;
  readonly facts: DelegatedAgentFactPorts;
  readonly dependencies?: DelegatedAgentRunnerDependencies;
}): Promise<ToolCallResult> {
  const parentInvocationId = toolInvocationId(input.request);
  const boundary = delegatedToolBoundary(input.loopInput.tools, input.invocation);
  const metrics: DelegatedAgentExecutionMetrics = { modelRounds: 0, toolCallCount: 0, usage: {} };
  const sessionId = `delegated-agent:${parentInvocationId}`;
  let sessionRepo: MemorySessionRepo | undefined;
  let session: Session | undefined;
  let harness: AgentHarness<undefined> | undefined;
  let lane: AgentLane | undefined;
  let operationId: string | undefined;
  let projectionFailure: { readonly code: string; readonly error: string } | undefined;
  let abortRequest: Promise<void> | undefined;
  const cleanups: (() => void)[] = [];
  let result!: ToolCallResult;
  const requestAbort = (): void => {
    if (lane === undefined || operationId === undefined || abortRequest !== undefined) return;
    // Pi closes the active drive's effect gate synchronously, before persisting
    // cancellation. Do not await its event delivery from an event callback.
    abortRequest = lane.requestAbort(operationId, TODO_CONTEXT).then((requested) => {
      if (!requested.ok) throw requested.error;
    });
    void abortRequest.catch(() => undefined);
  };
  const recordProjectionFailure = (error: unknown, code = "runtime_projection_failed"): void => {
    if (projectionFailure !== undefined) return;
    projectionFailure = { code, error: errorMessage(error) };
    requestAbort();
    input.facts.maintenance.record(projectionFailure);
  };
  const projectionFailureResult = (failure: NonNullable<typeof projectionFailure>): ToolCallResult => ({
    ...delegatedAgentFailure(input.request, failure.error, false, input.startedAt, metrics, failure.code),
    errorDomain: "runtime_error",
  });
  const cleanup = async (action: () => void | Promise<void>): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (error) {
      if (result.status === "completed") {
        result = {
          ...delegatedAgentFailure(input.request, error, false, input.startedAt, metrics, "sub_agent_cleanup_failed"),
          errorDomain: "runtime_error",
        };
      }
      input.facts.maintenance.record({ code: "sub_agent_cleanup_failed", error: errorMessage(error) });
      return false;
    }
  };
  try {
    if (input.dependencies?.createSession === undefined) {
      sessionRepo = new MemorySessionRepo();
      session = await sessionRepo.create({ id: sessionId }, TODO_CONTEXT);
    } else {
      session = await input.dependencies.createSession(sessionId);
    }
    const toolDefinitions = boundary.definitions
      .filter((definition) => boundary.permission.allowedTools.includes(definition.name));
    const bindings = new ToolInvocationBindingTable();
    const acceptedRequests = new AcceptedNestedToolRequestRegistry();
    const assertAccepted = (request: ToolCallRequest): void => {
      if (acceptedRequests.matches(request)) return;
      input.facts.maintenance.fail(
        "nested_tool_request_not_accepted",
        `Nested tool request ${toolInvocationId(request)} reached execution without owner acceptance.`,
      );
    };
    const tools = toolDefinitions.map((definition) => input.createMechanicalTool({
      definition,
      boundary,
      onToolInvoked: () => { metrics.toolCallCount += 1; },
      bindings,
      assertAccepted,
    }));
    const visibilityHost = {
      abortSignal: input.abortSignal,
      resolveInvocationId: (providerCallId: string) => bindings.get(providerCallId),
      onToolRequested: input.facts.run.emitToolRequested,
      onToolInvoked: () => { metrics.toolCallCount += 1; },
      acceptResult: input.facts.results.acceptForDelivery,
      projectResult: input.facts.results.project,
      recordMaintenanceFailure: input.facts.maintenance.record,
    };
    const harnessTools = createToolVisibilitySession({
      tools,
      metadataByName: new Map(toolDefinitions.map((definition) => [definition.name, definition.metadata] as const)),
      visibilityPlan: narrowToolVisibilityPlan(
        input.loopInput.toolVisibilityPlan,
        input.invocation.allowedTools,
        toolDefinitions,
        input.options.toolDefinitionTokenCounter,
      ),
      host: visibilityHost,
    });
    const latestAssistant: { current?: Extract<AgentMessage, { readonly role: "assistant" }> } = {};
    const harnessOptions: AgentHarnessOptions<undefined> = {
      session,
      models: input.options.modelRegistry,
      model: input.options.selectedModel,
      thinkingLevel: input.options.thinkingLevel,
      ...(input.options.compactionSettings === undefined ? {} : { compaction: input.options.compactionSettings }),
      systemPrompt: input.invocation.instructions,
      tools: harnessTools.tools.map((tool) => toHarnessTool(tool, input.abortSignal)),
      activeToolNames: [...harnessTools.activeToolNames],
    };
    const runContext = withAbortSignal(input.abortSignal, TODO_CONTEXT);
    const runtime = input.dependencies?.createHarness === undefined
      ? await AgentHarness.create(harnessOptions, runContext)
      : await input.dependencies.createHarness(harnessOptions, runContext);
    harness = runtime.harness;
    lane = "lane" in runtime ? runtime.lane : await harness.lane("main", runContext);
    harnessTools.bind?.(lane);
    await lane.setActiveTools([...harnessTools.activeToolNames], TODO_CONTEXT);
    attachDelegatedHarnessHooks({
      harness,
      lane,
      parentInvocationId,
      loopInput: input.loopInput,
      options: input.options,
      abortSignal: input.abortSignal,
      metadataByName: harnessTools.metadataByName,
      latestAssistant,
      metrics,
      bindings,
      acceptedRequests,
      facts: input.facts,
      cleanups,
      beforeDrive: (runId) => {
        operationId = runId;
        if (projectionFailure !== undefined || input.abortSignal.aborted) requestAbort();
      },
      recordProjectionFailure,
      isProjectionFailed: () => projectionFailure !== undefined,
    });
    const handleAbort = requestAbort;
    input.abortSignal.addEventListener("abort", handleAbort, { once: true });
    cleanups.push(() => input.abortSignal.removeEventListener("abort", handleAbort));
    if (input.abortSignal.aborted) handleAbort();
    const runResult = await lane.prompt(input.invocation.input, undefined, runContext);
    await abortRequest;
    if (projectionFailure !== undefined) {
      result = projectionFailureResult(projectionFailure);
    } else if (!runResult.ok) {
      throw runResult.error;
    } else if (input.abortSignal.aborted || runResult.value.status === "aborted") {
      result = delegatedAgentFailure(
        input.request,
        input.abortSignal.reason,
        true,
        input.startedAt,
        metrics,
      );
    } else if (runResult.value.status === "suspended") {
      const inspected = await lane.inspectExecution(TODO_CONTEXT);
      if (inspected.current?.id !== runResult.value.operationId) {
        throw Object.assign(new Error("Pi delegated suspended operation no longer owns its lane."), {
          code: "deferred_settlement_mismatch",
        });
      }
      const aborted = await lane.abort(TODO_CONTEXT);
      if (!aborted.ok) throw aborted.error;
      result = {
        ...delegatedAgentFailure(
          input.request,
          "Deferred delegated runs are not supported.",
          false,
          input.startedAt,
          metrics,
          "deferred_unsupported",
        ),
        errorDomain: "runtime_error",
      };
    } else if (runResult.value.status === "failed") {
      const assistant = latestAssistant.current;
      result = assistant !== undefined && (assistant.stopReason === "error" || assistant.stopReason === "length")
        ? delegatedAgentProjectedFailure(
            assistant, input.request, input.startedAt, metrics, input.options.selectedModel.contextWindow,
          )
        : delegatedAgentFailure(
            input.request,
            runResult.value.error?.message ?? "Pi delegated run failed without a diagnostic message.",
            false,
            input.startedAt,
            metrics,
          );
    } else {
      result = delegatedAgentCompletedResult(
        latestAssistant.current,
        input.request,
        input.startedAt,
        metrics,
        input.options.selectedModel.contextWindow,
      );
    }
  } catch (error) {
    result = projectionFailure === undefined
      ? delegatedAgentFailure(input.request, error, input.abortSignal.aborted, input.startedAt, metrics)
      : projectionFailureResult(projectionFailure);
  } finally {
    const requestedAbort = abortRequest;
    if (requestedAbort !== undefined) await cleanup(() => requestedAbort);
    await cleanup(async () => {
      if (lane === undefined) return;
      const inspected = await lane.inspectExecution(TODO_CONTEXT);
      if (inspected.current === null) return;
      const aborted = await lane.abort(TODO_CONTEXT);
      if (!aborted.ok) throw aborted.error;
    });
    for (const unsubscribe of cleanups.reverse()) await cleanup(unsubscribe);
    const ownedHarness = harness;
    const ownedSession = session;
    const ownedRepo = sessionRepo;
    const harnessClosed = ownedHarness !== undefined && await cleanup(() => ownedHarness.close(TODO_CONTEXT));
    if (!harnessClosed && ownedSession !== undefined) await cleanup(() => ownedSession.close(TODO_CONTEXT));
    if (ownedRepo !== undefined) await cleanup(() => ownedRepo.close(TODO_CONTEXT));
  }
  if (projectionFailure !== undefined) result = projectionFailureResult(projectionFailure);
  return result;
}

function attachDelegatedHarnessHooks(input: {
  readonly harness: AgentHarness;
  readonly lane: AgentLane;
  readonly latestAssistant: { current?: Extract<AgentMessage, { readonly role: "assistant" }> };
  readonly parentInvocationId: string;
  readonly loopInput: DelegatedLoopContext;
  readonly options: DelegatedRuntimeOptions;
  readonly abortSignal: AbortSignal;
  readonly metadataByName: ReadonlyMap<string, ToolDefinition["metadata"]>;
  readonly metrics: DelegatedAgentExecutionMetrics;
  readonly bindings: ToolInvocationBindingTable;
  readonly acceptedRequests: AcceptedNestedToolRequestRegistry;
  readonly facts: DelegatedAgentFactPorts;
  readonly cleanups: (() => void)[];
  readonly beforeDrive: (operationId: string) => void;
  readonly recordProjectionFailure: (error: unknown, code?: string) => void;
  readonly isProjectionFailed: () => boolean;
}): void {
  const pendingRequests = new Map<string, PendingToolRequest>();
  const preparedToolCallIds = new Set<string>();
  const unsubscribePayload = attachProviderPayloadHook(
    input.harness, input.lane, input.options, input.metadataByName,
  );
  if (unsubscribePayload !== undefined) input.cleanups.push(unsubscribePayload);
  input.cleanups.push(input.harness.hooks.on("before_drive", ({ runId }) => input.beforeDrive(runId)));
  // Compaction is owned by Pi. Synech only contributes the text-only guard here.
  input.cleanups.push(input.harness.hooks.on("transform_context", async ({ messages }) => ({
    messages: [
      ...replaceUnsupportedImageBlocks(
        messages,
        input.options.selectedModel.input.includes("image"),
      ),
    ],
  })));
  input.cleanups.push(input.harness.hooks.on("after_tool", ({ details }) => {
    const result = toolResultFromDetails(details);
    return result === undefined ? undefined : { isError: result.status !== "completed" };
  }));
  input.cleanups.push(input.harness.hooks.on("before_tool", ({ toolCallId }) => {
    preparedToolCallIds.add(toolCallId);
    return undefined;
  }));
  const projectEvent = async (event: HarnessEvent): Promise<void> => {
    if (event.type === "tool_end") {
      await projectToolExecutionEnd({
        event,
        pendingRequest: pendingRequests.get(event.toolCallId),
        prepared: preparedToolCallIds.has(event.toolCallId),
        cancellationRequested: input.facts.run.isCancellationRequested(),
        abortSignal: input.abortSignal,
        forget: () => {
          pendingRequests.delete(event.toolCallId);
          preparedToolCallIds.delete(event.toolCallId);
        },
        acceptObserved: input.facts.results.acceptObserved,
        emitRequested: input.facts.run.emitToolRequested,
        failMaintenance: input.facts.maintenance.fail,
      });
      return;
    }
    if (event.type !== "message_end") return;
    if (event.message.role === "toolResult") {
      await input.facts.results.deliverPendingMessage(event.message, input.parentInvocationId);
      return;
    }
    if (event.message.role !== "assistant") return;
    input.latestAssistant.current = event.message;
    // Pi advances the branch tip in the commit that follows `message_end`, so a
    // tip read here observes the previous entry; the event carries the id of
    // the entry it names.
    const roundId = event.entryId;
    if (roundId === undefined) {
      throw new Error("Delegated Session message_end did not report the assistant entry id.");
    }
    const providerCalls = providerToolCallsForRound(
      modelMessageFromAssistant(event.message).toolCalls ?? [],
      roundId,
      input.parentInvocationId,
    );
    const batchInvocationIds = new Set<string>();
    for (const providerCall of providerCalls) {
      if (pendingRequests.has(providerCall.providerCallId)) {
        input.facts.maintenance.fail(
          "session_tool_request_duplicate",
          `Pi emitted duplicate delegated tool call id ${providerCall.providerCallId}.`,
        );
      }
    }
    let requests: readonly ToolCallRequest[] = [];
    if (providerCalls.length > 0) {
      try {
        const accepted = requireAcceptedToolInvocations(
          providerCalls,
          await input.loopInput.acceptNestedToolInvocations(providerCalls),
          (message) => input.facts.maintenance.fail("session_tool_binding_mismatch", message),
        );
        requests = acceptedToolRequests(
          accepted,
          input.parentInvocationId,
        );
        for (const request of requests) {
          if (batchInvocationIds.has(request.invocationId) || input.acceptedRequests.has(request.invocationId)) {
            input.facts.maintenance.fail(
              "session_tool_request_duplicate",
              `Pi reused delegated tool invocation ${request.invocationId}.`,
            );
          }
          batchInvocationIds.add(request.invocationId);
        }
        await input.loopInput.onNestedToolRequestsAccepted?.(
          requests.map((request) => globalThis.structuredClone(request)),
        );
      } catch (error) {
        input.facts.run.recordToolRequestAcceptanceFailure(error);
        throw error;
      }
    }
    for (const request of requests) {
      input.acceptedRequests.remember(request);
      input.bindings.remember(request);
      pendingRequests.set(request.providerCallId, {
        request,
        modelVisibleAtRequest: (await input.lane.getActiveTools(TODO_CONTEXT)).includes(request.toolName),
      });
    }
    const usage = modelUsageFromProvider(event.message.usage);
    input.metrics.modelRounds += 1;
    input.metrics.usage = mergeModelUsage(input.metrics.usage, usage);
    input.facts.run.observeUsage(usage);
  }
  // Pi awaits delivery but isolates listener errors. Explicit cancellation,
  // not a thrown listener error, prevents the drive from admitting more work.
  const observe = async (event: HarnessEvent): Promise<void> => {
    if (input.isProjectionFailed()) return;
    try {
      await projectEvent(event);
    } catch (error) {
      input.recordProjectionFailure(error);
      throw error;
    }
  };
  input.cleanups.push(input.harness.events.on("tool_end", (event) => observe(event)));
  input.cleanups.push(input.harness.events.on("message_end", (event) => observe(event)));
  input.cleanups.push(input.harness.events.on("handler_error", (event) =>
    input.recordProjectionFailure(event.error, "runtime_handler_failed")));
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

async function deliverDelegatedAgentResult(
  input: DelegatedLoopContext,
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

export function requireDelegatedAgentResultGateway(
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
  failureCode?: string,
): ToolCallResult {
  return {
    ...request,
    output: undefined,
    status: cancelled ? "cancelled" : "failed",
    error: cancelled
      ? `Delegated agent was cancelled: ${abortMessage(error)}`
      : `Delegated agent failed: ${errorMessage(error)}`,
    errorDomain: cancelled ? "runtime_error" : "model_error",
    // 结构码来自显式投影（鉴权/拒答/溢出/截断）或错误对象上的 code（压缩失败），
    // 只有都拿不到时才落通用的执行失败码；取消恒定是取消码，不读中止原因的 code。
    errorFacts: {
      code: cancelled
        ? "sub_agent_cancelled"
        : failureCode ?? errorFactsCode(error) ?? "sub_agent_execution_failed",
    },
    ...(metrics === undefined ? {} : { delegatedExecution: delegatedExecutionMetadata(metrics) }),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

/** 错误对象携带的结构码（如压缩失败的 context_overflow）；没有则返回 undefined。 */
function errorFactsCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function delegatedAgentCompletedResult(
  assistant: AssistantMessage | undefined,
  request: ToolCallRequest,
  startedAt: number,
  metrics: DelegatedAgentExecutionMetrics,
  contextWindow: number,
): ToolCallResult {
  if (assistant === undefined) {
    return delegatedAgentFailure(
      request, "Pi delegated run completed without an assistant message.",
      false, startedAt, metrics, "final_assistant_missing",
    );
  }
  if (assistant.stopReason === "error" || assistant.stopReason === "length") {
    return delegatedAgentProjectedFailure(assistant, request, startedAt, metrics, contextWindow);
  }
  if (assistant.content.some((block) => block.type === "toolCall")) {
    return delegatedAgentFailure(
      request, "Pi delegated run completed with tool use instead of a final assistant response.",
      false, startedAt, metrics, "final_assistant_is_tool_use",
    );
  }
  if (assistant.stopReason !== "stop") {
    return delegatedAgentProjectedFailure(assistant, request, startedAt, metrics, contextWindow);
  }
  const text = assistantText(assistant);
  if (text.trim().length === 0) {
    return delegatedAgentFailure(
      request, "Pi delegated run completed with an empty assistant response.",
      false, startedAt, metrics, "final_assistant_empty",
    );
  }
  return {
    ...request,
    output: text,
    status: "completed",
    delegatedExecution: delegatedExecutionMetadata(metrics),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

/**
 * 子 agent 与根 loop 共用同一套 provider 失败投影（根侧见 agent-session-loop.ts
 * 的 finalResult）：鉴权失败、拒答、上下文溢出与长度截断都落在结构化
 * errorFacts.code 上，不再压成一句 "Delegated agent stopped with X"。
 */
function delegatedAgentProjectedFailure(
  assistant: AssistantMessage,
  request: ToolCallRequest,
  startedAt: number,
  metrics: DelegatedAgentExecutionMetrics,
  contextWindow: number,
): ToolCallResult {
  const providerFailure = providerFailureFromAssistant(assistant, contextWindow);
  if (providerFailure !== undefined) {
    return delegatedAgentFailure(
      request,
      providerFailure.error,
      false,
      startedAt,
      metrics,
      providerFailure.errorCode,
    );
  }
  if (assistant.stopReason === "length") {
    return delegatedAgentFailure(
      request,
      "The delegated model stopped before completing its response because it reached the output token limit.",
      false,
      startedAt,
      metrics,
      "output_truncated",
    );
  }
  return delegatedAgentFailure(
    request,
    assistant.errorMessage ?? `Delegated agent stopped with ${assistant.stopReason}.`,
    false,
    startedAt,
    metrics,
  );
}

function delegatedExecutionMetadata(metrics: DelegatedAgentExecutionMetrics) {
  return {
    modelRounds: metrics.modelRounds,
    toolCallCount: metrics.toolCallCount,
    usage: globalThis.structuredClone(metrics.usage),
  };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function abortMessage(reason: unknown): string {
  return reason === undefined ? "cancelled" : errorMessage(reason);
}
