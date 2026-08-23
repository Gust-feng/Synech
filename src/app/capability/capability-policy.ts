import type { AgentToolVisibilityProfile } from "../agent-prompts/contracts.js";

export type CapabilityAgentProfile = {
  readonly agentId: string;
  readonly displayName: string;
  readonly toolVisibilityProfile: AgentToolVisibilityProfile;
};
import {
  AgentCapabilitySnapshot,
  CapabilityDraft,
  CapabilitySkillCatalogItem,
  RunCapabilityResolution,
  RunEnabledSkill,
  RunToolExposure,
  RunToolExposureReasonCode,
  RunCapabilityPlan,
} from "../../domain/config/index.js";
import type { OrdinaryRunContext } from "../../domain/ordinary/index.js";
import { createId, nowIso } from "../../kernel/id.js";
import { resolveEffectiveConfirmationRequirement } from "../../domain/tools/index.js";
import { isToolVisibleToAgentProfile as isVisibleToProfile } from "../agent-prompts/contracts.js";
import { createRunCapabilityPlan } from "../model-runtime/model-capability-registry.js";

export type ResolveRunCapabilitiesInput = {
  readonly snapshot: AgentCapabilitySnapshot;
  /** Ordinary supplies its frozen Skill catalog; other features have no Skills. */
  readonly skillCatalog?: readonly CapabilitySkillCatalogItem[];
  readonly goal: string;
  readonly agentDefinition: CapabilityAgentProfile;
  readonly runContext?: Pick<OrdinaryRunContext, "permissionBoundaryRefs">;
  readonly platform?: NodeJS.Platform;
  readonly capabilityPlan?: RunCapabilityPlan;
};

// CapabilityCenter freezes what exists; this policy freezes what this specific
// run may expose to the model after task permissions, platform gates, and mode
// boundaries are applied.
export function resolveRunCapabilities(input: ResolveRunCapabilitiesInput): RunCapabilityResolution {
  const permissionRefs = new Set(input.runContext?.permissionBoundaryRefs ?? []);
  const baseCapabilityPlan = input.capabilityPlan ?? createRunCapabilityPlan({
    profile: input.snapshot.activeModel,
    modelCapabilities: input.snapshot.modelCapabilities,
  });
  const snapshotAllowedTools = new Set(input.snapshot.toolCatalog.allowedTools);
  // 模型可见集合的「单一推导」（FR-TOOL-001）：任一工具是否对模型可见，只由
  //   capabilitySnapshot.toolCatalog.tools ∩ toolVisibilityProfile ∩ snapshot.allowedTools ∩ permission
  // 这一条路径决定。这里不存在工具名前缀 / 关键字 / 硬编码白名单判定；裸 ToolCenter 仅执行，
  // 不单独决定可见集合（执行器裁剪在 run-tool-boundary 以交集方式二次收紧，不另立可见集合）。
  const toolExposures = input.snapshot.toolCatalog.tools.map((tool): RunToolExposure => {
    const availabilityAllowed = tool.enabled && tool.availability === "available";
    const allowedBySnapshot = snapshotAllowedTools.has(tool.name);
    const denied = isDeniedByPermissionRef(tool.name, permissionRefs);
    const modelVisible =
      baseCapabilityPlan.canExposeModelTools &&
      availabilityAllowed &&
      allowedBySnapshot &&
      !denied &&
      isVisibleToProfile(input.agentDefinition.toolVisibilityProfile, tool);
    // 有效确认要求取保守默认（FR-TOOL-002）：显式契约字段权威；缺失时高影响动作默认按需确认。
    const requiresConfirmation = resolveEffectiveConfirmationRequirement(tool);
    const reasonCode = exposureReasonCode({
      enabled: tool.enabled,
      availability: tool.availability,
      allowedBySnapshot,
      denied,
      canExposeModelTools: baseCapabilityPlan.canExposeModelTools,
      modelVisible,
      requiresConfirmation,
      confirmationPolicy: input.snapshot.toolConfirmation?.policy,
    });
    return {
      name: tool.name,
      displayName: tool.displayName,
      enabled: tool.enabled,
      modelVisible,
      scopes: tool.scopes,
      availability: tool.availability,
      riskLevel: tool.riskLevel,
      operationType: tool.operationType,
      fileOperation: tool.fileOperation,
      requiresConfirmation,
      ...(input.snapshot.toolConfirmation === undefined
        ? {}
        : { confirmationPolicy: input.snapshot.toolConfirmation.policy }),
      reasonCode,
      reason: exposureReason(reasonCode),
    };
  });
  const allowedTools = toolExposures
    .filter((tool) => tool.modelVisible)
    .map((tool) => tool.name);
  const warnings = capabilityResolutionWarnings({ snapshot: input.snapshot, allowedTools, toolExposures });
  const capabilityPlan = capabilityPlanForResolvedRun({
    baseCapabilityPlan,
    toolExposures,
    allowedTools,
    warnings,
  });
  return {
    resolutionId: createId("capability-resolution"),
    snapshotId: input.snapshot.snapshotId,
    runMode: input.agentDefinition.toolVisibilityProfile.runMode,
    agentId: input.agentDefinition.agentId,
    agentDisplayName: input.agentDefinition.displayName,
    toolVisibilityProfileId: input.agentDefinition.toolVisibilityProfile.profileId,
    capabilityPlan,
    allowedTools,
    toolExposures,
    enabledSkills: (input.skillCatalog ?? [])
      .filter(isRunEnabledSkill)
      .map((skill): RunEnabledSkill => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        triggers: [...skill.triggers],
        summary: skill.summary,
        category: skill.category,
        sourceKind: skill.sourceKind,
        sourceRootId: skill.sourceRootId,
        sourcePrecedence: skill.sourcePrecedence,
        stateKey: skill.stateKey,
        version: skill.version,
        provenance: skill.provenance === undefined ? undefined : { ...skill.provenance },
        whenToUse: skill.whenToUse,
        disableModelInvocation: skill.disableModelInvocation,
        userInvocable: skill.userInvocable,
        metadata: skill.metadata === undefined ? undefined : { ...skill.metadata },
        allowedTools: skill.allowedTools === undefined ? undefined : [...skill.allowedTools],
        contentHash: skill.contentHash,
        bodyHash: skill.bodyHash,
      })),
    mcpDrafts: input.snapshot.mcpCatalog.map((server): CapabilityDraft => ({
      draftId: `mcp:${server.serverId}`,
      source: "mcp",
      label: server.label,
      availability: server.availability,
      enabled: server.enabled,
      reason: server.enabled
        ? "已登记。"
        : "已停用。",
    })),
    warnings,
    createdAt: nowIso(),
  };
}

