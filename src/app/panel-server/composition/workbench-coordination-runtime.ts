import path from "node:path";

import { createOrdinaryTurnApplication, type OrdinaryTurnApplicationDependencies } from "../../application/ordinary-turn-application.js";
import {
  createManagedSpaceFolderApplication,
} from "../../application/managed-space-folder-application.js";
import type { ManagedSpaceFolderApplication } from "../../../domain/managed-space-folder.js";
import type { ProductPaths } from "../../../platform/storage/index.js";
import type { AgentNotesFeature } from "../../agent-notes/index.js";
import type { OrdinaryAgentFeature } from "../../ordinary-agent/index.js";
import {
  createSpaceConversationDeletionCoordinator,
  createWorkspaceDeletionCoordinator,
  createWorkbenchCoordination,
  type SpaceConversationDeletionCoordinator,
  type WorkbenchCoordination,
  type WorkspaceDeletionCoordinator,
} from "../../workbench-coordination/index.js";
import {
  createConversationLifecycleCoordinator,
  type ConversationLifecycleCoordinator,
} from "../spaces/space-conversation-coordinator.js";
import type {
  ConversationLifecycleJournal,
} from "../spaces/conversation-lifecycle-journal.js";
import type {
  SpaceConversationDeletionJournal,
} from "../spaces/space-conversation-deletion-journal.js";
import { deletionLifecycleLockKey } from "../spaces/deletion-lifecycle-lock.js";
import type { PersonalKnowledgeFeature } from "../../personal-knowledge/index.js";
import type { PathDependencyFeature } from "../../path-dependencies/index.js";
import type { SpaceFeature } from "../../spaces/index.js";
import type { WorkspaceFeature } from "../../workspaces/index.js";
import type { InMemoryProcessRegistry, ProcessTerminator } from "../../runtime-guard/index.js";
import type { LocalWorkspaceMutationCoordinator } from "../../tool-center/adapters/local-workspace-mutation-coordinator.js";
import type { SpaceExternalSourceSnapshot } from "../../spaces/index.js";

export type ApplicationRuntime = {
  readonly conversationLifecycle: ConversationLifecycleCoordinator;
  readonly spaceConversationDeletion: SpaceConversationDeletionCoordinator;
  readonly workspaceDeletion: WorkspaceDeletionCoordinator;
  readonly workbenchCoordination: WorkbenchCoordination;
  readonly ordinaryTurnApplication: ReturnType<typeof createOrdinaryTurnApplication>;
  readonly managedSpaceFolderApplication: ManagedSpaceFolderApplication<import("../../spaces/index.js").SpaceReferenceItem>;
};

/**
 * Composition-only wiring for owner lifecycle and Workbench coordination.
 * The builder owns no policy: all deletion and admission semantics remain in
 * app/workbench-coordination and the Conversation lifecycle coordinator.
 */
