import type {
  AgentCapabilitySnapshot,
  CapabilitySkillCatalogItem,
  CapabilitySubAgentCatalogItem,
  RunCapabilityPlan,
  RunCapabilityResolution,
} from "../../domain/config/index.js";
import type { OrdinaryRunContext } from "../../domain/ordinary/index.js";
import type { ToolDefinition, ToolExecutionBroker } from "../../domain/tools/index.js";
import type { CapabilityAgentProfile } from "./capability-policy.js";
import type { AgentLoopToolVisibilityPlan } from "../model-runtime/agent-loop.js";
import type { ModelVisibleToolDefinitionTokenCounter } from "../model-runtime/tool-definition-visibility-cost.js";
import { frozenToolDefinitionsForRun } from "./capability-tool-definitions.js";
import { resolveRunCapabilities } from "./capability-policy.js";
import { createRunCapabilityPlan } from "../model-runtime/model-capability-registry.js";
import { toolDefinitionContractHash } from "./tool-definition-contract.js";
import { hasReadableSelectedSkillResources, type SkillToolContext } from "../skills/skill-resource-tool.js";
import { resolveMcpFirstToolVisibilityPlan } from "./run-tool-visibility-policy.js";

export type ResolveRunToolBoundaryInput = {
  readonly agentDefinition: CapabilityAgentProfile;
  readonly snapshot?: AgentCapabilitySnapshot;
  /** Frozen catalogs supplied by the owning run feature. */
  readonly skillCatalog?: readonly CapabilitySkillCatalogItem[];
  readonly subAgentCatalog?: readonly CapabilitySubAgentCatalogItem[];
  readonly goal: string;
  readonly runContext: Pick<OrdinaryRunContext, "permissionBoundaryRefs">;
  readonly modelCapabilities?: AgentCapabilitySnapshot["modelCapabilities"];
  readonly capabilityPlan?: RunCapabilityPlan;
  readonly platform?: NodeJS.Platform;
  readonly toolCenter?: ToolExecutionBroker;
  readonly agentToolDefinitions?: readonly ToolDefinition[];
  readonly skillContexts?: readonly SkillToolContext[];
  /** Model-specific counter used only to decide whether progressive definitions save context. */
  readonly toolDefinitionTokenCounter?: ModelVisibleToolDefinitionTokenCounter;
};

export type ResolvedRunToolBoundary = {
  /** ToolCenter-backed tools allowed to execute in this run. */
  readonly allowedTools: readonly string[];
  /** Pi AgentTools allowed by the same frozen capability resolution. */
  readonly allowedAgentToolNames: readonly string[];
  readonly toolDefinitions: readonly ToolDefinition[];
  /** Optional run-frozen policy for progressively exposing long-tail MCP definitions. */
  readonly toolVisibilityPlan?: AgentLoopToolVisibilityPlan;
  readonly capabilityResolution?: RunCapabilityResolution;
};

export function resolveRunToolBoundary(input: ResolveRunToolBoundaryInput): ResolvedRunToolBoundary {
  if (input.snapshot === undefined) {
    return {
      allowedTools: [],
      allowedAgentToolNames: [],
      toolDefinitions: [],
      toolVisibilityPlan: undefined,
      capabilityResolution: undefined,
    };
  }
  const capabilityPlan = input.capabilityPlan ?? createRunCapabilityPlan({
    profile: input.snapshot.activeModel,
    modelCapabilities: input.modelCapabilities ?? input.snapshot.modelCapabilities,
  });
  const capabilityResolution = addSelectedSkillToolDeclarationWarnings(
    restrictRunCapabilityResolutionToExecutableTools(
      reconcileRunCapabilityResolutionForSelectedSkillResources(
        hidePresetSubAgentToolsWithoutEnabledCatalog(
          resolveRunCapabilities({
            snapshot: input.snapshot,
            skillCatalog: input.skillCatalog,
            goal: input.goal,
            agentDefinition: input.agentDefinition,
            runContext: input.runContext,
            platform: input.platform,
            capabilityPlan,
          }),
          input.subAgentCatalog,
        ),
        {
          toolCenter: input.toolCenter,
          skillContexts: input.skillContexts ?? [],
        },
      ),
      input.toolCenter,
      input.snapshot,
      input.agentToolDefinitions,
    ),
    input.skillContexts ?? [],
  );
  const agentToolDefinitions = new Map(
    (input.agentToolDefinitions ?? []).map((definition) => [definition.name, definition]),
  );
  const allowedAgentToolNames = capabilityResolution.allowedTools.filter((name) =>
    agentToolDefinitions.has(name)
  );
  const allowedTools = capabilityResolution.allowedTools.filter((name) =>
    !agentToolDefinitions.has(name)
  );
  const frozenDefinitions = frozenToolDefinitionsForRun({
    snapshot: input.snapshot,
    allowedTools: capabilityResolution.allowedTools,
  });
  const toolDefinitions = frozenDefinitions;
  const toolVisibilityPlan = resolveMcpFirstToolVisibilityPlan({
    snapshot: input.snapshot,
    executionAllowedToolNames: allowedTools,
    allowedAgentToolNames,
    frozenDefinitions: toolDefinitions,
    toolDefinitionTokenCounter: input.toolDefinitionTokenCounter,
  });
  return {
    allowedTools,
    allowedAgentToolNames,
    toolDefinitions,
    toolVisibilityPlan,
    capabilityResolution,
  };
}

