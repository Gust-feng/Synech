import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentMessage,
  type AgentTool,
  type Session,
} from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
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
import { compactSessionContextIfNeeded } from "../session-context-compaction.js";
import { replaceUnsupportedImageBlocks } from "../session-image-placeholder.js";
import {
  harnessToolResult,
  toolResultFromDetails,
} from "../tool-result-transport.js";
import {
  assistantText,
  modelMessageFromAssistant,
  modelUsageFromProvider,
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
  | "executionEnvironment"
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
    project(result: ToolCallResult, terminate: boolean, addedToolNames?: readonly string[]): ProjectedHarnessToolResult;
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
  readonly createHarness?: (options: ConstructorParameters<typeof AgentHarness>[0]) => AgentHarness;
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
  const session = input.dependencies?.createSession === undefined
    ? await new InMemorySessionRepo().create({ id: sessionId })
    : await input.dependencies.createSession(sessionId);
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
    abortSignal: input.loopInput.abortSignal,
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
  const harnessOptions: ConstructorParameters<typeof AgentHarness>[0] = {
    env: input.options.executionEnvironment,
    session,
    models: input.options.modelRegistry,
    model: input.options.selectedModel,
    thinkingLevel: input.options.thinkingLevel,
    systemPrompt: input.invocation.instructions,
    tools: [...harnessTools.tools],
    activeToolNames: [...harnessTools.activeToolNames],
  };
  const harness = input.dependencies?.createHarness?.(harnessOptions) ?? new AgentHarness(harnessOptions);
  harnessTools.bind?.(harness);
  await harness.setActiveTools([...harnessTools.activeToolNames]);
  attachDelegatedHarnessHooks({
    harness,
    session,
    parentInvocationId,
    loopInput: input.loopInput,
    options: input.options,
    abortSignal: input.abortSignal,
    metadataByName: harnessTools.metadataByName,
    metrics,
    bindings,
    acceptedRequests,
    facts: input.facts,
  });
  const handleAbort = (): void => { void harness.abort().catch(() => undefined); };
  input.abortSignal.addEventListener("abort", handleAbort, { once: true });
  if (input.abortSignal.aborted) handleAbort();
  try {
    const assistant = await harness.prompt(input.invocation.input);
    if (input.abortSignal.aborted || assistant.stopReason === "aborted") {
      return delegatedAgentFailure(
        input.request,
        input.abortSignal.reason ?? assistant.errorMessage,
        true,
        input.startedAt,
        metrics,
      );
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

function attachDelegatedHarnessHooks(input: {
  readonly harness: AgentHarness;
  readonly session: Session;
  readonly parentInvocationId: string;
  readonly loopInput: DelegatedLoopContext;
  readonly options: DelegatedRuntimeOptions;
  readonly abortSignal: AbortSignal;
  readonly metadataByName: ReadonlyMap<string, ToolDefinition["metadata"]>;
  readonly metrics: DelegatedAgentExecutionMetrics;
  readonly bindings: ToolInvocationBindingTable;
  readonly acceptedRequests: AcceptedNestedToolRequestRegistry;
  readonly facts: DelegatedAgentFactPorts;
}): void {
  const pendingRequests = new Map<string, PendingToolRequest>();
  const preparedToolCallIds = new Set<string>();
  attachProviderPayloadHook(input.harness, input.options, input.metadataByName);
  input.harness.on("context", async ({ messages: contextMessages }) => {
    const messages = [...replaceUnsupportedImageBlocks(contextMessages, input.options.selectedModel.input.includes("image"))];
    const compaction = await compactSessionContextIfNeeded({
      agentSession: input.session,
      activeContextMessages: messages,
      modelRegistry: input.options.modelRegistry,
      selectedModel: input.harness.getModel(),
      thinkingLevel: input.harness.getThinkingLevel(),
      abortSignal: input.abortSignal,
      ...(input.options.compactionSettings === undefined ? {} : { compactionSettings: input.options.compactionSettings }),
    });
    if (compaction.status === "failed") throw new Error(compaction.error);
    return compaction.status === "compacted"
      ? { messages: [...compaction.compactedContextMessages] }
      : { messages: [...messages] };
  });
  input.harness.on("session_before_compact", ({ preparation }) => {
    if (!compactionPreparationContainsImage(preparation)) return undefined;
    return { cancel: true };
  });
  input.harness.on("tool_result", ({ details }) => {
    const result = toolResultFromDetails(details);
    return result === undefined ? undefined : { isError: result.status !== "completed" };
  });
  input.harness.on("tool_call", ({ toolCallId }) => {
    preparedToolCallIds.add(toolCallId);
    return undefined;
  });
  input.harness.subscribe(async (event) => {
    if (event.type === "tool_execution_end") {
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
    if (event.type === "message_end" && event.message.role === "toolResult") {
      await input.facts.results.deliverPendingMessage(event.message, input.parentInvocationId);
      return;
    }
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const roundId = await input.session.getLeafId();
    if (roundId === null) throw new Error("Delegated Session did not expose the assistant entry id.");
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
        modelVisibleAtRequest: input.harness.getActiveTools().some((tool) => tool.name === request.toolName),
      });
    }
    const usage = modelUsageFromProvider(event.message.usage);
    input.metrics.modelRounds += 1;
    input.metrics.usage = mergeModelUsage(input.metrics.usage, usage);
    input.facts.run.observeUsage(usage);
  });
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

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function abortMessage(reason: unknown): string {
  return reason === undefined ? "cancelled" : errorMessage(reason);
}
