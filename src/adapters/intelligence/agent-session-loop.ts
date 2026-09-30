import {
  AgentHarness,
  type AgentMessage,
  type AgentTool,
  type AgentToolUpdateCallback,
  type AgentLane,
  Session,
} from "@earendil-works/pi-agent-core";
import {
  TODO_CONTEXT,
  withAbortSignal,
  type Context,
} from "@earendil-works/pi-agent-core/harness/context";
import {
  Type,
  type AssistantMessage,
  type ImageContent,
} from "@earendil-works/pi-ai";
import type {
  AgentLoop,
  AgentLoopContinuation,
  AgentLoopInput,
  AgentLoopResult,
  AgentLoopToolBoundary,
} from "../../app/model-runtime/agent-loop.js";
import type { ConfirmationDecision, ConfirmationRequest } from "../../domain/confirmation/index.js";
import type { ModelUsage } from "../../domain/intelligence/index.js";
import {
  modelVisibleToolDescription,
  normalizeToolFactValue,
  toolInvocationId,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDefinition,
  type ToolExecutionContext,
} from "../../domain/tools/index.js";
import {
  createToolVisibilitySession,
  type ToolVisibilityToolSet,
} from "./tool-visibility-session.js";
import {
  cancelledApprovalResult,
  cloneToolResult,
  deniedToolResult,
  harnessToolResult,
  pendingToolResultForMessage,
  requireApprovalRequiredResult,
  requireConfirmationRequest,
  toolRequestFromResult,
  toolResultAcceptanceFailure,
  toolResultForPiTransport,
  toolResultHasInlineImage,
  type PendingToolResultDelivery,
  type ToolExecutionDetails,
} from "./tool-result-transport.js";
import {
  assistantText,
  imageContentFromAttachments,
  providerFailureFromAssistant,
} from "./provider-result-projection.js";
import { errorMessage } from "../../kernel/values/index.js";
import {
  ToolInvocationBindingTable,
} from "./agent-session-tool-bindings.js";
import { getMainLeafId } from "./session-write-fence.js";
import { toHarnessTool } from "./pi-agent/harness-tool-bridge.js";
import type { AgentSessionLoopOptions } from "./agent-session-loop/contracts.js";
import {
  RootHarnessEventProjector,
} from "./agent-session-loop/harness-event-projector.js";
import {
  createDelegatedAgentTool,
  requireDelegatedAgentResultGateway,
} from "./agent-session-loop/delegated-agent-runner.js";

export type {
  AgentSessionLoopOptions,
  AgentSessionToolDefinitionMetric,
  AgentSessionToolDefinitionMetrics,
  AgentSessionToolDefinitionMetricsObserver,
  AgentSessionToolDefinitionTokenCounter,
} from "./agent-session-loop/contracts.js";

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

type PendingApproval = {
  readonly result: ToolCallResult & { readonly status: "approval_required" };
  readonly decision: Deferred<ApprovalResolution>;
};

type ApprovalResolution = {
  readonly kind: "resolved";
  readonly decision: ConfirmationDecision;
  readonly abortSignal: AbortSignal;
};

type AgentSessionExecutionState = {
  readonly toolResults: Map<string, ToolCallResult>;
  readonly pendingToolResults: Map<string, PendingToolResultDelivery>;
  readonly approvals: ApprovalDecisionCoordinator;
  readonly supportsVisionInput: boolean;
  readonly modelInputSupportsImage: boolean;
  readonly abortSignalCleanups: Set<() => void>;
  /**
   * Owner-bound root call ids for the active model response. Populated from
   * `acceptToolInvocation` during the `message_end` handler before any
   * `execute` runs, so a synchronous `execute` can read the binding.
   */
  readonly rootInvocationBindings: ToolInvocationBindingTable;
  readonly rootEvents: RootHarnessEventProjector;
  cancellationRequested: boolean;
  abortRun?: () => Promise<void>;
  toolAcceptanceFailure?: unknown;
};