const PRESET_SUB_AGENT_TOOL_NAMES = new Set(["Agent"]);

export function hidePresetSubAgentToolsWithoutEnabledCatalog(
  resolution: RunCapabilityResolution,
  subAgentCatalog: readonly CapabilitySubAgentCatalogItem[] | undefined,
): RunCapabilityResolution {
  if (subAgentCatalog?.some((subAgent) => subAgent.enabled) === true) {
    return resolution;
  }
  const allowedTools = resolution.allowedTools.filter((toolName) => !PRESET_SUB_AGENT_TOOL_NAMES.has(toolName));
  if (allowedTools.length === resolution.allowedTools.length) {
    return resolution;
  }
  const toolExposures = resolution.toolExposures.map((tool) =>
      PRESET_SUB_AGENT_TOOL_NAMES.has(tool.name) && tool.modelVisible
        ? {
          ...tool,
          modelVisible: false,
          reasonCode: "no_enabled_sub_agents" as const,
          reason: "本轮没有可调用的预置子 Agent。",
        }
        : tool
    );
  return capabilityResolutionWithVisibleTools({
    resolution,
    allowedTools,
    toolExposures,
    warnings: resolution.warnings,
  });
}

export function restrictRunCapabilityResolutionToExecutableTools(
  resolution: RunCapabilityResolution,
  toolCenter: ToolExecutionBroker | undefined,
  snapshot?: AgentCapabilitySnapshot,
  agentToolDefinitions: readonly ToolDefinition[] = [],
): RunCapabilityResolution {
  const executableDefinitions = new Map([
    ...(toolCenter?.list() ?? []).map((tool) => [tool.name, tool] as const),
    ...agentToolDefinitions.map((tool) => [tool.name, tool] as const),
  ]);
  const executableTools = new Set(executableDefinitions.keys());
  const frozenToolsByName = new Map(snapshot?.toolCatalog.tools.map((tool) => [tool.name, tool]) ?? []);
  if (executableTools.size === 0) {
    const hiddenExecutableToolCount = resolution.allowedTools.length;
    const warnings = capabilityWarningsAfterExecutableRestriction({
      warnings: resolution.warnings,
      hiddenCount: hiddenExecutableToolCount,
      noModelVisibleTools: true,
    });
    const toolExposures = resolution.toolExposures.map((tool) =>
        tool.modelVisible
          ? { ...tool, modelVisible: false, reasonCode: "no_executable_tool_runner" as const, reason: "本轮没有可执行的工具运行器。" }
          : tool
    );
    return capabilityResolutionWithVisibleTools({ resolution, allowedTools: [], toolExposures, warnings });
  }
  const contractMismatchedTools = new Set<string>();
  const allowedTools = resolution.allowedTools.filter((toolName) => {
    if (!executableTools.has(toolName)) {
      return false;
    }
    if (toolContractMatchesFrozenSnapshot(toolName, executableDefinitions, frozenToolsByName)) {
      return true;
    }
    contractMismatchedTools.add(toolName);
    return false;
  });
  const hiddenExecutableToolCount = resolution.allowedTools.length - allowedTools.length;
  const missingExecutableToolCount = resolution.allowedTools.filter((toolName) => !executableTools.has(toolName)).length;
  const warnings = hiddenExecutableToolCount <= 0
    ? resolution.warnings
    : capabilityWarningsAfterExecutableRestriction({
        warnings: resolution.warnings,
        hiddenCount: missingExecutableToolCount,
        noModelVisibleTools: allowedTools.length === 0,
        contractMismatchCount: contractMismatchedTools.size,
      });
  const toolExposures = resolution.toolExposures.map((tool) =>
      tool.modelVisible && !executableTools.has(tool.name)
        ? { ...tool, modelVisible: false, reasonCode: "executable_tool_missing" as const, reason: "工具执行器当前未提供该工具。" }
        : tool.modelVisible && contractMismatchedTools.has(tool.name)
          ? {
            ...tool,
            modelVisible: false,
            reasonCode: "tool_contract_mismatch" as const,
            reason: "工具执行契约与本 run 创建时冻结的契约不一致。",
          }
        : tool
    );
  return capabilityResolutionWithVisibleTools({ resolution, allowedTools, toolExposures, warnings });
}

