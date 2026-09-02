import type { OrdinaryRunContext } from "../../../domain/ordinary/index.js";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnv, Session } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionLoop,
  createModelCollectionChannel,
  createModelProviderBinding,
  type AgentSessionToolDefinitionMetrics,
} from "../../../adapters/intelligence/index.js";
import type { AgentSessionEntryRef, AgentSessionRef } from "../../model-runtime/agent-session.js";
import type { ModelMessage } from "../../../domain/intelligence/index.js";
import type { AgentDefinition } from "../../agent-prompts/contracts.js";
import {
  agentDefinitionRefMatchesDefinition,
  isCompleteRunAgentDefinitionRef,
} from "../../agent-definitions/agent-definition-ref.js";
import { resolveRunToolBoundary } from "../../capability/run-tool-boundary.js";
import {
  createOpenAITokenCounter,
  type AgentLoopTokenCounter,
} from "../../context-maintenance/index.js";
import { CodedExecutionError, executionErrorFacts } from "../../execution-errors/index.js";
import {
  type AgentLoop,
  type AgentLoopToolBoundary,
  type ModelRuntimeChannelFactory,
} from "../../model-runtime/index.js";
import { resolveOpenAIModelRuntimeConfig } from "../../model-runtime/openai-runtime-config.js";
import type {
  AcquireOrdinaryAgentLoopRunResourcesInput,
  OrdinaryAgentLoopRunResourceAcquirer,
} from "../../ordinary-agent/agent-loop-execution.js";
import { buildOrdinaryAgentModelInput } from "../../ordinary-agent/model-input.js";
import { attachOrdinaryFileInputsToModelMessages } from "../../ordinary-agent/model-input-attachments.js";
import { ToolExecutionObservationGateway } from "../../ordinary-agent/tool-execution-observation-gateway.js";
import { OrdinaryToolMetricsCollector } from "../../ordinary-agent/tool-runtime-metrics.js";
import { createReadSkillResourceTool, hasReadableSelectedSkillResources } from "../../skills/skill-resource-tool.js";
import type { SelectedSkillContext } from "../../skills/index.js";
import {
  createSubAgentAgentToolCatalogContribution,
  createSubAgentAgentTools,
} from "../../sub-agents/sub-agent-agent-tools.js";
import { SubAgentRegistry } from "../../sub-agents/sub-agent-registry.js";
import type { SubAgentRootInput } from "../../sub-agents/sub-agent-loader.js";
import type { ContextAttachmentReadAuthorization } from "../../tool-center/adapters/context-attachment-access.js";
import type { LocalWorkspacePathAuthorization } from "../../tool-center/adapters/local-workspace-common.js";
import { createOrdinaryRunContextFromInput } from "../../context/ordinary-run-input-adapter.js";
import {
  createAgentToolCenterFactory,
  prepareAgentHostRunResources,
  type AgentRunResourceHost,
  type AgentHostRunResources,
} from "./agent-run-resources.js";
import {
  createHostAgentToolContributions,
  type HostFeatureAgentToolContributionResolver,
} from "./agent-tool-contributions.js";

export type OrdinaryAgentDefinitionResolver = (
  input: {
    readonly ref: AcquireOrdinaryAgentLoopRunResourcesInput["birth"]["agentDefinitionRef"];
    readonly instructions: string;
  },
) => AgentDefinition | undefined | Promise<AgentDefinition | undefined>;

export type OrdinaryAgentSkillContextResolver = (input: {
  readonly runId: string;
  readonly goal: string;
  readonly catalog: AcquireOrdinaryAgentLoopRunResourcesInput["birth"]["capabilitySnapshot"]["skillCatalog"];
  readonly triggerMode: "keyword" | "model";
  /** Current request messages used only for skill discovery; Session owns history. */
  readonly modelMessages: readonly ModelMessage[];
  /** Temporary neutral channel factory used only by Host-owned semantic skill routing. */
  readonly createIntelligenceChannel: ModelRuntimeChannelFactory;
  readonly abortSignal: AbortSignal;
}) => Promise<readonly SelectedSkillContext[]>;

