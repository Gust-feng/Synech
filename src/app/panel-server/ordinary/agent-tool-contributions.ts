import { createCollaborationRulesTools } from "../../collaboration-rules/index.js";
import type { CollaborationRulesApplication } from "../../application/collaboration-rules-application.js";
import { createSpaceRevocationOverlay, createSpaceToolRegistryContribution, type SpaceFeature, type SpaceRevocationOverlay } from "../../spaces/index.js";
import {
  createPersonalKnowledgeToolRegistryContribution,
  type PersonalKnowledgeFeature,
} from "../../personal-knowledge/index.js";
import type {
  AgentToolProviderFetch,
  AgentToolRegistryContribution,
} from "../../tool-center/factory.js";
import type { HistoryQueryPort } from "../../memory/index.js";
import { createMemoryHistoryToolRegistryContribution } from "../../memory/history/history-tools.js";
import type { ContextAttachmentRunContext } from "../../tool-center/adapters/context-attachment-access.js";
import type { ConversationOwner } from "../../../domain/execution-scope/index.js";
import type { AgentHostRunResources } from "./agent-run-resources.js";
import type { ManagedSpaceFolderApplication } from "../../../domain/managed-space-folder.js";
import type { SpaceReferenceContentApplication } from "../../application/space-reference-content-application.js";
import type { SpaceReferenceLifecycleApplication } from "../../application/space-reference-lifecycle-application.js";

export type HostFeatureAgentToolContributionResolver = (input: {
  readonly workspaceRoot: string;
  readonly runContext?: ContextAttachmentRunContext;
  /** Undefined while CapabilityCenter is building a catalog outside a concrete run. */
  readonly memoryOwner?: ConversationOwner;
  /** Present only for a concrete Ordinary run; never supplied by the model. */
  readonly run?: { readonly runId: string; readonly conversationId: string };
}) => readonly AgentToolRegistryContribution[];

/** Selects feature-owned tool contributions once at the Host composition boundary. */
export function createHostFeatureAgentToolContributionResolver(input: {
  readonly collaborationRules?: () => CollaborationRulesApplication;
  readonly spaces?: Pick<SpaceFeature, "commands" | "queries" | "events">;
  readonly personalKnowledge?: Pick<PersonalKnowledgeFeature, "commands" | "queries">;
  /** search_history / read_history 的查询端口（Memory Feature 经窄端口提供）。 */
  readonly memoryHistory?: { readonly historyQueryPort: HistoryQueryPort };
  readonly revocationOverlay?: SpaceRevocationOverlay;
  readonly spaceReferenceContentApplication: () => SpaceReferenceContentApplication;
  readonly spaceReferenceLifecycleApplication: () => SpaceReferenceLifecycleApplication;
  readonly deleteSpace?: (spaceId: string) => Promise<void>;
  readonly deleteConversation?: (conversationId: string) => Promise<void>;
  /** Shared application command for software-managed Space folders. */
  readonly managedSpaceFolderApplication?: () => ManagedSpaceFolderApplication<import("../../spaces/index.js").SpaceReferenceItem> | undefined;
  readonly attachWorkspaceDirectory?: (input: {
    readonly spaceId: string;
    readonly path: string;
    readonly title: string;
    readonly actor: import("../../spaces/index.js").SpaceReferenceActorRecord;
    readonly annotation?: import("../../spaces/index.js").SpaceReferenceAnnotationInput;
  }) => Promise<import("../../spaces/index.js").SpaceReferenceItem>;
  readonly resolveWorkspaceDirectory?: (workspaceId: string) => Promise<{
    readonly path: string;
    readonly sourceIdentity: string;
    readonly mountVersion: string;
  } | undefined>;
}): HostFeatureAgentToolContributionResolver {
  // Shared across runs on purpose: a revocation is permanent, since re-adding a
  // reference mints a new id rather than reviving the revoked one.
  const revocationOverlay = input.revocationOverlay ?? (input.spaces === undefined
    ? undefined
    : createSpaceRevocationOverlay(input.spaces.events));
  return ({ workspaceRoot, runContext, memoryOwner }) => {
    const managedSpaceFolderApplication = input.managedSpaceFolderApplication?.();
    return [
    ...(input.collaborationRules === undefined
      ? []
      : [(register: Parameters<AgentToolRegistryContribution>[0]) => {
          for (const executor of createCollaborationRulesTools({
            application: {
              get: (scope) => input.collaborationRules!().get(scope),
              write: (command) => input.collaborationRules!().write(command),
            },
            owner: memoryOwner,
          })) {
            register({ executor, scopes: ["agent-basic"], enabledByDefault: true });
          }
        }]),
    ...(input.memoryHistory === undefined
      ? []
      : [createMemoryHistoryToolRegistryContribution({
          historyQueryPort: input.memoryHistory.historyQueryPort,
          owner: memoryOwner,
        })]),
    ...(input.spaces === undefined
      ? []
      : [createSpaceToolRegistryContribution({
          spaces: input.spaces,
          workspaceRoot,
          runContext,
          revocationOverlay,
           spaceReferenceContentApplication: input.spaceReferenceContentApplication(),
           spaceReferenceLifecycleApplication: input.spaceReferenceLifecycleApplication(),
          deleteSpace: input.deleteSpace,
          deleteConversation: input.deleteConversation,
          ...(managedSpaceFolderApplication === undefined ? {} : { managedSpaceFolderApplication }),
          ...(input.attachWorkspaceDirectory === undefined ? {} : { attachWorkspaceDirectory: input.attachWorkspaceDirectory }),
          ...(input.resolveWorkspaceDirectory === undefined ? {} : { resolveWorkspaceDirectory: input.resolveWorkspaceDirectory }),
        })]),
    ...(input.personalKnowledge === undefined
      ? []
      : [createPersonalKnowledgeToolRegistryContribution({ knowledge: input.personalKnowledge })]),
    ];
  };
}

/** Feature contributions selected by the application Host for every Agent run. */
export function createHostAgentToolContributions(input: {
  readonly resources: Pick<AgentHostRunResources, "aiEnvironment" | "workspaceRoot">;
  readonly providerFetch?: AgentToolProviderFetch;
  readonly featureContributions?: readonly AgentToolRegistryContribution[];
}): readonly AgentToolRegistryContribution[] {
  // Feature-owned contributions are already selected by the Host
  // composition root and remain the only entries added at this boundary.
  return input.featureContributions ?? [];
}
