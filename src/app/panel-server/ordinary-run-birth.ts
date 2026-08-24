import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConversationOwner } from "../../domain/execution-scope/index.js";
import { memoryOwnersForConversation } from "../../domain/memory/index.js";
import { createOpenAITokenCounter } from "../context-maintenance/index.js";
import {
  agentDefinitionRefMatchesDefinition,
  runAgentDefinitionRef,
  runAgentDefinitionRefCacheKey,
} from "../agent-definitions/agent-definition-ref.js";
import { ordinaryAgentDefinitionFromPromptConfig } from "../agent-prompts/ordinary-agent-configured-definition.js";
import type { AgentDefinition } from "../agent-prompts/contracts.js";
import type { AgentNotesFeature } from "../agent-notes/index.js";
import type { CapabilityCenter } from "../capability/capability-center.js";
import type { ConfigCenter } from "../config-center/index.js";
import { resolveModelCapabilities } from "../model-runtime/model-capability-registry.js";
import type { OrdinaryAgentFeature, OrdinaryRunBirth } from "../ordinary-agent/index.js";
import {
  PATH_DEPENDENCY_DIRECTORY_MAX_ENTRIES,
  renderPathDependencyDirectory,
  type PathDependencyDirectoryEntry,
  type PathDependencyFeature,
} from "../path-dependencies/index.js";
import type { SpaceFeature } from "../spaces/index.js";
import type { WorkspaceFeature } from "../workspaces/index.js";
import type { ProductPaths } from "../../platform/storage/index.js";
import type { SpaceConversationDeletionCoordinator } from "./spaces/space-conversation-coordinator.js";
import type { WorkspaceDeletionCoordinator } from "./spaces/workspace-deletion-coordinator.js";
import { ordinaryCapabilitySnapshotForRunStart } from "./ordinary/ordinary-run-model-settings.js";
import { PanelHttpError } from "./http-utils.js";
import type { PanelRunInput } from "./request-parsers.js";

export type OrdinaryRunBirthHost = {
  readonly configCenter: ConfigCenter;
  readonly capabilityCenter: CapabilityCenter;
  readonly ordinaryAgentDefinition: AgentDefinition;
  readonly agentDefinitionOverrides: Map<string, AgentDefinition>;
  readonly agentNotesFeature: AgentNotesFeature;
  readonly pathDependencyFeature: PathDependencyFeature;
  readonly ordinaryAgentFeature: OrdinaryAgentFeature;
  readonly spaceFeature: SpaceFeature;
  readonly workspaceFeature: WorkspaceFeature;
  readonly spaceConversationDeletion: SpaceConversationDeletionCoordinator;
  readonly workspaceDeletion: WorkspaceDeletionCoordinator;
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
  const capabilitySnapshot = ordinaryCapabilitySnapshotForRunStart(baseCapabilitySnapshot, input.reasoningEffort);
  const configuredDefinition = ordinaryAgentDefinitionFromPromptConfig(
    runtime.ordinaryAgentDefinition,
    ordinaryAgentPromptConfig,
  );
  const [ownerBlock, noteSnapshot, pathDependencyDirectory] = await Promise.all([
    formatOwnerContext(runtime, scope),
    runtime.agentNotesFeature.queries.startupSnapshot(scope.owner),
    runtime.pathDependencyFeature.queries.directory({
      owners: memoryOwnersForConversation(scope.owner),
      limit: PATH_DEPENDENCY_DIRECTORY_MAX_ENTRIES,
      excerptChars: 240,
    }),
  ]);
  const definition = definitionWithMemoryContext(
    configuredDefinition,
    noteSnapshot.injection,
    pathDependencyDirectory,
    createOpenAITokenCounter(capabilitySnapshot.activeModel.model ?? "gpt-4o").countText,
  );
  const agentDefinitionRef = runAgentDefinitionRef(definition);
  runtime.agentDefinitionOverrides.set(runAgentDefinitionRefCacheKey(agentDefinitionRef), definition);
  return {
    instructions: definition.prompt.systemPrompt,
    aiMode: input.aiMode ?? capabilitySnapshot.activeModel.defaultAiMode,
    config: capabilitySnapshot.activeModel,
    reasoningEffort: input.reasoningEffort,
    agentDefinitionRef,
    capabilitySnapshot,
    agentNoteVersions: noteSnapshot.versions,
    memoryOwner: scope.owner,
    workspaceSelection: "explicit",
    ownerContext: [ownerBlock, formatEnvironmentContext(capabilitySnapshot.commandShell)].join("\n\n"),
    informationAccess,
    toolConfirmationPolicy: input.toolConfirmationPolicy ?? toolConfirmation.policy,
  };
}