export type CreateOrdinaryAgentRunResourceAcquirerInput = {
  readonly host: AgentRunResourceHost;
  readonly sessionRepository: {
    acquire(ref: AgentSessionRef): Promise<AgentSessionWriterLease>;
  };
  readonly resolveAgentDefinition: OrdinaryAgentDefinitionResolver;
  readonly resolveSkillContexts?: OrdinaryAgentSkillContextResolver;
  readonly resolveFeatureToolContributions?: HostFeatureAgentToolContributionResolver;
  /** Binds feature-tool reads and explicit adoption to this exact Ordinary run. */
  readonly resolveMemoryFactSink?: (input: {
    readonly runId: string;
    readonly conversationId: string;
  }) => NonNullable<Parameters<HostFeatureAgentToolContributionResolver>[0]["memoryFacts"]>;
  /**
   * Resolves the implicit long-term memory advisory block for this turn
   * (Memory v2 Context Provider). Degrades to undefined when absent/empty.
   */
  readonly resolveImplicitMemoryBlock?: (input: {
    readonly owner: import("../../../domain/memory/index.js").MemoryOwner;
    readonly conversationId?: string;
    readonly userText: string;
    readonly turnOverrideOff: boolean;
  }) => Promise<string | undefined>;
  readonly resolveSubAgentRoots: (workspaceRoot: string) => readonly SubAgentRootInput[];
  readonly contextAttachmentReadAuthorization?: ContextAttachmentReadAuthorization;
  readonly resolveWorkspacePathAuthorization?: (input: {
    readonly runContext: OrdinaryRunContext;
    readonly workspaceRoot: string;
  }) => LocalWorkspacePathAuthorization | undefined;
};

type AgentSessionWriterLease = {
  readonly session: Session;
  revokeTo(target: AgentSessionEntryRef | null): Promise<void>;
  release(): Promise<void>;
};

type OrdinaryAgentRunResourceAcquirerDependencies = {
  readonly prepareHostResources?: (
    runtime: AgentRunResourceHost,
    input: {
      readonly capabilitySnapshot: AcquireOrdinaryAgentLoopRunResourcesInput["birth"]["capabilitySnapshot"];
      readonly informationAccess: AcquireOrdinaryAgentLoopRunResourcesInput["birth"]["informationAccess"];
    },
  ) => Promise<AgentHostRunResources<AcquireOrdinaryAgentLoopRunResourcesInput["birth"]["capabilitySnapshot"]>>;
  readonly createSessionLoop?: typeof createAgentSessionLoop;
  readonly createProviderBinding?: typeof createModelProviderBinding;
  readonly createExecutionEnvironment?: (cwd: string) => ExecutionEnv;
  readonly createTokenCounter?: (model?: string) => AgentLoopTokenCounter;
  readonly resolveToolBoundary?: typeof resolveRunToolBoundary;
};

/**
 * Host-owned composition adapter for one frozen Ordinary run. The Ordinary
 * feature sees only its resource-acquirer port and never imports Panel code.
 */
