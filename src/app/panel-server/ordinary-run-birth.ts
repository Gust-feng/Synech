import { runModelConfiguration } from "../ordinary-agent/run-model-configuration.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConversationOwner } from "../../domain/execution-scope/index.js";
import { toolRunAccessPolicyFromPreset } from "../../domain/tools/index.js";
import {
  agentDefinitionRefMatchesDefinition,
  runAgentDefinitionRef,
  runAgentDefinitionRefCacheKey,
} from "../agent-definitions/agent-definition-ref.js";
import { ordinaryAgentDefinitionFromPromptConfig } from "../agent-prompts/ordinary-agent-configured-definition.js";
import type { AgentDefinition } from "../agent-prompts/contracts.js";
import type { CollaborationRulesApplication } from "../application/collaboration-rules-application.js";
import type { CapabilityCenter } from "../capability/capability-center.js";
import type { ConfigCenter } from "../config-center/index.js";
import type { OrdinaryAgentFeature, OrdinaryRunBirth } from "../ordinary-agent/index.js";
import type { SpaceFeature } from "../spaces/index.js";
import type { ProductPaths } from "../../platform/storage/index.js";
import type { SpaceConversationDeletionCoordinator } from "../workbench-coordination/index.js";
import { ordinaryCapabilitySnapshotForRunStart } from "./ordinary/ordinary-run-model-settings.js";
import { PanelHttpError } from "./http-utils.js";
import type { PanelRunInput } from "./request-parsers.js";

export type OrdinaryRunBirthHost = {
  readonly configCenter: ConfigCenter;
  readonly capabilityCenter: CapabilityCenter;
  readonly ordinaryAgentDefinition: AgentDefinition;
  readonly agentDefinitionOverrides: Map<string, AgentDefinition>;
  readonly collaborationRulesApplication: CollaborationRulesApplication;
  readonly ordinaryAgentFeature: OrdinaryAgentFeature;
  readonly spaceFeature: SpaceFeature;
  readonly spaceConversationDeletion: SpaceConversationDeletionCoordinator;
  /** 每次 run birth 的活动钩子：用于重启缺口的异步补整理，不得阻塞或抛出。 */
  readonly onRunBirthActivity?: (input: { readonly conversationId?: string; readonly owner: ConversationOwner }) => void;
  readonly productPaths: ProductPaths;
};

export function reconstructFrozenOrdinaryDefinition(
  base: AgentDefinition,
  ref: OrdinaryRunBirth["agentDefinitionRef"],
  instructions: string,
): AgentDefinition | undefined {
  const candidate: AgentDefinition = {
    ...base,
    prompt: { ...base.prompt, promptRef: ref.promptRef, version: ref.promptVersion, systemPrompt: instructions },
  };
  return agentDefinitionRefMatchesDefinition(ref, candidate) ? candidate : undefined;
}

export async function prepareOrdinaryRunBirth(
  runtime: OrdinaryRunBirthHost,
  input: PanelRunInput,
  conversationId?: string,
): Promise<OrdinaryRunBirth> {
  const scope = await resolveConversationExecutionScope(runtime, input, conversationId);
  const informationAccess = await runtime.configCenter.getInformationAccessConfig();
  const [toolConfirmation, baseCapabilitySnapshot, ordinaryAgentPromptConfig] = await Promise.all([
    runtime.configCenter.getToolConfirmationConfig(),
    capabilitySnapshotForRun(runtime, input.modelOverride, scope.cwd, scope.owner, informationAccess),
    runtime.configCenter.getOrdinaryAgentPromptConfig(),
  ]);
  const assembled = ordinaryCapabilitySnapshotForRunStart(baseCapabilitySnapshot, input.reasoningEffort);
  const capabilitySnapshot = { ...assembled, activeModel: runModelConfiguration(assembled.activeModel) };
  const configuredDefinition = ordinaryAgentDefinitionFromPromptConfig(
    runtime.ordinaryAgentDefinition,
    ordinaryAgentPromptConfig,
  );
  const [ownerBlock, collaborationRules] = await Promise.all([
    formatOwnerContext(runtime, scope),
    runtime.collaborationRulesApplication.startupSnapshot(scope.owner),
  ]);
  // 活动钩子：重启遗留的整理缺口在本会话再次活动时异步补做，绝不阻塞 run birth。
  if (conversationId !== undefined) {
    try {
      runtime.onRunBirthActivity?.({ conversationId, owner: scope.owner });
    } catch {
      // 钩子异常不得影响 run 准备。
    }
  }
  const definition = configuredDefinition;
  const agentDefinitionRef = runAgentDefinitionRef(definition);
  runtime.agentDefinitionOverrides.set(runAgentDefinitionRefCacheKey(agentDefinitionRef), definition);
  return {
    instructions: definition.prompt.systemPrompt,
    ...(input.recordToolMetrics === true ? { recordToolMetrics: true } : {}),
    aiMode: input.aiMode ?? capabilitySnapshot.activeModel.defaultAiMode,
    config: capabilitySnapshot.activeModel,
    reasoningEffort: input.reasoningEffort,
    agentDefinitionRef,
    capabilitySnapshot,
    memoryOwner: scope.owner,
    ownerContext: [ownerBlock, formatEnvironmentContext(capabilitySnapshot.commandShell)].join("\n\n"),
    // Keep user-authored rules out of the owner/environment segment. The model
    // assembler places them after resources and before implicit advisory data.
    ...(collaborationRules.injection === undefined ? {} : { collaborationRulesContext: collaborationRules.injection }),
    informationAccess,
    accessPolicy: toolRunAccessPolicyFromPreset(input.toolConfirmationPolicy ?? toolConfirmation.policy),
  };
}