export async function ensureSpaceManagedRoot(managedRoot: string): Promise<void> {
  await fs.mkdir(managedRoot, { recursive: true });
}

async function formatOwnerContext(
  runtime: OrdinaryRunBirthHost,
  scope: { readonly owner: ConversationOwner; readonly cwd: string; readonly managedRoot?: string },
): Promise<string> {
  if (scope.owner.kind === "workspace") {
    const workspace = await runtime.workspaceFeature.queries.get(scope.owner.id);
    return [
      "[Current conversation owner]",
      "kind=workspace",
      `name=${workspace?.title ?? scope.owner.id}`,
      `path=${scope.cwd}`,
      "The path above is the user's own project folder and your root working directory. Create and edit files there as the task requires.",
    ].join("\n");
  }
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

  if (owner.kind === "workspace") {
    runtime.workspaceDeletion.assertAvailable(owner.id);
    const workspace = await runtime.workspaceFeature.queries.get(owner.id);
    if (workspace?.status !== "available") {
      if (workspace === undefined) {
        throw new PanelHttpError(404, "workspace_not_found", `工作区 ${owner.id} 不存在。`);
      }
      throw new PanelHttpError(409, "workspace_not_available", `工作区 ${owner.id} 当前不可用。`);
    }
    const mount = workspace.mounts.find((entry) => entry.status === "active");
    if (mount === undefined) throw new Error(`Workspace ${owner.id} has no active mount and cannot host a run.`);
    return { owner, cwd: mount.rootPath };
  }

  runtime.spaceConversationDeletion.assertAvailable(owner.id);
  if (await runtime.spaceFeature.queries.getTree(owner.id) === undefined) {
    throw new PanelHttpError(404, "space_not_found", `Space ${owner.id} was not found.`);
  }
  const managedRoot = path.join(runtime.productPaths.data.spaces.files, owner.id, "files");
  await ensureSpaceManagedRoot(managedRoot);
  return { owner, cwd: managedRoot, managedRoot };
}

function definitionWithMemoryContext(
  definition: AgentDefinition,
  noteInjection: string | undefined,
  pathDependencyDirectory: readonly PathDependencyDirectoryEntry[],
  countMemoryTokens: (text: string) => number,
): AgentDefinition {
  const directoryInjection = renderPathDependencyDirectory(pathDependencyDirectory, countMemoryTokens);
  if (noteInjection === undefined && directoryInjection === undefined) return definition;
  const systemPrompt = [
    definition.prompt.systemPrompt,
    ...(noteInjection === undefined ? [] : ["<agent_notes>", noteInjection, "</agent_notes>"]),
    ...(directoryInjection === undefined
      ? []
      : ["<path_dependency_directory>", directoryInjection, "</path_dependency_directory>"]),
  ].join("\n\n");
  const fingerprint = createHash("sha256").update(systemPrompt, "utf8").digest("hex").slice(0, 12);
  const promptSuffix = noteInjection === undefined ? "path-dependencies" : "agent-notes";
  const versionSuffix = noteInjection === undefined ? "path-dependencies" : "notes";
  return {
    ...definition,
    prompt: {
      ...definition.prompt,
      promptRef: `${definition.prompt.promptRef}:${promptSuffix}`,
      version: `${definition.prompt.version}:${versionSuffix}-${fingerprint}`,
      systemPrompt,
    },
  };
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
  const snapshot = await runtime.capabilityCenter.snapshot({ executionRoot, memoryOwner, informationAccess });
  if (override === undefined) return snapshot;
  const activeModel = await modelProviderConfigForRun(runtime, override);
  const overrides = await runtime.configCenter.listModelCapabilityOverrides();
  return {
    ...snapshot,
    activeModel,
    modelCapabilities: resolveModelCapabilities({ profile: activeModel, overrides }),
  };
}