function toolContractMatchesFrozenSnapshot(
  toolName: string,
  executableDefinitions: ReadonlyMap<string, ToolDefinition>,
  frozenToolsByName: ReadonlyMap<string, AgentCapabilitySnapshot["toolCatalog"]["tools"][number]>
): boolean {
  const frozenHash = frozenToolsByName.get(toolName)?.definitionHash;
  const currentDefinition = executableDefinitions.get(toolName);
  const currentHash = currentDefinition === undefined ? undefined : toolDefinitionContractHash(currentDefinition);
  return frozenHash !== undefined && currentHash !== undefined && currentHash === frozenHash;
}

export function reconcileRunCapabilityResolutionForSelectedSkillResources(
  resolution: RunCapabilityResolution,
  input: {
    readonly toolCenter?: ToolExecutionBroker;
    readonly skillContexts: readonly SkillToolContext[];
  }
): RunCapabilityResolution {
  const selectedSkillResources = hasReadableSelectedSkillResources(input.skillContexts);
  const readSkillResourceExecutable = input.toolCenter?.has("SkillRead") === true;
  const exposure = resolution.toolExposures.find((tool) => tool.name === "SkillRead");
  if (exposure === undefined) {
    return resolution;
  }
  if (selectedSkillResources && readSkillResourceExecutable && exposure.reasonCode === "not_in_run_scope") {
    const allowedTools = [...resolution.allowedTools, "SkillRead"];
    const toolExposures = resolution.toolExposures.map((tool) =>
        tool.name === "SkillRead"
          ? { ...tool, modelVisible: true, reasonCode: "selected_skill_resources_available" as const, reason: "当前已选中技能提供可读资源。" }
          : tool
      );
    const warnings = capabilityWarningsAfterSkillResourceRestriction({
      warnings: resolution.warnings,
      hiddenSkillResourceTool: false,
      noModelVisibleTools: false,
    });
    return capabilityResolutionWithVisibleTools({ resolution, allowedTools, toolExposures, warnings });
  }
  if (selectedSkillResources || exposure.reasonCode !== "not_in_run_scope" && !exposure.modelVisible) {
    return resolution;
  }
  const allowedTools = resolution.allowedTools.filter((toolName) => toolName !== "SkillRead");
  const warnings = capabilityWarningsAfterSkillResourceRestriction({
    warnings: resolution.warnings,
    hiddenSkillResourceTool: exposure.modelVisible || exposure.reasonCode === "not_in_run_scope",
    noModelVisibleTools: allowedTools.length === 0,
  });
  const toolExposures = resolution.toolExposures.map((tool) =>
      tool.name === "SkillRead"
        ? { ...tool, modelVisible: false, reasonCode: "selected_skill_resources_unavailable" as const, reason: "当前没有已选中且可读的技能资源。" }
        : tool
    );
  return capabilityResolutionWithVisibleTools({ resolution, allowedTools, toolExposures, warnings });
}

export function addSelectedSkillToolDeclarationWarnings(
  resolution: RunCapabilityResolution,
  skillContexts: readonly SkillToolContext[]
): RunCapabilityResolution {
  const declared = selectedSkillAllowedTools(skillContexts);
  if (declared.size === 0) {
    return resolution;
  }
  const unavailableDeclaredToolCount = [...declared]
    .filter((toolName) => !resolution.allowedTools.includes(toolName))
    .length;
  const warnings = capabilityWarningsAfterSkillToolDeclarations({
    warnings: resolution.warnings,
    unavailableDeclaredToolCount,
  });
  return capabilityResolutionWithVisibleTools({
    resolution,
    allowedTools: resolution.allowedTools,
    toolExposures: resolution.toolExposures,
    warnings,
  });
}

function selectedSkillAllowedTools(
  skillContexts: readonly SkillToolContext[]
): ReadonlySet<string> {
  const allowedTools = new Set<string>();
  for (const context of skillContexts) {
    if ((context.loadStatus ?? "loaded") !== "loaded" || context.omitted === true) {
      continue;
    }
    for (const toolName of skillAllowedTools(context.skill)) {
      allowedTools.add(toolName);
    }
  }
  return allowedTools;
}

function skillAllowedTools(skill: SkillToolContext["skill"]): readonly string[] {
  return (skill.allowedTools ?? []).filter((tool) => tool.trim().length > 0);
}