type ActiveAgentLoopExecution = {
  readonly run: Promise<AssistantMessage>;
  readonly cancel: () => Promise<void>;
};

class PiRunFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PiRunFailure";
  }
}

/** Provider-neutral mechanical loop whose transcript is owned by one agent Session. */
export function createAgentSessionLoop(options: AgentSessionLoopOptions): AgentLoop {
  let activeExecution: ActiveAgentLoopExecution | undefined;
  let released = false;

  return {
    async execute(input) {
      if (released) throw new Error("Agent session loop has been released.");
      if (activeExecution !== undefined) throw new Error("Agent session loop is already executing.");
      if (input.abortSignal.aborted) return cancelledBeforeStart(input);
      const sessionId = options.agentSession.metadata.id;
      const prompt = preparePromptInput(input);
      const rootInvocationBindings = new ToolInvocationBindingTable();
      let state!: AgentSessionExecutionState;
      const rootEvents = new RootHarnessEventProjector({
        input,
        loopOptions: options,
        sessionId,
        agentSession: options.agentSession,
        modelInputSupportsImage: options.selectedModel.input.includes("image"),
        rootBindings: rootInvocationBindings,
        resultPort: {
          acceptObserved: (result) => acceptToolResult(input, state, result).then(() => undefined),
          deliverPendingMessage: (message, parentInvocationId) =>
            deliverPendingToolResultMessage(input, state, message, parentInvocationId),
        },
        isCancellationRequested: () => state.cancellationRequested,
      });
      state = {
        toolResults: new Map(),
        pendingToolResults: new Map(),
        approvals: new ApprovalDecisionCoordinator(),
        supportsVisionInput: options.supportsVisionInput ?? options.selectedModel.input.includes("image"),
        modelInputSupportsImage: options.selectedModel.input.includes("image"),
        abortSignalCleanups: new Set(),
        rootInvocationBindings,
        rootEvents,
        cancellationRequested: false,
      };
      const harnessTools = createHarnessTools(input, state, options);
      const runContext = withAbortSignal(input.abortSignal, TODO_CONTEXT);
      const created = await AgentHarness.create({
        session: options.agentSession,
        models: options.modelRegistry,
        model: options.selectedModel,
        thinkingLevel: options.thinkingLevel,
        systemPrompt: input.instructions,
        tools: harnessTools.tools.map((tool) => toHarnessTool(tool, input.abortSignal)),
        activeToolNames: [...harnessTools.activeToolNames],
       compaction: options.compactionSettings,
      }, runContext);
      const harness = created.harness;
      // An operation left open by an interrupted process rejects every new
      // prompt on its lane (Pi LaneBusy). The product has already reconciled
      // that interrupted run at its own layer, so the stale operation is
      // settled by abort here — never resumed: resuming would re-drive the
      // interrupted generation and issue provider calls nobody asked for.
      for (const openOperation of created.open) {
        const staleLane = await harness.lane(openOperation.lane, runContext);
        const aborted = await staleLane.abort(runContext);
        if (!aborted.ok) {
          throw new Error(
            `Pi lane could not settle the operation left open by an interrupted run: ${aborted.error.message}`,
          );
        }
      }
      const lane = await harness.lane("main", runContext);
      harnessTools.bind?.(lane);
      await lane.setActiveTools([...harnessTools.activeToolNames], TODO_CONTEXT);
      rootEvents.attach(harness, lane, harnessTools.metadataByName);
      const startEntryId = await getMainLeafId(options.agentSession);
      await input.onSessionWriteCheckpoint?.({
        kind: "start_leaf_captured",
        checkpoint: await rootEvents.captureStart(startEntryId),
        sessionId,
      });
      // A previous run can die with its lane operation still durably recorded:
      // a cancel revokes the run's writer generation while Pi's operation
      // closure lands on the revoked line, and a crash simply leaves it. The
      // product has already settled that run, so the leftover operation is
      // aborted here, not resumed, and this run starts on a clean lane.
      const promptLane = () => lane.prompt(prompt.text, prompt.images, runContext);
      // `created.open` is the one recovery point for durable orphaned
      // operations. A LaneBusy here means that invariant was not restored;
      // aborting and retrying would hide the race and could touch another run.
      const started = promptLane();
      const run = started.finally(() => rootEvents.settleProjectionFailure(lane)).then(async (result) => {
        if (!result.ok) {
          throw new PiRunFailure(result.error.message, piAdmissionErrorCode(result.error), { cause: result.error });
        }
        if (result.value.status === "failed") {
          const assistantFailure = rootEvents.latestAssistant === undefined
            ? undefined
            : providerFailureFromAssistant(rootEvents.latestAssistant, options.selectedModel.contextWindow);
          throw new PiRunFailure(
            assistantFailure?.error ?? result.value.error?.message ?? "Pi run failed without a diagnostic message.",
            assistantFailure?.errorCode ?? result.value.error?.code ?? "pi_run_failed",
          );
        }
        if (result.value.status === "aborted") {
          throw new DOMException("Agent run was aborted.", "AbortError");
        }
        if (result.value.status === "suspended") {
          await settleUnsupportedSuspendedRun(lane, runContext, result.value.operationId);
          throw new PiRunFailure(
            "Pi returned a deferred run, but Synech does not support deferred responses.",
            "deferred_unsupported",
          );
        }
        const assistant = rootEvents.latestAssistant;
        const responseFailure = validateCompletedAssistant(assistant, state);
        if (responseFailure !== undefined) {
          throw new PiRunFailure(responseFailure.error, responseFailure.code);
        }
        if (assistant === undefined) {
          throw new PiRunFailure(
            "Pi completed without a final assistant message.",
            "final_assistant_missing",
          );
        }
        if (rootEvents.maintenanceFailure !== undefined) {
          throw new PiRunFailure(
            rootEvents.maintenanceFailure.error,
            rootEvents.maintenanceFailure.code,
          );
        }
        // The answer's checkpoint is durable only once the run has picked its
        // final assistant entry: intermediate and retry entries commit without
        // being the answer, and each entry lands after its own message_end.
        const responseCheckpoint = await rootEvents.captureResponse();
        if (responseCheckpoint === null) {
          throw new PiRunFailure(
            "Pi completed without a durable final assistant entry.",
            "final_assistant_checkpoint_missing",
          );
        }
        await input.onSessionWriteCheckpoint?.({
          kind: "assistant_response_entry_committed",
          checkpoint: responseCheckpoint,
          sessionId,
          assistantText: assistantText(assistant),
        });
        return assistant;
      });
      let abortPromise: Promise<void> | undefined;
      const abort = (): Promise<void> => {
        abortPromise ??= lane.inspectExecution(TODO_CONTEXT).then(async (execution) => {
          if (execution.current === null) return;
          const aborted = await lane.requestAbort(execution.current.id, TODO_CONTEXT);
          if (!aborted.ok) throw aborted.error;
        });
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
    : agentTools.map((agentTool) => createDelegatedAgentTool({
        definition: requireFrozenToolDefinition(definitionsByName, agentTool.toolName),
        contribution: agentTool,
        loopInput: input,
        options,
        rootBindings: state.rootInvocationBindings,
        resultGateway: requireDelegatedAgentResultGateway(input.tools.gateway),
        createMechanicalTool: ({ definition, boundary, onToolInvoked, bindings, assertAccepted }) =>
          createHarnessTool(definition, input, state, boundary, onToolInvoked, bindings, assertAccepted),
        facts: delegatedAgentFactPorts(input, state),
      }));
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

function delegatedAgentFactPorts(input: AgentLoopInput, state: AgentSessionExecutionState) {
  return {
    results: {
      acceptObserved: (result: ToolCallResult) => acceptToolResult(input, state, result).then(() => undefined),
      acceptForDelivery: (result: ToolCallResult) => acceptToolResultForDelivery(input, state, result),
      deliverPendingMessage: (
        message: Extract<AgentMessage, { readonly role: "toolResult" }>,
        parentInvocationId?: string,
      ) => deliverPendingToolResultMessage(input, state, message, parentInvocationId),
      project: (result: ToolCallResult, terminate: boolean) =>
        harnessToolResult(result, state, terminate),
    },
    run: {
      emitToolRequested: (request: ToolCallRequest) => emitToolRequested(input, request),
      observeUsage: (usage: ModelUsage) => state.rootEvents.mergeUsage(usage, true),
      recordToolRequestAcceptanceFailure: (error: unknown) =>
        state.rootEvents.recordToolRequestAcceptanceFailure(error),
      hasBlockingFailure: () =>
        state.rootEvents.toolRequestAcceptanceFailure !== undefined ||
        state.toolAcceptanceFailure !== undefined ||
        state.rootEvents.maintenanceFailure !== undefined,
      isCancellationRequested: () => state.cancellationRequested,
    },
    maintenance: {
      record: (failure: { readonly code: string; readonly error: string }) =>
        state.rootEvents.recordMaintenanceFailure(failure),
      fail: (code: string, error: string): never => state.rootEvents.failMaintenance(code, error),
    },
  };
}

function toolVisibilityHost(
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  requestScope?: (request: ToolCallRequest) => ToolCallRequest,
  onToolInvoked?: () => void,
  bindingTable?: ToolInvocationBindingTable,
) {
  return {
    abortSignal: input.abortSignal,
    ...(requestScope === undefined ? {} : { requestScope }),
    resolveInvocationId: (providerCallId: string) => (bindingTable ?? state.rootInvocationBindings).get(providerCallId),
    onToolRequested: (request: ToolCallRequest) => emitToolRequested(input, request),
    ...(onToolInvoked === undefined ? {} : { onToolInvoked }),
    acceptResult: (result: ToolCallResult) => acceptToolResultForDelivery(input, state, result),
    projectResult: (
      result: ToolCallResult,
      terminate: boolean,
    ) => harnessToolResult(result, state, terminate),
    recordMaintenanceFailure: (failure: { readonly code: string; readonly error: string }) => {
      state.rootEvents.recordMaintenanceFailure(failure);
    },
  };
}

function createHarnessTool(
  definition: ToolDefinition,
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  boundary: AgentLoopToolBoundary,
  onToolInvoked?: () => void,
  /** Per-tool-call binding table. Defaults to the shared `state.rootInvocationBindings`. */
  bindingTable?: ToolInvocationBindingTable,
  assertAccepted?: (request: ToolCallRequest) => void,
): AgentTool {
  return {
    name: definition.name,
    label: definition.name,
    description: modelVisibleToolDescription(definition),
    parameters: Type.Unsafe(globalThis.structuredClone(definition.inputSchema)),
    executionMode: "parallel",
    async execute(callId, parameters, signal, onUpdate) {
      const binding = (bindingTable ?? state.rootInvocationBindings).get(callId);
      if (binding === undefined) {
        throwHarnessMaintenanceFailure(
          state,
          "session_tool_request_missing",
          `Pi invoked execute for ${callId} before Ordinary bound an invocation id.`,
        );
      }
      const request: ToolCallRequest = {
        providerCallId: callId,
        invocationId: binding.invocationId,
        ...(binding.parentInvocationId === undefined ? {} : { parentInvocationId: binding.parentInvocationId }),
        toolName: definition.name,
        input: normalizeToolFactValue(parameters),
      };
      emitToolRequested(input, request);
      assertAccepted?.(request);
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

function throwHarnessMaintenanceFailure(
  state: AgentSessionExecutionState,
  code: string,
  error: string,
): never {
  return state.rootEvents.failMaintenance(code, error);
}

function approvalResult(
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  settle: () => Promise<AgentLoopResult>,
): AgentLoopResult {
  return {
    status: "approval_required",
    toolResults: [...state.toolResults.values()].map(cloneToolResult),
    usage: state.rootEvents.usage,
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
  if (state.rootEvents.maintenanceFailure !== undefined) {
    return {
      ...facts,
      status: "failed",
      error: state.rootEvents.maintenanceFailure.error,
      errorCode: state.rootEvents.maintenanceFailure.code,
    };
  }
  if (state.rootEvents.toolRequestAcceptanceFailure !== undefined) {
    return {
      ...facts,
      status: "failed",
      error: errorMessage(state.rootEvents.toolRequestAcceptanceFailure),
      errorCode: "tool_request_acceptance_failed",
    };
  }
  if (state.toolAcceptanceFailure !== undefined) {
    return { ...facts, status: "failed", error: errorMessage(state.toolAcceptanceFailure), errorCode: "tool_result_acceptance_failed" };
  }
  if (assistant.stopReason === "aborted") {
    return { ...facts, status: "cancelled", error: assistant.errorMessage ?? "cancelled" };
  }
  const providerFailure = providerFailureFromAssistant(assistant, contextWindow);
  if (providerFailure !== undefined) {
    return { ...facts, status: "failed", ...providerFailure };
  }
  if (assistant.stopReason === "length") {
    return {
      ...facts,
      status: "failed",
      error: "Model stopped before completing its response because it reached the output token limit.",
      errorCode: "output_truncated",
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
  if (state.rootEvents.maintenanceFailure !== undefined) {
    return failedResult(state, state.rootEvents.maintenanceFailure.error, state.rootEvents.maintenanceFailure.code);
  }
  if (state.rootEvents.toolRequestAcceptanceFailure !== undefined) {
    return failedResult(state, errorMessage(state.rootEvents.toolRequestAcceptanceFailure), "tool_request_acceptance_failed");
  }
  if (state.toolAcceptanceFailure !== undefined) {
    return failedResult(state, errorMessage(state.toolAcceptanceFailure), "tool_result_acceptance_failed");
  }
  if (isAbortError(error)) return cancelledResult(state, error);
  if (error instanceof PiRunFailure) return failedResult(state, errorMessage(error), error.code);
  const piErrorCode = piOperationErrorCode(error);
  if (piErrorCode !== undefined) return failedResult(state, errorMessage(error), piErrorCode);
  return failedResult(state, errorMessage(error), "agent_loop_failed");
}

function validateCompletedAssistant(
  assistant: Extract<AgentMessage, { readonly role: "assistant" }> | undefined,
  state: AgentSessionExecutionState,
): { readonly error: string; readonly code: string } | undefined {
  const attachmentFailure = [...state.toolResults.values()].find((result) =>
    result.errorFacts?.code === "tool_result_attachment_not_supported" ||
    result.errorFacts?.code === "tool_result_image_input_unsupported" ||
    result.errorFacts?.code === "tool_result_image_input_projection_mismatch",
  );
  if (assistant === undefined) {
    return attachmentFailure === undefined
      ? {
          error: "Pi completed without a final assistant message.",
          code: "final_assistant_missing",
        }
      : {
          error: "Pi completed after a tool result could not be delivered to the model; no final assistant message was produced.",
          code: "tool_result_delivery_failed",
        };
  }
  const toolCallCount = assistant.content.filter((block) => block.type === "toolCall").length;
  if (toolCallCount > 0) {
    return attachmentFailure === undefined
      ? {
          error: "Pi completed with a tool-use assistant message and no final assistant response.",
          code: "final_assistant_is_tool_use",
        }
      : {
          error: "Pi completed after a tool result could not be delivered to the model; the last assistant message still contains tool use.",
          code: "tool_result_delivery_failed",
        };
  }
  if (assistant.stopReason !== "stop") {
    return {
      error: `Pi completed without a final assistant response because the last assistant stop reason was ${JSON.stringify(assistant.stopReason)}.`,
      code: "final_assistant_not_complete",
    };
  }
  if (assistantText(assistant).trim().length === 0) {
    return {
      error: "Pi completed with an empty assistant response.",
      code: "final_assistant_empty",
    };
  }
  return undefined;
}

async function settleUnsupportedSuspendedRun(
  lane: AgentLane,
  context: Context,
  operationId: string,
): Promise<void> {
  const inspected = await lane.inspectExecution(TODO_CONTEXT);
  if (inspected.current?.id !== operationId) {
    throw new PiRunFailure(
      "Pi suspended run no longer owns the lane operation, so it could not be settled.",
      "deferred_settlement_mismatch",
    );
  }
  const aborted = await lane.abort(context);
  if (!aborted.ok) {
    throw new PiRunFailure(
      `Pi deferred run could not be settled: ${aborted.error.message}`,
      "deferred_settlement_failed",
      { cause: aborted.error },
    );
  }
}

function piAdmissionErrorCode(error: { readonly _tag?: string }): string {
  return error._tag === "LaneBusy" ? "pi_lane_busy" : `pi_${error._tag?.toLowerCase() ?? "run_admission_failed"}`;
}

function piOperationErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return undefined;
  const tag = (error as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? `pi_${tag.toLowerCase()}` : undefined;
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
    usage: state.rootEvents.usage,
    confirmationRequests: [] as const,
    session: sessionExecutionRefs(state),
  };
}

function sessionExecutionRefs(state: AgentSessionExecutionState) {
  return state.rootEvents.sessionExecutionRefs();
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
  const invocationId = toolInvocationId(deliverable);
  state.toolResults.set(invocationId, cloneToolResult(deliverable));
  const delivery: PendingToolResultDelivery = { result: deliverable };
  if (toolResultHasInlineImage(deliverable)) {
    state.pendingToolResults.set(invocationId, delivery);
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
  state.pendingToolResults.delete(toolInvocationId(result));
  try {
    await input.onToolResult?.(cloneToolResult(result));
  } catch (error) {
    state.toolAcceptanceFailure ??= error;
    state.toolResults.set(toolInvocationId(result), toolResultAcceptanceFailure(result, error));
    throw error;
  }
}

async function deliverPendingToolResultMessage(
  input: AgentLoopInput,
  state: AgentSessionExecutionState,
  message: Extract<AgentMessage, { readonly role: "toolResult" }>,
  parentInvocationId?: string,
): Promise<void> {
  const delivery = pendingToolResultForMessage(
    state.pendingToolResults,
    message,
    parentInvocationId,
    (error) => state.rootEvents.failMaintenance("session_tool_result_identity_mismatch", error),
  );
  if (delivery !== undefined) await deliverAcceptedToolResult(input, state, delivery);
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
    state.toolResults.set(toolInvocationId(failure), failure);
    return harnessToolResult(failure, state, true);
  }
}

function toolExecutionContext(
  input: AgentLoopInput,
  boundary: AgentLoopToolBoundary,
  request: ToolCallRequest,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<ToolExecutionDetails> | undefined,
): ToolExecutionContext & { readonly abortSignal: AbortSignal } {
  return {
    ...boundary.context,
    invocationId: request.invocationId,
    providerCallId: request.providerCallId,
    abortSignal: signal ?? input.abortSignal,
    ...(input.onToolProgress === undefined ? {} : {
      reportProgress: (progress: Parameters<NonNullable<typeof input.onToolProgress>>[0]["progress"]) => {
        input.onToolProgress?.({
          providerCallId: request.providerCallId,
          invocationId: request.invocationId,
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

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Agent loop was cancelled.", "AbortError");
}

function abortMessage(reason: unknown): string {
  return reason === undefined ? "cancelled" : errorMessage(reason);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