export async function ensureSpaceManagedRoot(managedRoot: string): Promise<void> {
  await fs.mkdir(managedRoot, { recursive: true });
}

async function formatOwnerContext(
  runtime: OrdinaryRunBirthHost,
  scope: { readonly owner: ConversationOwner; readonly cwd: string; readonly managedRoot?: string },
): Promise<string> {
  const space = await runtime.spaceFeature.queries.getTree(scope.owner.id);
  const managedRoot = scope.managedRoot ?? scope.cwd;
  return [
    "[Current conversation owner]",
    "kind=space",
    `name=${space?.space.title ?? scope.owner.id}`,
    `managed_root=${managedRoot}`,
    "The managed_root above is this space's own managed storage and your default working directory. Create new files and deliverables there with the file tools unless the user names another destination.",
    "Referenced external workspaces in this conversation are the user's reference material. Read them as needed, but do not create general outputs or scratch files inside them; modify them only when the user explicitly asks for changes to that project.",
  ].join("\n");
}

function formatEnvironmentContext(
  commandShell: { readonly kind: string; readonly syntax: string } | undefined,
  now = new Date(),
): string {
  return [
    "[Environment]",
    `os=${process.platform} ${os.release()} (${process.arch})`,
    ...(commandShell === undefined ? [] : [`shell=${commandShell.kind} (${commandShell.syntax} syntax)`]),
    `current_time=${formatLocalTimestampWithOffset(now)}`,
  ].join("\n");
}

function formatLocalTimestampWithOffset(date: Date): string {
  const pad = (value: number): string => String(Math.trunc(Math.abs(value))).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offset = `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

async function resolveConversationExecutionScope(
  runtime: OrdinaryRunBirthHost,
  input: PanelRunInput,
  conversationId: string | undefined,
): Promise<{ readonly owner: ConversationOwner; readonly cwd: string; readonly managedRoot?: string }> {
  const requestedOwner = input.owner;
  const canonicalOwner = conversationId === undefined
    ? undefined
    : await runtime.ordinaryAgentFeature.queries.getConversationOwner(conversationId);
  if (requestedOwner !== undefined && canonicalOwner !== undefined &&
    (requestedOwner.kind !== canonicalOwner.kind || requestedOwner.id !== canonicalOwner.id)) {
    throw new Error(`Conversation ${conversationId} owner cannot be changed after creation.`);
  }
  const owner = canonicalOwner ?? requestedOwner;
  if (owner === undefined) throw new Error("Conversation owner is required before run birth.");

  runtime.spaceConversationDeletion.assertAvailable(owner.id);
  if (await runtime.spaceFeature.queries.getTree(owner.id) === undefined) {
    throw new PanelHttpError(404, "space_not_found", `Space ${owner.id} was not found.`);
  }
  const managedRoot = path.join(runtime.productPaths.data.spaces.files, owner.id, "files");
  await ensureSpaceManagedRoot(managedRoot);
  return { owner, cwd: managedRoot, managedRoot };
}

async function modelProviderConfigForRun(
  runtime: OrdinaryRunBirthHost,
  override: PanelRunInput["modelOverride"],
) {
  if (override === undefined) return runtime.configCenter.getModelProviderConfig();
  const profile = (await runtime.configCenter.listModelProviderProfiles())
    .find((item) => item.profileId === override.profileId);
  if (profile === undefined) throw new PanelHttpError(400, "model_profile_not_found", "未找到本次选择的模型服务。");
  if (profile.enabled === false) throw new PanelHttpError(400, "model_profile_disabled", "本次选择的模型服务已停用。");
  return { ...profile, model: override.model };
}

async function capabilitySnapshotForRun(
  runtime: OrdinaryRunBirthHost,
  override: PanelRunInput["modelOverride"],
  executionRoot: string,
  memoryOwner: ConversationOwner,
  informationAccess: import("../../domain/config/index.js").SanitizedInformationAccessConfig,
) {
  const modelProvider = await modelProviderConfigForRun(runtime, override);
  return runtime.capabilityCenter.snapshot({ executionRoot, memoryOwner, informationAccess, modelProvider });
}