function isRunEnabledSkill(skill: CapabilitySkillCatalogItem): boolean {
  return skill.enabled && (skill.validationStatus === undefined || skill.validationStatus === "valid");
}

function capabilityPlanForResolvedRun(input: {
  readonly baseCapabilityPlan: RunCapabilityPlan;
  readonly toolExposures: readonly RunToolExposure[];
  readonly allowedTools: readonly string[];
  readonly warnings: readonly string[];
}): RunCapabilityPlan {
  const visibleTools = input.toolExposures.filter((tool) => tool.modelVisible);
  const visibleToolNames = visibleTools.map((tool) => tool.name);
  return {
    ...input.baseCapabilityPlan,
    tools: {
      canExposeToModel: input.baseCapabilityPlan.canExposeModelTools,
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
      canShowStreamingOutput: input.baseCapabilityPlan.modelCapabilities.supportsStreaming,
      canShowToolCards: visibleToolNames.length > 0,
      visibleToolNames,
    },
    allowedTools: input.allowedTools,
    warnings: input.warnings,
  };
}

function isDeniedByPermissionRef(toolName: string, refs: ReadonlySet<string>): boolean {
  return refs.has(`deny:tool:${toolName}`) || refs.has(`deny:${toolName}`);
}

function exposureReasonCode(input: {
  readonly enabled: boolean;
  readonly availability: "available" | "unavailable";
  readonly allowedBySnapshot: boolean;
  readonly denied: boolean;
  readonly canExposeModelTools: boolean;
  readonly modelVisible: boolean;
  readonly requiresConfirmation: boolean;
  readonly confirmationPolicy?: "prompt" | "full_access";
}): RunToolExposureReasonCode {
  if (!input.canExposeModelTools) return "model_tools_unsupported";
  if (!input.enabled) return "tool_disabled";
  if (input.availability !== "available") return "tool_unavailable";
  if (!input.allowedBySnapshot) return "not_in_run_scope";
  if (input.denied) return "permission_denied";
  if (!input.modelVisible) return "profile_hidden";
  if (input.requiresConfirmation && input.confirmationPolicy === "full_access") return "available_full_access";
  if (input.requiresConfirmation) return "available_requires_confirmation";
  return "available";
}

function exposureReason(reasonCode: RunToolExposureReasonCode): string {
  if (reasonCode === "model_tools_unsupported") return "当前模型不支持工具调用。";
  if (reasonCode === "tool_disabled") return "工具已在配置中停用。";
  if (reasonCode === "tool_unavailable") return "当前不可用。";
  if (reasonCode === "not_in_run_scope") return "不在本轮可用范围内。";
  if (reasonCode === "permission_denied") return "本轮已隐藏。";
  if (reasonCode === "profile_hidden") return "当前模式不可用。";
  if (reasonCode === "available_full_access") return "可用，当前完全访问会跳过逐条确认。";
  if (reasonCode === "available_requires_confirmation") return "可用，命令执行会先等你确认。";
  return "可用。";
}

function capabilityResolutionWarnings(input: {
  readonly snapshot: AgentCapabilitySnapshot;
  readonly allowedTools: readonly string[];
  readonly toolExposures: readonly RunToolExposure[];
}): readonly string[] {
  const warnings = [...input.snapshot.warnings];
  if (input.allowedTools.length === 0) {
    warnings.push("本轮没有可用工具。");
  }
  const hidden = input.toolExposures.filter((tool) => tool.enabled && !tool.modelVisible);
  if (hidden.length > 0) {
    warnings.push(`已隐藏 ${hidden.length} 个不可用工具。`);
  }
  if (input.snapshot.mcpCatalog.some((server) => server.enabled)) {
    warnings.push("MCP 已登记。");
  }
  return warnings;
}