export function createOrdinaryAgentRunResourceAcquirer(
  options: CreateOrdinaryAgentRunResourceAcquirerInput,
  dependencies: OrdinaryAgentRunResourceAcquirerDependencies = {},
): OrdinaryAgentLoopRunResourceAcquirer {
  return {
    async acquire(input) {
      const definition = await resolveFrozenAgentDefinition(options, input).catch((error: unknown) => {
        throw expectedOrWrappedExecutionError(
          error,
          "run_resource_acquisition_failed",
          "Ordinary run resources could not be acquired.",
        );
      });
      const resources = await (dependencies.prepareHostResources ?? prepareAgentHostRunResources)(options.host, {
        capabilitySnapshot: input.birth.capabilitySnapshot,
        informationAccess: input.birth.informationAccess,
      }).catch((error: unknown) => {
        throw expectedOrWrappedExecutionError(
          error,
          "run_resource_acquisition_failed",
          "Ordinary run resources could not be acquired.",
        );
      });
      let loop: AgentLoop | undefined;
      let sessionLease: AgentSessionWriterLease | undefined;
      let executionEnvironment: ExecutionEnv | undefined;
      try {
        const runContext = createOrdinaryRunContextFromInput({
          goal: input.runInput.userMessage,
          goalId: input.runId,
          traceId: input.runId,
          aiMode: input.birth.aiMode,
          contextInput: input.runInput.context,
        });
        const providerBinding = await createCustomProviderBindingForRun(options, dependencies, input, resources.aiEnvironment);
        const currentModelMessages: readonly ModelMessage[] = [{
          role: "user",
          content: input.runInput.userMessage,
        }];
        const createSkillRoutingChannel = () =>
          createModelCollectionChannel({
            modelRegistry: providerBinding.modelRegistry,
            selectedModel: providerBinding.selectedModel,
            thinkingLevel: providerBinding.thinkingLevel,
            transformProviderPayload: providerBinding.transformProviderPayload,
            providerKind: input.birth.config.providerKind,
            supportedPurposes: ["skill_routing"],
          });
        const skillContexts = await options.resolveSkillContexts?.({
          runId: input.runId,
          goal: input.runInput.userMessage,
          catalog: input.birth.capabilitySnapshot.skillCatalog,
          triggerMode: input.birth.capabilitySnapshot.skillTrigger?.mode ?? "keyword",
          modelMessages: currentModelMessages,
          createIntelligenceChannel: createSkillRoutingChannel,
          abortSignal: input.abortSignal,
        }) ?? [];
        const workspacePathAuthorization = options.resolveWorkspacePathAuthorization?.({
          runContext,
          workspaceRoot: resources.workspaceRoot,
        });
        const toolMetrics = new OrdinaryToolMetricsCollector();
        const tokenCounter = (dependencies.createTokenCounter ?? createOpenAITokenCounter)(
          input.birth.config.model,
        );
        const toolDefinitionTokenCounter =
          input.birth.capabilitySnapshot.modelCapabilities.protocolProfileId === "openai" &&
          tokenCounter.tokenizerMatch === "model"
            ? tokenCounter.countText
            : undefined;
        const toolCenter = createAgentToolCenterFactory(options.host.providerFetch, resources)({
          runContext,
          outputTokenCounter: tokenCounter,
          metricsSink: toolMetrics,
          contextAttachmentReadAuthorization: options.contextAttachmentReadAuthorization,
          workspacePathAuthorization,
          // Space-owned runs may gain their first reference inside the run;
          // keeping AttachmentList visible lets the model discover that no
          // attachment is available yet instead of hiding the tool family.
          // The exposure decision is Host-declared, not inferred here.
          exposeContextAttachmentToolsWhenEmpty: options.host.resolveAttachmentToolExposure?.(runContext) ?? false,
          contributions: [
            ...createHostAgentToolContributions({
              resources,
              providerFetch: options.host.providerFetch,
              featureContributions: options.resolveFeatureToolContributions?.({
                workspaceRoot: resources.workspaceRoot,
                runContext,
                memoryOwner: input.birth.memoryOwner,
                agentNoteVersions: input.birth.agentNoteVersions,
                run: { runId: input.runId, conversationId: input.conversationId },
                memoryFacts: options.resolveMemoryFactSink?.({
                  runId: input.runId,
                  conversationId: input.conversationId,
                }),
                countMemoryTokens: tokenCounter.countText,
              }),
            }),
            (register) => {
              if (!hasReadableSelectedSkillResources(skillContexts)) return;
              register({
                executor: createReadSkillResourceTool(skillContexts),
                scopes: ["agent-basic"],
                enabledByDefault: true,
              });
            },
          ],
        });
        const registry = new SubAgentRegistry({
          roots: options.resolveSubAgentRoots(resources.workspaceRoot),
          catalog: input.birth.capabilitySnapshot.subAgentCatalog,
        });
        const frozenSubAgents = await registry.list();
        const subAgentToolCatalog = createSubAgentAgentToolCatalogContribution({
          subAgents: frozenSubAgents,
          dynamicSpawnAvailable: true,
        });
        let toolBoundary: ReturnType<typeof resolveRunToolBoundary>;
        try {
          toolBoundary = (dependencies.resolveToolBoundary ?? resolveRunToolBoundary)({
            agentDefinition: definition,
            snapshot: input.birth.capabilitySnapshot,
            skillCatalog: input.birth.capabilitySnapshot.skillCatalog,
            subAgentCatalog: input.birth.capabilitySnapshot.subAgentCatalog,
            goal: input.runInput.userMessage,
            runContext,
            toolCenter,
            agentToolDefinitions: subAgentToolCatalog.definitions,
            skillContexts,
            toolDefinitionTokenCounter,
          });
        } catch (error) {
          throw expectedOrWrappedExecutionError(
            error,
            "tool_boundary_resolution_failed",
            "Ordinary tool boundary could not be resolved.",
          );
        }
        const observedToolGateway = new ToolExecutionObservationGateway(toolCenter, toolMetrics);
        const tools = ordinaryToolBoundary(
          input,
          definition,
          observedToolGateway,
          toolBoundary.allowedTools,
          toolBoundary.toolDefinitions,
          workspacePathAuthorization,
        );
        const agentTools = await createSubAgentAgentTools({
          registry,
          parentAllowedTools: toolBoundary.allowedTools,
          executableTools: toolCenter.list().map((tool) => tool.name),
          exposedToolNames: toolBoundary.allowedAgentToolNames,
          dynamicSpawnAvailable: true,
        });
        const implicitMemoryBlock = await options.resolveImplicitMemoryBlock?.({
          owner: input.birth.memoryOwner,
          conversationId: input.conversationId,
          userText: input.runInput.userMessage,
          turnOverrideOff: input.runInput.turnMemoryOverrideOff === true,
        }) ?? undefined;
        const modelInput = buildOrdinaryAgentModelInput({
          agentDefinition: definition,
          goal: input.runInput.userMessage,
          runContext,
          skillContexts,
          ownerContext: input.birth.ownerContext,
          implicitMemoryBlock,
        });
        const messagesWithAttachments = await attachOrdinaryFileInputsToModelMessages({
          messages: modelInput.messages,
          runContext,
          modelCapabilities: resources.capabilitySnapshot.modelCapabilities,
          workspaceRoot: resources.workspaceRoot,
          resolveManagedAttachmentPath: resources.resolveManagedAttachmentPath,
          readAuthorization: options.contextAttachmentReadAuthorization,
        });
        executionEnvironment = (dependencies.createExecutionEnvironment ??
          ((cwd: string) => new NodeExecutionEnv({ cwd })))(resources.workspaceRoot);
        sessionLease = await options.sessionRepository.acquire(input.sessionRef);
        loop = (dependencies.createSessionLoop ?? createAgentSessionLoop)({
          executionEnvironment,
          modelRegistry: providerBinding.modelRegistry,
          selectedModel: providerBinding.selectedModel,
          supportsVisionInput: resources.capabilitySnapshot.modelCapabilities.supportsVisionInput,
          thinkingLevel: providerBinding.thinkingLevel,
          transformProviderPayload: providerBinding.transformProviderPayload,
          toolDefinitionTokenCounter: tokenCounter.countText,
          onProviderToolDefinitionMetrics: (metrics) => {
            recordProviderToolDefinitionMetrics(toolMetrics, metrics);
          },
          agentSession: sessionLease.session,
        });
        const ownedLoop = loop;
        const ownedSessionLease = sessionLease;
        const ownedExecutionEnvironment = executionEnvironment;
        const processTerminator = options.host.processTerminator;
        const release = idempotentRelease([
          () => ownedLoop.release(),
          resources.release,
          ...(processTerminator === undefined
            ? []
            : [() => options.host.processRegistry.cleanupByRun(
                input.runId,
                processTerminator,
              ).then(() => undefined)]),
          () => ownedExecutionEnvironment.cleanup(),
        ]);
        return {
          loop,
          resolvedMessages: messagesWithAttachments,
          tools,
          toolMetrics,
          revokeSessionTo: (target) => ownedSessionLease.revokeTo(target),
          releaseSession: ownedSessionLease.release,
          ...(toolBoundary.capabilityResolution === undefined
            ? {}
            : { capabilityResolution: toolBoundary.capabilityResolution }),
          ...(toolBoundary.toolVisibilityPlan === undefined
            ? {}
            : { toolVisibilityPlan: toolBoundary.toolVisibilityPlan }),
          ...(agentTools.length === 0 ? {} : { agentTools }),
          release,
        };
      } catch (error) {
        await releaseAfterAcquireFailure(
          loop,
          sessionLease,
          executionEnvironment,
          resources.release,
        );
        throw expectedOrWrappedExecutionError(
          error,
          "run_resource_acquisition_failed",
          "Ordinary run resources could not be acquired.",
        );
      }
    },
  };
}