export function createApplicationRuntime(input: {
  readonly productPaths: ProductPaths;
  readonly inspectDirectory: (rootPath: string) => Promise<SpaceExternalSourceSnapshot | undefined>;
  readonly spaceFeature: Pick<SpaceFeature, "commands" | "queries">;
  readonly workspaceFeature: Pick<WorkspaceFeature, "commands" | "queries">;
  readonly ordinaryAgentFeature: Pick<OrdinaryAgentFeature, "commands" | "queries">;
  readonly personalKnowledgeFeature: Pick<PersonalKnowledgeFeature, "commands">;
  readonly agentNotesFeature: Pick<AgentNotesFeature, "commands">;
  readonly pathDependencyFeature: Pick<PathDependencyFeature, "commands">;
  readonly processRegistry: Pick<InMemoryProcessRegistry, "cleanupBySpace" | "cleanupByConversation">;
  readonly processTerminator: ProcessTerminator;
  readonly fileMutationCoordinator: Pick<LocalWorkspaceMutationCoordinator, "runExclusive">;
  readonly managedSpaceFolderRoot: string;
  readonly spaceConversationDeletionJournal: SpaceConversationDeletionJournal;
  readonly conversationLifecycleJournal: ConversationLifecycleJournal;
  readonly resolveSpaceAccess: OrdinaryTurnApplicationDependencies["resolveSpaceAccess"];
  readonly prepareOrdinaryRunBirth: OrdinaryTurnApplicationDependencies["prepareOrdinaryRunBirth"];
}): ApplicationRuntime {
  const deletionLockKey = deletionLifecycleLockKey(input.productPaths.state.locks);
  const runDeletionExclusive = async <T>(operation: () => Promise<T>): Promise<T> =>
    await input.fileMutationCoordinator.runExclusive(deletionLockKey, operation);

  const spaceConversationDeletion = createSpaceConversationDeletionCoordinator({
    spaces: input.spaceFeature,
    ordinary: input.ordinaryAgentFeature,
    personalKnowledge: input.personalKnowledgeFeature,
    agentNotes: input.agentNotesFeature.commands,
    memory: input.pathDependencyFeature.commands,
    processes: input.processRegistry,
    processTerminator: input.processTerminator,
    journal: input.spaceConversationDeletionJournal,
    runExclusive: runDeletionExclusive,
  });

  const workspaceDeletion = createWorkspaceDeletionCoordinator({
    workspaces: {
      commands: {
        deleteWorkspace: input.workspaceFeature.commands.deleteWorkspace,
        purgeWorkspace: input.workspaceFeature.commands.purgeWorkspace,
      },
      queries: {
        get: input.workspaceFeature.queries.get,
        listAll: input.workspaceFeature.queries.listAll,
      },
    },
    spaces: {
      commands: { unlinkReference: input.spaceFeature.commands.unlinkReference },
      queries: { listReferencesByWorkspace: input.spaceFeature.queries.listReferencesByWorkspace },
    },
    ordinary: {
      commands: { deleteConversation: input.ordinaryAgentFeature.commands.deleteConversation },
      queries: { listConversationsByOwner: input.ordinaryAgentFeature.queries.listConversationsByOwner },
    },
    agentNotes: input.agentNotesFeature.commands,
    memory: input.pathDependencyFeature.commands,
    processes: input.processRegistry,
    processTerminator: input.processTerminator,
    runExclusive: runDeletionExclusive,
    runWorkspaceExclusive: async (workspaceId, operation) => {
      const workspace = await input.workspaceFeature.queries.get(workspaceId);
      const rootPath = workspace?.currentMount?.rootPath;
      return rootPath === undefined
        ? await operation()
        : await input.fileMutationCoordinator.runExclusive(rootPath, operation);
    },
  });

  const conversationLifecycle = createConversationLifecycleCoordinator({
    ordinary: input.ordinaryAgentFeature,
    workspaces: { queries: input.workspaceFeature.queries },
    workspaceAdmission: (workspaceId, operation) => workspaceDeletion.admit(workspaceId, operation),
    spaceAdmission: (spaceId, operation) => spaceConversationDeletion.admit(spaceId, operation),
    processes: input.processRegistry,
    processTerminator: input.processTerminator,
    journal: input.conversationLifecycleJournal,
    runExclusive: runDeletionExclusive,
  });

  const ordinaryTurnApplication = createOrdinaryTurnApplication({
    ordinaryAgentFeature: input.ordinaryAgentFeature,
    conversationLifecycle,
    spaceConversationDeletion,
    workspaceDeletion,
    resolveSpaceAccess: input.resolveSpaceAccess,
    prepareOrdinaryRunBirth: input.prepareOrdinaryRunBirth,
  });
  const managedSpaceFolderApplication = createManagedSpaceFolderApplication({
    addReference: input.spaceFeature.commands.addReference,
    spaceConversationDeletion,
    fileMutationCoordinator: {
      run: async (key, operation) => await input.fileMutationCoordinator.runExclusive(key, operation),
    },
    managedSpaceFolderRoot: input.managedSpaceFolderRoot,
  });

  const workbenchCoordination = createWorkbenchCoordination({
    spaces: {
      commands: {
        addReference: input.spaceFeature.commands.addReference,
        unlinkReference: input.spaceFeature.commands.unlinkReference,
      },
      queries: {
        getTree: input.spaceFeature.queries.getTree,
        getReference: input.spaceFeature.queries.getReference,
        listReferencesByWorkspace: input.spaceFeature.queries.listReferencesByWorkspace,
      },
    },
    workspaces: {
      commands: {
        ensureWorkspace: input.workspaceFeature.commands.ensureWorkspace,
        reconnectWorkspace: input.workspaceFeature.commands.reconnectWorkspace,
        setVisibility: input.workspaceFeature.commands.setVisibility,
        discardImplicitWorkspace: input.workspaceFeature.commands.discardImplicitWorkspace,
      },
    },
    inspectDirectory: input.inspectDirectory,
    withSpaceAdmission: (spaceId, operation) => spaceConversationDeletion.admit(spaceId, operation),
    listWorkspaceConversationIds: async (workspaceId) =>
      (await input.ordinaryAgentFeature.queries.listConversationsByOwner({ kind: "workspace", id: workspaceId }))
        .map((conversation) => conversation.conversationId),
    withWorkspaceAdmission: (workspaceId, operation) => workspaceDeletion.admit(workspaceId, operation),
    withWorkspacePathLease: async (workspaceId, operation) => {
      const workspace = await input.workspaceFeature.queries.get(workspaceId);
      const rootPath = workspace?.currentMount?.rootPath;
      return rootPath === undefined
        ? await operation()
        : await input.fileMutationCoordinator.runExclusive(rootPath, operation);
    },
    withWorkspaceMountTransitionLease: async (workspaceId, candidateRootPath, operation) => {
      const workspace = await input.workspaceFeature.queries.get(workspaceId);
      const currentRoot = workspace?.currentMount?.rootPath;
      return await runWithPathLeases(
        input.fileMutationCoordinator,
        currentRoot === undefined ? [candidateRootPath] : [currentRoot, candidateRootPath],
        operation,
      );
    },
    deleteWorkspace: (workspaceId) => workspaceDeletion.deleteWorkspace(workspaceId),
    deleteSpace: (spaceId, detachKnowledgeFromSpace) =>
      spaceConversationDeletion.deleteSpace(spaceId, detachKnowledgeFromSpace),
    detachKnowledgeFromSpace: (detachInput) => input.personalKnowledgeFeature.commands.cleanupSpace(detachInput),
  });

  return {
    conversationLifecycle,
    spaceConversationDeletion,
    workspaceDeletion,
    workbenchCoordination,
    ordinaryTurnApplication,
    managedSpaceFolderApplication,
  };
}

async function runWithPathLeases<T>(
  coordinator: Pick<LocalWorkspaceMutationCoordinator, "runExclusive">,
  paths: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Map(paths.map((value) => {
    const resolved = path.normalize(path.resolve(value));
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    return [key, resolved] as const;
  })).values()].sort((left, right) => left.localeCompare(right));
  const acquire = async (index: number): Promise<T> => index >= ordered.length
    ? await operation()
    : await coordinator.runExclusive(ordered[index]!, async () => await acquire(index + 1));
  return await acquire(0);
}