function capabilityResolutionWithVisibleTools(input: {
  readonly resolution: RunCapabilityResolution;
  readonly allowedTools: readonly string[];
  readonly toolExposures: RunCapabilityResolution["toolExposures"];
  readonly warnings: readonly string[];
}): RunCapabilityResolution {
  const warnings = normalizeCapabilityWarnings({
    warnings: input.warnings,
    allowedTools: input.allowedTools,
    toolExposures: input.toolExposures,
  });
  const visibleTools = input.toolExposures.filter((tool) => tool.modelVisible);
  const visibleToolNames = visibleTools.map((tool) => tool.name);
  return {
    ...input.resolution,
    allowedTools: input.allowedTools,
    capabilityPlan: {
      ...input.resolution.capabilityPlan,
      tools: input.resolution.capabilityPlan.tools === undefined
        ? undefined
        : {
            ...input.resolution.capabilityPlan.tools,
            allowedTools: input.allowedTools,
          },
      fileOperations: {
        canReadWorkspace: visibleTools.some((tool) =>
          tool.operationType === "read-only" ||
          tool.operationType === "read-write" ||
          tool.operationType === "execute"
        ),
        canWriteWorkspace: visibleTools.some((tool) => tool.operationType === "read-write"),
        canDeleteWorkspace: visibleTools.some((tool) => tool.fileOperation === "delete"),
        canExecuteCommands: visibleTools.some((tool) => tool.operationType === "execute"),
      },
      uiDisplay: {
        canShowStreamingOutput:
          input.resolution.capabilityPlan.uiDisplay?.canShowStreamingOutput ??
          input.resolution.capabilityPlan.modelCapabilities.supportsStreaming,
        canShowToolCards: visibleToolNames.length > 0,
        visibleToolNames,
      },
      allowedTools: input.allowedTools,
      warnings,
    },
    toolExposures: input.toolExposures,
    warnings,
  };
}

function capabilityWarningsAfterExecutableRestriction(input: {
  readonly warnings: readonly string[];
  readonly hiddenCount: number;
  readonly noModelVisibleTools: boolean;
  readonly contractMismatchCount?: number;
}): readonly string[] {
  const next = [...input.warnings];
  if (input.noModelVisibleTools && !next.includes("本轮没有可用工具。")) {
    next.push("本轮没有可用工具。");
  }
  if (input.hiddenCount > 0 && !next.some((warning) => warning.includes("工具执行器"))) {
    next.push(`本轮有 ${input.hiddenCount} 个策略可见工具没有对应的工具执行器。`);
  }
  if (
    (input.contractMismatchCount ?? 0) > 0 &&
    !next.some((warning) => warning.includes("工具执行契约"))
  ) {
    next.push(`本轮有 ${input.contractMismatchCount} 个工具执行契约与冻结快照不一致，已隐藏。`);
  }
  return next;
}

function capabilityWarningsAfterSkillToolDeclarations(input: {
  readonly warnings: readonly string[];
  readonly unavailableDeclaredToolCount: number;
}): readonly string[] {
  const next = [...input.warnings];
  if (input.unavailableDeclaredToolCount > 0 && !next.some((warning) => warning.includes("声明了当前运行不可用工具"))) {
    next.push(`选中技能声明了 ${input.unavailableDeclaredToolCount} 个当前运行不可用工具。`);
  }
  return next;
}

function capabilityWarningsAfterSkillResourceRestriction(input: {
  readonly warnings: readonly string[];
  readonly hiddenSkillResourceTool: boolean;
  readonly noModelVisibleTools: boolean;
}): readonly string[] {
  const next = input.warnings.filter((warning) =>
    warning !== "当前没有已选中且可读的技能资源，已隐藏 skill_read。"
  );
  if (
    input.hiddenSkillResourceTool &&
    !next.includes("当前没有已选中且可读的技能资源，已隐藏 skill_read。")
  ) {
    next.push("当前没有已选中且可读的技能资源，已隐藏 skill_read。");
  }
  return next;
}

function normalizeCapabilityWarnings(input: {
  readonly warnings: readonly string[];
  readonly allowedTools: readonly string[];
  readonly toolExposures: RunCapabilityResolution["toolExposures"];
}): readonly string[] {
  const next = input.warnings.filter((warning) =>
    warning !== "本轮没有可用工具。" && !/^已隐藏 \d+ 个不可用工具。$/u.test(warning)
  );
  if (input.allowedTools.length === 0) {
    next.push("本轮没有可用工具。");
  }
  const hiddenCount = input.toolExposures.filter((tool) => tool.enabled && !tool.modelVisible).length;
  if (hiddenCount > 0) {
    next.push(`已隐藏 ${hiddenCount} 个不可用工具。`);
  }
  return next;
}