function recordProviderToolDefinitionMetrics(
  collector: OrdinaryToolMetricsCollector,
  metrics: AgentSessionToolDefinitionMetrics,
): void {
  collector.recordDefinitionRequest(metrics.toolCount, metrics.totalTokens);
  for (const tool of metrics.tools) {
    collector.record({
      kind: "definition",
      toolName: tool.toolName,
      operationType: tool.operationType,
      definitionHash: tool.definitionHash,
      definitionTokens: tool.definitionTokens,
      totalDefinitionTokens: metrics.totalTokens,
      toolCount: metrics.toolCount,
    });
  }
}

async function createCustomProviderBindingForRun(
  options: CreateOrdinaryAgentRunResourceAcquirerInput,
  dependencies: OrdinaryAgentRunResourceAcquirerDependencies,
  input: AcquireOrdinaryAgentLoopRunResourcesInput,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const mode = requireOpenAIModelRuntimeMode(input.birth.aiMode);
  const resolvedProvider = resolveOpenAIModelRuntimeConfig({
    mode,
    env: environment,
    modelProvider: input.birth.config,
  });
  return (dependencies.createProviderBinding ?? createModelProviderBinding)({
    protocol: resolvedProvider.protocol,
    baseUrl: resolvedProvider.baseUrl,
    model: resolvedProvider.model,
    profileId: input.birth.config.profileId,
    apiKey: resolvedProvider.apiKey,
    resolveApiKey: async () => {
      const currentEnvironment = await options.host.configCenter.createModelRuntimeEnvironment({
        modelProvider: input.birth.config,
        informationAccess: input.birth.informationAccess,
      });
      return resolveOpenAIModelRuntimeConfig({
        mode,
        env: currentEnvironment,
        modelProvider: input.birth.config,
      }).apiKey;
    },
    providerProfileId: resolvedProvider.providerProfileId,
    requestSettings: resolvedProvider.requestSettings,
    enableWebSearch: resolvedProvider.enableWebSearch,
    supportsVisionInput:
      input.birth.capabilitySnapshot.modelCapabilities.supportsVisionInput === true,
    supportsReasoningOutput:
      input.birth.capabilitySnapshot.modelCapabilities.supportsReasoningOutput === true,
    contextWindow: input.birth.capabilitySnapshot.modelCapabilities.contextWindowTokens,
    maxOutputTokens: input.birth.capabilitySnapshot.modelCapabilities.maxOutputTokens,
  });
}

async function resolveFrozenAgentDefinition(
  options: CreateOrdinaryAgentRunResourceAcquirerInput,
  input: AcquireOrdinaryAgentLoopRunResourcesInput,
): Promise<AgentDefinition> {
  const ref = input.birth.agentDefinitionRef;
  if (!isCompleteRunAgentDefinitionRef(ref)) {
    throw new CodedExecutionError(
      "agent_definition_mismatch",
      "Ordinary run requires a complete frozen AgentDefinition reference",
    );
  }
  const definition = await options.resolveAgentDefinition({ ref, instructions: input.birth.instructions });
  if (definition === undefined || !agentDefinitionRefMatchesDefinition(ref, definition)) {
    throw new CodedExecutionError(
      "agent_definition_mismatch",
      "Ordinary run AgentDefinition no longer matches its frozen reference",
    );
  }
  if (definition.turnPolicy.purpose !== "ordinary_agent") {
    throw new CodedExecutionError(
      "agent_definition_mismatch",
      "Agent run requires a valid Agent definition",
    );
  }
  if (definition.prompt.systemPrompt !== input.birth.instructions) {
    throw new CodedExecutionError(
      "agent_definition_mismatch",
      "Ordinary run instructions no longer match its frozen AgentDefinition",
    );
  }
  return definition;
}

function expectedOrWrappedExecutionError(
  error: unknown,
  code: string,
  message: string,
): unknown {
  return executionErrorFacts(error) === undefined
    ? new CodedExecutionError(code, message, { cause: error })
    : error;
}

function ordinaryToolBoundary(
  input: AcquireOrdinaryAgentLoopRunResourcesInput,
  definition: AgentDefinition,
  gateway: AgentLoopToolBoundary["gateway"],
  allowedTools: readonly string[],
  definitions: AgentLoopToolBoundary["definitions"],
  workspacePathAuthorization?: LocalWorkspacePathAuthorization,
): AgentLoopToolBoundary {
  return {
    definitions,
    gateway,
    context: {
      callerAgentId: definition.agentId,
      traceId: input.runId,
      goalId: input.runId,
      conversationId: input.conversationId,
      resourceScope: workspacePathAuthorization?.resourceScope,
      accessPolicy: input.birth.accessPolicy,
    },
    permission: {
      callerAgentId: definition.agentId,
      allowedTools,
      accessPolicy: input.birth.accessPolicy,
    },
  };
}

function idempotentRelease(releasers: readonly (() => Promise<void>)[]): () => Promise<void> {
  const pending = new Set(releasers.keys());
  let releasePromise: Promise<void> | undefined;
  return () => {
    releasePromise ??= releaseAll(releasers, pending).finally(() => {
      releasePromise = undefined;
    });
    return releasePromise;
  };
}

async function releaseAll(
  releasers: readonly (() => Promise<void>)[],
  pending: Set<number> = new Set(releasers.keys()),
): Promise<void> {
  const failures: unknown[] = [];
  for (const index of [...pending]) {
    const release = releasers[index];
    if (release === undefined) continue;
    try {
      await release();
      pending.delete(index);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Ordinary run resource release failed");
}

async function releaseAfterAcquireFailure(
  loop: AgentLoop | undefined,
  sessionLease: AgentSessionWriterLease | undefined,
  executionEnvironment: ExecutionEnv | undefined,
  releaseHostResources: () => Promise<void>,
): Promise<void> {
  await releaseAll([
    ...(loop === undefined ? [] : [() => loop.release()]),
    ...(sessionLease === undefined ? [] : [sessionLease.release]),
    releaseHostResources,
    ...(executionEnvironment === undefined ? [] : [() => executionEnvironment.cleanup()]),
  ]).catch(() => undefined);
}

function requireOpenAIModelRuntimeMode(
  mode: AcquireOrdinaryAgentLoopRunResourcesInput["birth"]["aiMode"],
): "openai-compatible" | "openai-responses" {
  if (mode === "openai-compatible" || mode === "openai-responses") return mode;
  throw new CodedExecutionError(
    "unsupported_provider_protocol",
    `Ordinary Session loop does not support runtime mode ${mode}.`,
  );
}
