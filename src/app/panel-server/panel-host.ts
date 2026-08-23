import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ConversationOwner } from "../../domain/execution-scope/index.js";
import { memoryOwnersForConversation } from "../../domain/memory/index.js";
import {
  FileSystemAgentSessionRepository,
} from "../../adapters/intelligence/index.js";
import {
  FileSystemToolOutputStore,
  SqliteRuntimeDatabase,
} from "../../adapters/runtime-storage/index.js";
import type { ProductPaths } from "../../platform/storage/index.js";
import { createOpenAITokenCounter } from "../context-maintenance/index.js";
import { createRuntimeAgentDefinitionCatalog } from "../agent-definitions/agent-definition-catalog.js";
import { agentDefinitionRefMatchesDefinition, runAgentDefinitionRefCacheKey } from "../agent-definitions/agent-definition-ref.js";
import type { AgentDefinitionRegistry } from "../agent-definitions/agent-definition-registry.js";
import { runAgentDefinitionRef } from "../agent-definitions/agent-definition-ref.js";
import { ordinaryAgentDefinitionFromPromptConfig } from "../agent-prompts/ordinary-agent-configured-definition.js";
import type { AgentDefinition } from "../agent-prompts/contracts.js";
import { CapabilityCenter } from "../capability/capability-center.js";
import {
  captureKnowledgeAsset,
  managedKnowledgeDocumentTarget,
  readManagedKnowledgeAsset,
  reconcileKnowledgeAssets,
  removeKnowledgeAsset,
  stageKnowledgeAssetRemoval,
} from "./knowledge-asset-store.js";
import { updateLocalDocumentText } from "./local-document-preview.js";
import { ConfigCenter, createLocalConfigCenter } from "../config-center/index.js";
import { resolveModelCapabilities } from "../model-runtime/model-capability-registry.js";
import {
  createFileSystemOrdinaryConversationControlRepository,
} from "../ordinary-agent/conversation-control-repository.js";
import { createFileSystemOrdinaryRunRepository } from "../ordinary-agent/file-system-repository.js";
import {
  createOrdinaryAgentLoopExecutionPort,
} from "../ordinary-agent/agent-loop-execution.js";
import {
  createOrdinaryAgentFeature,
  createFileSystemOrdinaryMemoryFactRepository,
  createFileSystemOrdinaryManagedAttachmentRepository,
  OrdinaryManagedAttachmentRepositoryError,
  type OrdinaryAgentFeature,
  type OrdinaryRunBirth,
} from "../ordinary-agent/index.js";
import {
  createAgentNotesFeature,
  createFileSystemAgentNoteRepository,
  type AgentNotesFeature,
} from "../agent-notes/index.js";
import {
  createFileSystemPathDependencyRepository,
  createPathDependencyFeature,
  PATH_DEPENDENCY_DIRECTORY_MAX_ENTRIES,
  renderPathDependencyDirectory,
  type PathDependencyDirectoryEntry,
  type PathDependencyFeature,
} from "../path-dependencies/index.js";
import {
  canonicalSpacePathIdentity,
  createSpaceRunPathAuthorization,
  createSpaceRevocationOverlay,
  createFileSystemSpaceReferenceDeletionJournal,
  createSqliteSpaceRepository,
  createSpaceFeature,
  hasSpaceOwnerScope,
  inspectSpaceExternalSource,
  inspectFileSystemSpaceReferenceDeletionJournal,
  spaceReferenceIdFromAttachmentId,
  spaceExternalReferenceStatus,
  type SpaceEvent,
  type SpaceFeature,
} from "../spaces/index.js";
import {
  createPersonalKnowledgeFeature,
  createSqlitePersonalKnowledgeRepository,
  PersonalKnowledgeError,
  type PersonalKnowledgeEvent,
  type PersonalKnowledgeFeature,
} from "../personal-knowledge/index.js";
import {
  createSqliteWorkspaceRepository,
  createWorkspaceFeature,
  type WorkspaceFeature,
} from "../workspaces/index.js";
import { createWorkspaceDeletionCoordinator, type WorkspaceDeletionCoordinator } from "./workspace-deletion-coordinator.js";
import {
  applyPendingSynechRestore,
  createSynechDataMaintenance,
  hasUnappliedPendingSynechRestore,
  SynechDataMaintenanceError,
  type SynechDataMaintenance,
} from "./synech-data-maintenance.js";
import { createSpaceReferenceDeletionFilePort } from "./space-reference-deletion.js";
import { synechDeletionLifecycleLockKey } from "./synech-deletion-lifecycle-lock.js";
import {
  createOrdinaryConversationTitleGenerator,
} from "./ordinary-conversation-title.js";
import {
  createPlatformProcessTerminator,
  InMemoryProcessRegistry,
  processCleanupHasUnresolvedStops,
  type ProcessRegistryCleanupResult,
  type ProcessTerminator,
} from "../runtime-guard/index.js";
import {
  FileSystemSkillStateStore,
  resolveSkillStateStorePath,
  type SkillRootInput,
  type SkillStateStore,
} from "../skills/index.js";
import type { SubAgentRootInput } from "../sub-agents/sub-agent-loader.js";
import type { ToolOutputStore } from "../tool-center/tool-output-store.js";
import type {
  PanelContextAttachmentMediaEntry,
  PanelContextAttachmentSelection,
  PanelExternalResourceTarget,
  PanelModelCatalogFetch,
  PanelProviderFetch,
  PanelServerOptions,
} from "./types.js";
import { ordinaryCapabilitySnapshotForRunStart } from "./ordinary-run-model-settings.js";
import { PanelHttpError } from "./http-utils.js";
import { createOrdinaryAgentRunResourceAcquirer } from "./ordinary-agent-run-resources.js";
import { createHostFeatureAgentToolContributionResolver } from "./agent-tool-contributions.js";
import { resolveTriggeredSkillContexts } from "./skill-service.js";
import type { PanelRunInput } from "./request-parsers.js";
import { InMemoryLocalWorkspaceMutationCoordinator } from "../tool-center/adapters/local-workspace-mutation-coordinator.js";
import type { LocalWorkspaceMutationCoordinator } from "../tool-center/adapters/local-workspace-mutation-coordinator.js";
import { createInitialSynechDataInitializer, initializeInitialSynechData } from "./initial-synech-data.js";
import {
  createSqliteManagedAssetRepository,
  createManagedAssetsFeature,
  type ManagedAssetRepository,
  type ManagedAssetsFeature,
} from "../managed-assets/index.js";
import {
  createSynechProjectionChangeFeed,
  type SynechProjectionChangeFeed,
  type SynechProjectionChangeInput,
} from "./synech-projection-change-feed.js";
import {
  createSpaceConversationDeletionCoordinator,
  type SpaceConversationDeletionCoordinator,
  createConversationLifecycleCoordinator,
  type ConversationLifecycleCoordinator,
} from "./space-conversation-coordinator.js";
import { createSqliteSpaceConversationDeletionJournal } from "./space-conversation-deletion-journal.js";
import { createSqliteConversationLifecycleJournal } from "./conversation-lifecycle-journal.js";

/**
 * The sole process-lifetime composition root for the local Panel host. Route
 * adapters receive projected dependencies from request-handler.ts and must not
 * use this object as a service bag.
 */
export type PanelHost = {
  /** True once server shutdown starts; terminal callbacks must not admit new work. */
  isQuiescing: boolean;
  readonly configCenter: ConfigCenter;
  readonly capabilityCenter: CapabilityCenter;
  readonly ordinaryAgentDefinition: AgentDefinition;
  readonly agentDefinitions: AgentDefinitionRegistry;
  readonly agentDefinitionOverrides: Map<string, AgentDefinition>;
  readonly configDirectory: string;
  readonly providerFetch?: PanelProviderFetch;
  readonly modelCatalogFetch?: PanelModelCatalogFetch;
  readonly directoryPicker?: () => Promise<string | undefined>;
  readonly contextAttachmentPicker?: () => Promise<PanelContextAttachmentSelection | undefined>;
  readonly externalResourceOpener?: (target: PanelExternalResourceTarget) => Promise<void>;
  readonly contextAttachmentMedia: Map<string, PanelContextAttachmentMediaEntry>;
  readonly activeRequestJobs: Set<Promise<void>>;
  readonly productPaths: ProductPaths;
  readonly processRegistry: InMemoryProcessRegistry;
  readonly processTerminator: ProcessTerminator;
  readonly skillRoots: readonly SkillRootInput[];
  readonly subAgentRoots: readonly SubAgentRootInput[];
  readonly skillStateStore?: SkillStateStore;
  readonly ordinaryAgentFeature: OrdinaryAgentFeature;
  readonly resolveManagedAttachmentPath: (attachmentId: string) => Promise<string | undefined>;
  readonly agentNotesFeature: AgentNotesFeature;
  readonly pathDependencyFeature: PathDependencyFeature;
  readonly spaceFeature: SpaceFeature;
  readonly workspaceFeature: WorkspaceFeature;
  readonly conversationLifecycle: ConversationLifecycleCoordinator;
  readonly spaceConversationDeletion: SpaceConversationDeletionCoordinator;
  readonly workspaceDeletion: WorkspaceDeletionCoordinator;
  readonly personalKnowledgeFeature: PersonalKnowledgeFeature<import("../panel-api-contracts.js").DocumentPreview>;
  readonly synechDataMaintenance: SynechDataMaintenance;
  readonly prepareOrdinaryRunBirth: (input: PanelRunInput, conversationId?: string) => Promise<OrdinaryRunBirth>;
  readonly toolOutputStore: ToolOutputStore;
  readonly synechDatabase: SqliteRuntimeDatabase;
  readonly managedAssets: ManagedAssetRepository;
  readonly managedAssetFeature: ManagedAssetsFeature;
  readonly fileMutationCoordinator: LocalWorkspaceMutationCoordinator;
  readonly synechProjectionChanges: SynechProjectionChangeFeed;
  readonly releaseSynechProjectionChanges: () => void;
  readonly knowledgeAssetRoot?: string;
  /** Host-owned root for physical directories created from Space. */
  readonly managedSpaceFolderRoot: string;
  readonly knowledgeAssetsReady: Promise<void>;
  readonly ensureInitialSynechData: () => Promise<void>;
  readonly flushSpaceKnowledgeSync: () => Promise<void>;
  readonly flushSpaceProcessCleanup: () => Promise<void>;
  readonly releaseAgentSessionStorage: () => Promise<void>;
  readonly resolveSubAgentRoots?: (input: PanelSubAgentRootsInput) => readonly SubAgentRootInput[];
};

type PanelSkillRootsInput = {
  readonly executionRoot?: string;
};

type PanelSubAgentRootsInput = {
  readonly executionRoot?: string;
};

export type PanelHostOptions = Omit<PanelServerOptions, "host" | "port" | "productHome" | "productPaths"> & {
  readonly productPaths: ProductPaths;
};

export function createPanelHost(options: PanelHostOptions): PanelHost {
  const agentDefinitionCatalog = createRuntimeAgentDefinitionCatalog({
    ordinaryAgentDefinition: options.ordinaryAgentDefinition,
    additionalDefinitions: options.agentDefinitions,
  });
  if (options.configCenter !== undefined) {
    return assemblePanelHost({
      configCenter: options.configCenter,
      ordinaryAgentDefinition: agentDefinitionCatalog.ordinaryAgentDefinition,
      agentDefinitions: agentDefinitionCatalog.registry,
      configDirectory: options.productPaths.configDirectory,
      providerFetch: options.providerFetch,
      modelCatalogFetch: options.modelCatalogFetch,
      directoryPicker: options.directoryPicker,
      contextAttachmentPicker: options.contextAttachmentPicker,
      synechRestorePicker: options.synechRestorePicker,
      externalResourceOpener: options.externalResourceOpener,
      skillRoots: resolveSkillRoots(options),
      resolveSkillRoots: (input) => resolveSkillRoots(options, input),
      subAgentRoots: resolveSubAgentRoots(options),
      resolveSubAgentRoots: (input) => resolveSubAgentRoots(options, input),
      skillStateStore: resolveSkillStateStore(options.productPaths.configDirectory),
      processTerminator: options.processTerminator,
      productPaths: options.productPaths,
    });
  }
  const local = createLocalConfigCenter({ configDirectory: options.productPaths.configDirectory });
  return assemblePanelHost({
    configCenter: local.configCenter,
    ordinaryAgentDefinition: agentDefinitionCatalog.ordinaryAgentDefinition,
    agentDefinitions: agentDefinitionCatalog.registry,
    configDirectory: local.configDirectory,
    providerFetch: options.providerFetch,
    modelCatalogFetch: options.modelCatalogFetch,
    directoryPicker: options.directoryPicker,
    contextAttachmentPicker: options.contextAttachmentPicker,
    synechRestorePicker: options.synechRestorePicker,
    externalResourceOpener: options.externalResourceOpener,
    skillRoots: resolveSkillRoots(options),
    resolveSkillRoots: (input) => resolveSkillRoots(options, input),
    subAgentRoots: resolveSubAgentRoots(options),
    resolveSubAgentRoots: (input) => resolveSubAgentRoots(options, input),
    skillStateStore: resolveSkillStateStore(local.configDirectory),
    processTerminator: options.processTerminator,
    productPaths: options.productPaths,
  });
}

export async function preparePanelHostStorageForStartup(productPaths: ProductPaths): Promise<void> {
  const journalRoot = path.join(productPaths.state.journals, "space-reference-deletions");
  if (!hasUnappliedPendingSynechRestore(productPaths) ||
    inspectFileSystemSpaceReferenceDeletionJournal(journalRoot) === "idle") return;

  const databasePath = productPaths.data.database;
  try {
    await fs.access(databasePath);
  } catch (error) {
    throw new SynechDataMaintenanceError(
      "data_maintenance_failed",
      "应用恢复前无法读取保存 Space 删除身份的当前数据库；恢复未修改任何数据。",
      { cause: error },
    );
  }
  const database = new SqliteRuntimeDatabase(databasePath);
  let spaceFeature: SpaceFeature | undefined;
  let startupError: unknown;
  try {
    const managedAssets = createSqliteManagedAssetRepository(database);
    spaceFeature = createSpaceFeature({
      repository: createSqliteSpaceRepository(database),
      ownedAssetDeletion: {
        deleteManagedAssets: async (assetIds) => await managedAssets.removeMany(assetIds),
      },
      referenceDeletion: {
        journal: createFileSystemSpaceReferenceDeletionJournal(journalRoot),
        files: createSpaceReferenceDeletionFilePort(path.join(productPaths.data.workbench.spaceFiles, "folders")),
        leases: new InMemoryLocalWorkspaceMutationCoordinator(),
        deleteOwnedAssets: async (assetIds) => await managedAssets.removeMany(assetIds),
      },
    });
    await spaceFeature.ready();
  } catch (error) {
    startupError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (spaceFeature !== undefined) {
    try { await spaceFeature.release(); } catch (error) { cleanupErrors.push(error); }
  }
  try { database.close(); } catch (error) { cleanupErrors.push(error); }
  if (startupError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [startupError, ...cleanupErrors],
        "Space deletion recovery before Synech restore and cleanup both failed.",
      );
    }
    throw startupError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Space deletion recovery cleanup before Synech restore failed.");
  }
}

function assemblePanelHost(input: {
  readonly configCenter: ConfigCenter;
  readonly ordinaryAgentDefinition: AgentDefinition;
  readonly agentDefinitions: AgentDefinitionRegistry;
  readonly configDirectory: string;
  readonly providerFetch?: PanelProviderFetch;
  readonly modelCatalogFetch?: PanelModelCatalogFetch;
  readonly directoryPicker?: () => Promise<string | undefined>;
  readonly contextAttachmentPicker?: () => Promise<PanelContextAttachmentSelection | undefined>;
  readonly synechRestorePicker?: () => Promise<string | undefined>;
  readonly externalResourceOpener?: (target: PanelExternalResourceTarget) => Promise<void>;
  readonly productPaths: ProductPaths;
  readonly skillRoots: readonly SkillRootInput[];
  readonly resolveSkillRoots?: (input: PanelSkillRootsInput) => readonly SkillRootInput[];
  readonly subAgentRoots: readonly SubAgentRootInput[];
  readonly resolveSubAgentRoots?: (input: PanelSubAgentRootsInput) => readonly SubAgentRootInput[];
  readonly skillStateStore?: SkillStateStore;
  readonly processTerminator?: ProcessTerminator;
}): PanelHost {
  const activeRequestJobs = new Set<Promise<void>>();
  const contextAttachmentMedia = new Map<string, PanelContextAttachmentMediaEntry>();
  const agentDefinitionOverrides = new Map<string, AgentDefinition>();
  const processRegistry = new InMemoryProcessRegistry();
  const fileMutationCoordinator = new InMemoryLocalWorkspaceMutationCoordinator();
  const synechProjectionChanges = createSynechProjectionChangeFeed();
  const productPaths = input.productPaths;
  const toolOutputStore = new FileSystemToolOutputStore(productPaths.data.agent.evidence);
  const processTerminator = input.processTerminator ?? createPlatformProcessTerminator();
  const productHome = productPaths.productHome;
  const knowledgeAssetRoot = productPaths.data.workbench.knowledgeAssets;
  const managedSpaceFolderRoot = path.join(productPaths.data.workbench.spaceFiles, "folders");
  const managedSpaceRoot = productPaths.data.workbench.spaceFiles;
  let knowledgeAssetsReady = Promise.resolve();
  applyPendingSynechRestore(productPaths, {
    assertSpaceDeletionIdle: () => assertSpaceDeletionJournalIdle(productPaths),
  });
  const {
    database: synechDatabase,
    managedAssets,
    spaceRepository,
    personalKnowledgeRepository,
  } = openPanelSynechStorage(productPaths);
  const managedAssetFeature = createManagedAssetsFeature(managedAssets);
  const spaceConversationDeletionJournal = createSqliteSpaceConversationDeletionJournal(synechDatabase);
  const conversationLifecycleJournal = createSqliteConversationLifecycleJournal(synechDatabase);
  let beforeSynechRestoreStage: (() => Promise<void>) | undefined;
  const synechDataMaintenance = createSynechDataMaintenance({
    database: synechDatabase,
    productPaths,
    restorePicker: input.synechRestorePicker,
    beforeRestoreStage: async () => {
      if (beforeSynechRestoreStage === undefined) {
        throw new Error("Panel runtime restore preparation is not initialized.");
      }
      await beforeSynechRestoreStage();
    },
    runOwnedStorageSnapshot: async (operation) => {
      await knowledgeAssetsReady;
      return await fileMutationCoordinator.runExclusive(productHome, async () => {
        if ((await spaceReferenceDeletionJournal.list()).length > 0) {
          throw new Error("Synech storage cannot be snapshotted while a Space deletion journal is pending.");
        }
        if ((await spaceConversationDeletionJournal.list()).length > 0) {
          throw new Error("Synech storage cannot be snapshotted while a Space deletion lifecycle is pending.");
        }
        if ((await conversationLifecycleJournal.list()).length > 0) {
          throw new Error("Synech storage cannot be snapshotted while a Conversation lifecycle is pending.");
        }
        return await operation();
      });
    },
  });
  const spaceReferenceDeletionJournal = createFileSystemSpaceReferenceDeletionJournal(
    path.join(productPaths.state.journals, "space-reference-deletions"),
  );
  const agentDataRoot = productPaths.data.agent.root;
  const managedAttachmentInstanceId = randomUUID();
  const managedAttachmentRepository = createFileSystemOrdinaryManagedAttachmentRepository(
    productPaths.data.agent.attachments,
  );
  const resolveManagedAttachmentPath = async (attachmentId: string): Promise<string | undefined> => {
    try {
      return await managedAttachmentRepository.resolveContentPath(attachmentId);
    } catch (error) {
      if (error instanceof OrdinaryManagedAttachmentRepositoryError &&
        error.code === "ordinary_managed_attachment_not_found") return undefined;
      throw error;
    }
  };
  const agentNotesFeature = createAgentNotesFeature({
    repository: createFileSystemAgentNoteRepository(productPaths.data.workbench.notes),
  });
  // Path dependencies are durable methodology memories. They deliberately
  // live beside, rather than inside, Ordinary run snapshots: Ordinary owns
  // the run-bound read/adoption facts, while this feature owns the reusable
  // content and its revision history.
  const pathDependencyFeature = createPathDependencyFeature({
    repository: createFileSystemPathDependencyRepository(productPaths.data.workbench.methodMemory),
  });
  const ordinaryMemoryFactRepository = createFileSystemOrdinaryMemoryFactRepository(
    agentDataRoot,
  );
  const spaceFeature = createSpaceFeature({
    repository: spaceRepository,
    workspaceMountIdentity: canonicalWorkspaceMountIdentity,
    externalSourceInspector: inspectSpaceExternalSource,
    ownedAssetDeletion: {
      deleteManagedAssets: async (assetIds) => await managedAssets.removeMany(assetIds),
    },
    referenceDeletion: {
      journal: spaceReferenceDeletionJournal,
      files: createSpaceReferenceDeletionFilePort(managedSpaceFolderRoot),
      leases: fileMutationCoordinator,
      onDiagnostic: (diagnostic) => {
        console.error(
          `[panel-server] Committed Space deletion ${diagnostic.deletionId} cleanup reported a failure; any retained journal state will be reconciled on the next startup`,
          diagnostic.error,
        );
      },
      deleteOwnedAssets: async (assetIds) => await managedAssets.removeMany(assetIds),
    },
  });
  const unlinkSpaceExternalReference = async (referenceId: string): Promise<void> => {
    try {
      await spaceFeature.commands.unlinkReference(referenceId);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "space_reference_not_found")) throw error;
    }
  };
  const workspaceFeature: WorkspaceFeature = createWorkspaceFeature({
    repository: createSqliteWorkspaceRepository(synechDatabase),
  });
  const personalKnowledgeFeature = createPersonalKnowledgeFeature({
    repository: personalKnowledgeRepository,
    spaceExists: async (spaceId) => await spaceFeature.queries.getTree(spaceId) !== undefined,
    runManagedAssetMutation: async (operation) => {
      await knowledgeAssetsReady;
      return await fileMutationCoordinator.runExclusive(knowledgeAssetRoot, operation);
    },
    captureSpaceReference: async ({ assetId, referenceId, relativePath }) => {
      const item = await spaceFeature.queries.getReference(referenceId);
      if (item === undefined) return undefined;
      if (await spaceExternalReferenceStatus(item) !== "current") {
        await unlinkSpaceExternalReference(referenceId);
        return undefined;
      }
      const asset = await captureKnowledgeAsset(knowledgeAssetRoot, assetId, item, relativePath);
      if (await spaceExternalReferenceStatus(item) === "current") return asset;
      await removeKnowledgeAsset(knowledgeAssetRoot, assetId);
      await unlinkSpaceExternalReference(referenceId);
      return undefined;
    },
    removeManagedAsset: async (itemId) => await removeKnowledgeAsset(knowledgeAssetRoot, itemId),
    stageManagedAssetRemoval: async (itemId) => await stageKnowledgeAssetRemoval(knowledgeAssetRoot, itemId),
    writeManagedAssetText: async ({ page, relativePath, expectedFingerprint, text }) => {
      await knowledgeAssetsReady;
      const target = managedKnowledgeDocumentTarget(knowledgeAssetRoot, page);
      return await fileMutationCoordinator.runExclusive(target.mutationKey, async () =>
        await updateLocalDocumentText(
          target.rootDir,
          relativePath,
          { expectedFingerprint, text },
          target.meta,
          {
            contentBaseUrl: `/api/personal-knowledge/assets/${encodeURIComponent(page.refId)}/content`,
            contentTypeHintPath: target.contentTypeHintPath(relativePath),
          },
        ).catch((error: unknown) => {
          throw managedKnowledgeAssetWriteError(error);
        }));
    },
    readManagedKnowledgeAsset: async (input) =>
      await readManagedKnowledgeAsset(knowledgeAssetRoot, input.page, input),
  });
  const initialSynechData = createInitialSynechDataInitializer(async () =>
    await initializeInitialSynechData({
      database: synechDatabase,
      spaceFeature,
      personalKnowledgeFeature,
      managedSpaceRoot,
      managedSpaceFolderRoot,
    }),
  );
  knowledgeAssetsReady = personalKnowledgeFeature.queries.snapshot().then(async (snapshot) => {
    await fileMutationCoordinator.runExclusive(knowledgeAssetRoot, async () => await reconcileKnowledgeAssets(
      knowledgeAssetRoot,
      new Set(snapshot.pages.filter((page) => page.asset?.status === "managed").map((page) => page.refId)),
    ));
  });
  // Warm the formal initial dataset after owned storage reconciliation has started.
  void initialSynechData.ensure().catch(() => undefined);
  const spaceKnowledgeSync = Promise.resolve();
  const spaceRevocationOverlay = createSpaceRevocationOverlay(spaceFeature.events);
  const contextAttachmentReadAuthorization = {
    async assertReadAllowed(attachmentId: string): Promise<void> {
      spaceRevocationOverlay.assertReadAllowed(attachmentId);
      const referenceId = spaceReferenceIdFromAttachmentId(attachmentId);
      if (referenceId === undefined) return;
      const item = await spaceFeature.queries.getReference(referenceId);
      if (item === undefined) {
        throw new Error(`Space reference ${referenceId} was removed and is no longer readable.`);
      }
      if (await spaceExternalReferenceStatus(item) === "current") return;
      await unlinkSpaceExternalReference(referenceId);
      throw new Error(`Space reference ${referenceId} no longer points to its original source and was removed.`);
    },
  };
  const activeSpaceProcessCleanups = new Set<Promise<void>>();
  const trackSpaceProcessCleanup = (
    cleanup: Promise<ProcessRegistryCleanupResult>,
    referenceId: string,
  ): void => {
    let tracked: Promise<void>;
    tracked = cleanup.then((result) => {
      if (processCleanupHasUnresolvedStops(result)) {
        console.error(
          `[panel-server] Space reference ${referenceId} was revoked but one or more managed processes remain stop_pending`,
          result.fact,
        );
      }
    }, (error: unknown) => {
      console.error(`[panel-server] Space reference ${referenceId} process cleanup failed`, error);
    }).finally(() => {
      activeSpaceProcessCleanups.delete(tracked);
    });
    activeSpaceProcessCleanups.add(tracked);
  };
  const spaceProcessLifecycleUnsubscribe = spaceFeature.events.subscribe((event) => {
    if (event.type !== "space.reference_removed") return;
    for (const referenceId of event.removedItemIds) {
      // revokeByReference marks matching records before its first await.
      trackSpaceProcessCleanup(
        processRegistry.revokeByReference(referenceId, processTerminator),
        referenceId,
      );
    }
  });
  const resolveFeatureToolContributions = createHostFeatureAgentToolContributionResolver({
    agentNotes: agentNotesFeature,
    pathDependencies: pathDependencyFeature,
    spaces: spaceFeature,
    personalKnowledge: personalKnowledgeFeature,
    revocationOverlay: spaceRevocationOverlay,
    assertSpaceAvailable: (spaceId) => spaceConversationDeletion.assertAvailable(spaceId),
    deleteSpace: (spaceId) => spaceConversationDeletion.deleteSpace(spaceId),
    deleteConversation: (conversationId) => conversationLifecycle.deleteConversation(conversationId),
    managedSpaceFolderRoot,
    fileMutationCoordinator,
  });
  const capabilityCenter = new CapabilityCenter({
    configCenter: input.configCenter,
    skillRoots: input.skillRoots,
    resolveSkillRoots: input.resolveSkillRoots,
    skillStateStore: input.skillStateStore,
    subAgentRoots: input.subAgentRoots,
    resolveSubAgentRoots: input.resolveSubAgentRoots,
    fetch: input.providerFetch,
    toolOutputStore,
    resolveToolContributions: resolveFeatureToolContributions,
  });
  const agentSessionEnvironment = new NodeExecutionEnv({ cwd: agentDataRoot });
  const agentSessionRepository = new FileSystemAgentSessionRepository({
    fileSystem: agentSessionEnvironment,
    sessionsRoot: productPaths.data.agent.sessions,
  });
  const ordinaryRunResources = createOrdinaryAgentRunResourceAcquirer({
    host: {
      configCenter: input.configCenter,
      providerFetch: input.providerFetch,
      processRegistry,
      processTerminator,
      toolOutputStore,
      fileMutationCoordinator,
      resolveManagedAttachmentPath,
      resolveAttachmentToolExposure: ({ permissionBoundaryRefs }) => hasSpaceOwnerScope(permissionBoundaryRefs),
    },
    sessionRepository: agentSessionRepository,
    resolveAgentDefinition: ({ ref, instructions }) =>
      agentDefinitionOverrides.get(runAgentDefinitionRefCacheKey(ref)) ??
      input.agentDefinitions.resolve(ref) ??
      reconstructFrozenOrdinaryDefinition(input.ordinaryAgentDefinition, ref, instructions),
    resolveSkillContexts: (context) => resolveTriggeredSkillContexts(
      { skillRoots: input.skillRoots, skillStateStore: input.skillStateStore, capabilityCenter },
      context.goal,
      context.catalog,
      context.triggerMode === "model"
        ? {
            routingMode: "model",
            intelligenceChannel: context.createIntelligenceChannel(),
            traceId: context.runId,
            callerRef: `skill-router:${context.runId}`,
            abortSignal: context.abortSignal,
          }
        : { routingMode: "keyword", abortSignal: context.abortSignal },
    ),
    resolveFeatureToolContributions,
    resolveMemoryFactSink: ({ runId }) => ({
      recordRead: async (fact) => {
        await ordinaryAgentFeature.commands.recordMemoryRead({ runId, ...fact });
      },
      recordReference: async (fact) =>
        await ordinaryAgentFeature.commands.recordMemoryReference({ runId, ...fact }),
    }),
    contextAttachmentReadAuthorization,
    resolveWorkspacePathAuthorization: ({ runContext, workspaceRoot }) =>
      createSpaceRunPathAuthorization({
        runContext,
        workspaceRoot,
        revocationOverlay: spaceRevocationOverlay,
        onInvalidReference: unlinkSpaceExternalReference,
      }),
    resolveSubAgentRoots: (workspaceRoot) =>
      input.resolveSubAgentRoots?.({ executionRoot: workspaceRoot }) ?? input.subAgentRoots,
  });
  const ordinaryAgentFeature = createOrdinaryAgentFeature({
    repository: createFileSystemOrdinaryRunRepository(agentDataRoot),
    conversationRepository: createFileSystemOrdinaryConversationControlRepository(agentDataRoot),
    sessionRepository: agentSessionRepository,
    releaseToolEvidenceOwner: (ownerId) => toolOutputStore.releaseOwner(ownerId).then(() => undefined),
    managedAttachmentRepository,
    managedAttachmentInstanceId,
    memoryFactRepository: ordinaryMemoryFactRepository,
    onDiagnostic: (diagnostic) => {
      if (diagnostic.kind === "session_finalization_failed") {
        console.error(`[panel-server] Ordinary run ${diagnostic.runId} Session finalization failed; the conversation queue stays paused until a retry succeeds`, diagnostic.error);
      } else if (diagnostic.kind === "conversation_unavailable") {
        console.error(`[panel-server] Ordinary conversation ${diagnostic.conversationId} is unavailable after startup recovery; its data remains on disk for diagnosis`, diagnostic.error);
      } else if (diagnostic.kind === "successor_activation_failed") {
        const activationOwner = diagnostic.predecessorRunId ?? diagnostic.conversationId;
        console.error(`[panel-server] Ordinary successor activation attempt ${diagnostic.consecutiveFailures} failed for ${activationOwner}; retrying in ${diagnostic.retryDelayMs}ms`, diagnostic.error);
      } else if (diagnostic.kind === "cancellation_cleanup_failed") {
        console.error(`[panel-server] Ordinary run ${diagnostic.runId} cancellation cleanup failed during ${diagnostic.phase}; its durable cancelled fact remains authoritative`, diagnostic.error);
      } else if (diagnostic.kind === "conversation_cleanup_failed") {
        const resourceOwner = diagnostic.runId ?? diagnostic.conversationId;
        console.error(`[panel-server] Ordinary conversation ${diagnostic.conversationId} cleanup failed during ${diagnostic.phase} for ${resourceOwner}; the durable state remains available for diagnosis or retry`, diagnostic.error);
      } else if (diagnostic.kind === "managed_attachment_cleanup_failed") {
        console.error(`[panel-server] Ordinary conversation ${diagnostic.conversationId} managed attachment cleanup failed; startup will retry`, diagnostic.error);
      } else if (diagnostic.kind === "managed_attachment_recovery_issue") {
        console.error(`[panel-server] Ordinary managed attachment ${diagnostic.identity ?? "storage"} recovery was isolated`, diagnostic.error);
      } else if (diagnostic.kind === "managed_attachment_claim_rollback_failed") {
        console.error(`[panel-server] Ordinary run ${diagnostic.runId} could not roll back managed attachment claims; the feature will retry and startup reconciliation remains the final fallback`, diagnostic.error);
      } else if (diagnostic.kind === "completion_commit_failed") {
        console.error(`[panel-server] Ordinary run ${diagnostic.runId} completed in Pi but its terminal snapshot could not be committed; the run remains blocked instead of being rewritten as failed`, diagnostic.error);
      } else if (diagnostic.kind === "conversation_title_generation_failed") {
        console.error(`[panel-server] Ordinary conversation ${diagnostic.conversationId} title generation failed; the list keeps the first-message fallback`, diagnostic.error);
      } else {
        console.error(`[panel-server] Ordinary startup recovery could not enumerate ${diagnostic.source}; new live conversations remain available`, diagnostic.error);
      }
    },
    execution: createOrdinaryAgentLoopExecutionPort({
      resources: ordinaryRunResources,
      onReleaseError: (error) => console.error("[panel-server] Ordinary run resource release failed", error),
    }),
    generateConversationTitle: createOrdinaryConversationTitleGenerator({
      configCenter: input.configCenter,
    }),
  });
  // 三个删除 / 链接生命周期协调器共享同一把 sentinel 互斥键：彼此串行、与整仓备份互斥，
  // 但不独占 Product Home 本身，避免盖住 SpaceFeature 引用删除生命周期在同一协调器上申请的
  // Product Home 子目录锁而自死锁（见 synech-deletion-lifecycle-lock.ts）。
  const deletionLifecycleLockKey = synechDeletionLifecycleLockKey(productPaths.state.locks);
  const spaceConversationDeletion = createSpaceConversationDeletionCoordinator({
    spaces: spaceFeature,
    ordinary: ordinaryAgentFeature,
    personalKnowledge: personalKnowledgeFeature,
    agentNotes: agentNotesFeature.commands,
    memory: pathDependencyFeature.commands,
    processes: processRegistry,
    processTerminator,
    journal: spaceConversationDeletionJournal,
    runExclusive: async (operation) => await fileMutationCoordinator.runExclusive(deletionLifecycleLockKey, operation),
  });
  const workspaceDeletion = createWorkspaceDeletionCoordinator({
    workspaces: {
      commands: {
        deleteWorkspace: workspaceFeature.commands.deleteWorkspace,
        purgeWorkspace: workspaceFeature.commands.purgeWorkspace,
        unlinkWorkspaceFromSpace: workspaceFeature.commands.unlinkWorkspaceFromSpace,
      },
      queries: { get: workspaceFeature.queries.get, list: workspaceFeature.queries.list },
    },
    ordinary: {
      commands: { deleteConversation: ordinaryAgentFeature.commands.deleteConversation },
      queries: { listConversationsByOwner: ordinaryAgentFeature.queries.listConversationsByOwner },
    },
    agentNotes: agentNotesFeature.commands,
    memory: pathDependencyFeature.commands,
    processes: processRegistry,
    processTerminator,
    runExclusive: async (operation) => await fileMutationCoordinator.runExclusive(deletionLifecycleLockKey, operation),
  });
  const conversationLifecycle = createConversationLifecycleCoordinator({
    ordinary: ordinaryAgentFeature,
    workspaces: { queries: workspaceFeature.queries },
    workspaceAdmission: (workspaceId, operation) => workspaceDeletion.admit(workspaceId, operation),
    spaceAdmission: (spaceId, operation) => spaceConversationDeletion.admit(spaceId, operation),
    processes: processRegistry,
    processTerminator,
    journal: conversationLifecycleJournal,
    runExclusive: async (operation) => await fileMutationCoordinator.runExclusive(deletionLifecycleLockKey, operation),
  });
  const projectionChangeUnsubscribers = [
    spaceFeature.events.subscribe((event) => {
      synechProjectionChanges.publish(projectionChangeFromSpace(event));
      if (event.type === "space.created") {
        // Each Space owns a managedRoot（ADR-0035 §2.3）。Directory creation is a
        // Host mechanical step: missing roots are recreated lazily by the scope
        // resolver, and failures are diagnostics that never block the Space command.
        void ensureSpaceManagedRoot(path.join(managedSpaceRoot, event.space.id, "files"))
          .catch((error) => console.error(`[panel-server] Could not create managedRoot for Space ${event.space.id}`, error));
      }
    }),
    personalKnowledgeFeature.events.subscribe((event) => {
      synechProjectionChanges.publish(projectionChangeFromPersonalKnowledge(event));
    }),
    fileMutationCoordinator.events.subscribe(() => {
      synechProjectionChanges.publish({ owners: ["mounted_files"] });
    }),
    ordinaryAgentFeature.events.subscribeStableTerminalRuns(() => {
      // A terminal run invalidates only the mounted-file projection. Missing Space sources are
      // reported by the actual preview/tool access and are never discovered by a background scan.
      synechProjectionChanges.publish({ owners: ["mounted_files"] });
    }),
  ];

  let host!: PanelHost;
  host = {
    isQuiescing: false,
    configCenter: input.configCenter,
    capabilityCenter,
    ordinaryAgentDefinition: input.ordinaryAgentDefinition,
    agentDefinitions: input.agentDefinitions,
    agentDefinitionOverrides,
    configDirectory: input.configDirectory,
    providerFetch: input.providerFetch,
    modelCatalogFetch: input.modelCatalogFetch,
    directoryPicker: input.directoryPicker,
    contextAttachmentPicker: input.contextAttachmentPicker,
    externalResourceOpener: input.externalResourceOpener,
    contextAttachmentMedia,
    activeRequestJobs,
    productPaths: input.productPaths,
    processRegistry,
    processTerminator,
    skillRoots: input.skillRoots,
    subAgentRoots: input.subAgentRoots,
    resolveSubAgentRoots: input.resolveSubAgentRoots,
    skillStateStore: input.skillStateStore,
    ordinaryAgentFeature,
    resolveManagedAttachmentPath,
    agentNotesFeature,
    pathDependencyFeature,
    spaceFeature,
    workspaceFeature,
    conversationLifecycle,
    spaceConversationDeletion,
    workspaceDeletion,
    personalKnowledgeFeature,
    synechDataMaintenance,
    prepareOrdinaryRunBirth: (runInput, conversationId) => prepareOrdinaryRunBirth(host, runInput, conversationId),
    toolOutputStore,
    synechDatabase,
    managedAssets,
    managedAssetFeature,
    fileMutationCoordinator,
    synechProjectionChanges,
    releaseSynechProjectionChanges: () => {
      for (const unsubscribe of projectionChangeUnsubscribers.splice(0)) unsubscribe();
      spaceProcessLifecycleUnsubscribe();
      spaceRevocationOverlay.dispose();
      synechProjectionChanges.release();
    },
    knowledgeAssetRoot,
    managedSpaceFolderRoot,
    knowledgeAssetsReady,
    ensureInitialSynechData: () => initialSynechData.ensure(),
    flushSpaceKnowledgeSync: () => spaceKnowledgeSync,
    flushSpaceProcessCleanup: async () => {
      while (activeSpaceProcessCleanups.size > 0) {
        await Promise.all([...activeSpaceProcessCleanups]);
      }
    },
    releaseAgentSessionStorage: () => agentSessionEnvironment.cleanup(),
  };

  let restorePreparation: Promise<void> | undefined;
  beforeSynechRestoreStage = () => restorePreparation ??= (async () => {
    host.isQuiescing = true;
    await ordinaryAgentFeature.release();
    await pathDependencyFeature.release();
    await initialSynechData.ensure();
    await personalKnowledgeFeature.release();
    await spaceFeature.release();
  })();
  return host;
}

function openPanelSynechStorage(productPaths: ProductPaths) {
  const database = new SqliteRuntimeDatabase(productPaths.data.database);
  try {
    return {
      database,
      managedAssets: createSqliteManagedAssetRepository(database),
      spaceRepository: createSqliteSpaceRepository(database),
      personalKnowledgeRepository: createSqlitePersonalKnowledgeRepository(database),
    };
  } catch (startupError) {
    try {
      database.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Synech storage initialization and cleanup both failed.",
      );
    }
    throw startupError;
  }
}

function assertSpaceDeletionJournalIdle(productPaths: ProductPaths): void {
  const status = inspectFileSystemSpaceReferenceDeletionJournal(
    path.join(productPaths.state.journals, "space-reference-deletions"),
  );
  if (status !== "idle") throw new Error("Space deletion recovery is still pending.");
}

function projectionChangeFromSpace(event: SpaceEvent): SynechProjectionChangeInput {
  switch (event.type) {
    case "space.created":
      return { owners: ["spaces"] as const, spaceIds: [event.space.id] };
    case "space.deleted":
      return {
        owners: ["spaces"] as const,
        spaceIds: [event.spaceId],
        referenceIds: event.removedReferenceIds,
      };
    case "space.reference_added":
      return {
        owners: ["spaces"] as const,
        spaceIds: [event.item.spaceId],
        referenceIds: [event.item.id],
      };
    case "space.reference_annotation_updated":
    case "space.reference_image_caption_updated":
      return {
        owners: ["spaces"] as const,
        spaceIds: [event.item.spaceId],
        referenceIds: [event.item.id],
      };
    case "space.renamed":
      return {
        owners: ["spaces"] as const,
        spaceIds: [event.spaceId],
        ...(event.target.kind === "reference" ? { referenceIds: [event.target.id] } : {}),
      };
    case "space.moved":
      return {
        owners: ["spaces"] as const,
        spaceIds: [event.sourceSpaceId, event.destinationSpaceId],
        referenceIds: [event.target.id],
      };
    case "space.reference_removed":
      return {
        owners: ["spaces"] as const,
        spaceIds: [event.spaceId],
        referenceIds: event.removedItemIds,
      };
  }
}

function projectionChangeFromPersonalKnowledge(event: PersonalKnowledgeEvent) {
  switch (event.type) {
    case "personal_knowledge.note_created":
      return {
        owners: ["personal_knowledge"] as const,
        spaceIds: [event.spaceId],
        noteIds: [event.noteId],
      };
    case "personal_knowledge.note_updated":
    case "personal_knowledge.note_deleted":
      return {
        owners: ["personal_knowledge"] as const,
        noteIds: [event.noteId],
      };
    case "personal_knowledge.changed":
      return {
        owners: ["personal_knowledge"] as const,
        ...(event.refIds === undefined ? {} : { referenceIds: event.refIds }),
      };
  }
}

function managedKnowledgeAssetWriteError(error: unknown): unknown {
  if (!(error instanceof PanelHttpError)) return error;
  switch (error.code) {
    case "space_reference_revision_conflict":
      return new PersonalKnowledgeError("knowledge_asset_revision_conflict", error.message, { cause: error });
    case "space_reference_source_missing":
      return new PersonalKnowledgeError("knowledge_asset_source_missing", error.message, { cause: error });
    case "space_reference_not_editable":
      return new PersonalKnowledgeError("knowledge_asset_not_editable", error.message, { cause: error });
    default:
      return new PersonalKnowledgeError("knowledge_asset_write_failed", error.message, { cause: error });
  }
}

/**
 * 挂载身份统一使用斜杠分隔，使同 Space 的父子重叠检测可以按路径段边界比较。
 * Windows 走不区分大小写的规范形式，Unix 保留大小写语义。
 */
async function canonicalWorkspaceMountIdentity(value: string): Promise<string> {
  return await canonicalSpacePathIdentity(value, (target) => fs.realpath(target));
}

export function reconstructFrozenOrdinaryDefinition(
  base: AgentDefinition,
  ref: OrdinaryRunBirth["agentDefinitionRef"],
  instructions: string,
): AgentDefinition | undefined {
  const candidate: AgentDefinition = {
    ...base,
    prompt: {
      ...base.prompt,
      promptRef: ref.promptRef,
      version: ref.promptVersion,
      systemPrompt: instructions,
    },
  };
  return agentDefinitionRefMatchesDefinition(ref, candidate) ? candidate : undefined;
}

async function prepareOrdinaryRunBirth(
  runtime: PanelHost,
  input: PanelRunInput,
  conversationId?: string,
): Promise<OrdinaryRunBirth> {
  // 先解析 owner 作用域：能力快照（Skill/Sub-Agent roots、工具 fallback）与
  // execution root 与能力快照都要以 owner 根为准（ADR-0035 §3.1/§3.2）。
  const scope = await resolveConversationExecutionScope(runtime, input, conversationId);
  const [informationAccess, toolConfirmation, baseCapabilitySnapshot, ordinaryAgentPromptConfig] = await Promise.all([
    runtime.configCenter.getInformationAccessConfig(),
    runtime.configCenter.getToolConfirmationConfig(),
    capabilitySnapshotForRun(runtime, input.modelOverride, scope.cwd, scope.owner),
    runtime.configCenter.getOrdinaryAgentPromptConfig(),
  ]);
  const capabilitySnapshot = ordinaryCapabilitySnapshotForRunStart(
    baseCapabilitySnapshot,
    input.reasoningEffort,
  );
  const configuredDefinition = ordinaryAgentDefinitionFromPromptConfig(runtime.ordinaryAgentDefinition, ordinaryAgentPromptConfig);
  const [ownerBlock, noteSnapshot, pathDependencyDirectory] = await Promise.all([
    formatOwnerContext(runtime, scope),
    runtime.agentNotesFeature.queries.startupSnapshot(scope.owner),
    runtime.pathDependencyFeature.queries.directory({
      owners: memoryOwnersForConversation(scope.owner),
      limit: PATH_DEPENDENCY_DIRECTORY_MAX_ENTRIES,
      excerptChars: 240,
    }),
  ]);
  // Both memory injections are frozen with this run's definition. A restarted
  // run therefore sees the exact directory and declarative notes available at
  // birth; the following run sees any later revision deliberately.
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

/** 组装模型可见的 owner 区块（ADR-0035 §6.2）。引用列表由本轮 run context 承载。 */
async function formatOwnerContext(
  runtime: PanelHost,
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

/**
 * 组装模型可见的环境区块：操作系统、shell 与当前本地时间。随 run birth 冻结，
 * 每次 run 重新生成，与 owner 区块一起进入当前用户回合。
 */
function formatEnvironmentContext(
  commandShell: { readonly kind: string; readonly syntax: string } | undefined,
  now: Date = new Date(),
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

/**
 * Resolves the frozen execution scope for a run birth（ADR-0035 §3.1）。
 *
 * - New conversation: the requested owner decides the cwd（Space managedRoot /
 *   Workspace current mount root）。
 * - Existing conversation: the canonical owner stored on the Ordinary document.
 *
 * Missing owner is a contract violation. Production routes reject it before
 * run birth; this guard protects internal callers and restart paths.
 */
async function resolveConversationExecutionScope(
  runtime: PanelHost,
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
  if (owner === undefined) {
    throw new Error("Conversation owner is required before run birth.");
  }
  if (owner.kind === "workspace") {
    // Run birth is also a host boundary (not only an HTTP route). Check both
    // the in-process deletion gate and the durable status so a restart cannot
    // birth a run for a Workspace whose cascade is still pending.
    runtime.workspaceDeletion.assertAvailable(owner.id);
    const workspace = await runtime.workspaceFeature.queries.get(owner.id);
    if (workspace?.status !== "available") {
      if (workspace === undefined) {
        throw new PanelHttpError(404, "workspace_not_found", `工作区 ${owner.id} 不存在。`);
      }
      throw new PanelHttpError(409, "workspace_not_available", `工作区 ${owner.id} 当前不可用。`);
    }
    const mount = workspace?.mounts.find((entry) => entry.status === "active");
    if (mount === undefined) {
      throw new Error(`Workspace ${owner.id} has no active mount and cannot host a run.`);
    }
    return { owner, cwd: mount.rootPath };
  }
  // Run birth is a host boundary as well as an HTTP route. Reject a Space
  // whose deletion journal is active before creating a frozen birth snapshot.
  runtime.spaceConversationDeletion.assertAvailable(owner.id);
  if (await runtime.spaceFeature.queries.getTree(owner.id) === undefined) {
    throw new PanelHttpError(404, "space_not_found", `Space ${owner.id} was not found.`);
  }
  const managedRoot = path.join(runtime.productPaths.data.workbench.spaceFiles, owner.id, "files");
  await ensureSpaceManagedRoot(managedRoot);
  return { owner, cwd: managedRoot, managedRoot };
}

async function ensureSpaceManagedRoot(managedRoot: string): Promise<void> {
  await fs.mkdir(managedRoot, { recursive: true });
}

function definitionWithMemoryContext(
  definition: AgentDefinition,
  noteInjection: string | undefined,
  pathDependencyDirectory: readonly PathDependencyDirectoryEntry[],
  countMemoryTokens: (text: string) => number,
): AgentDefinition {
  const directoryInjection = pathDependencyDirectoryInjection(pathDependencyDirectory, countMemoryTokens);
  if (noteInjection === undefined && directoryInjection === undefined) return definition;
  const systemPrompt = [
    definition.prompt.systemPrompt,
    ...(noteInjection === undefined ? [] : ["<agent_notes>", noteInjection, "</agent_notes>"]),
    ...(directoryInjection === undefined ? [] : ["<path_dependency_directory>", directoryInjection, "</path_dependency_directory>"]),
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

/**
 * The prompt contains only a small directory, never a full methodology. The
 * model must choose whether a candidate warrants MemoryRead, then separately
 * record deliberate adoption with MemoryReference.
 */
function pathDependencyDirectoryInjection(
  entries: readonly PathDependencyDirectoryEntry[],
  countMemoryTokens: (text: string) => number,
): string | undefined {
  return renderPathDependencyDirectory(entries, countMemoryTokens);
}

export async function cleanupPanelHostOwnedProcesses(
  runtime: PanelHost
): Promise<ProcessRegistryCleanupResult> {
  await runtime.flushSpaceProcessCleanup();
  return runtime.processRegistry.cleanupOwnedProcesses(runtime.processTerminator);
}

async function modelProviderConfigForRun(
  runtime: PanelHost,
  override: PanelRunInput["modelOverride"]
): Promise<import("../../domain/config/index.js").SanitizedModelProviderConfig> {
  if (override === undefined) {
    return runtime.configCenter.getModelProviderConfig();
  }
  const profile = (await runtime.configCenter.listModelProviderProfiles())
    .find((item) => item.profileId === override.profileId);
  if (profile === undefined) {
    throw new PanelHttpError(400, "model_profile_not_found", "未找到本次选择的模型服务。");
  }
  if (profile.enabled === false) {
    throw new PanelHttpError(400, "model_profile_disabled", "本次选择的模型服务已停用。");
  }
  return { ...profile, model: override.model };
}

async function capabilitySnapshotForRun(
  runtime: PanelHost,
  override: PanelRunInput["modelOverride"],
  executionRoot: string,
  memoryOwner: ConversationOwner,
): Promise<import("../../domain/config/index.js").OrdinaryCapabilitySnapshot> {
  const snapshot = await runtime.capabilityCenter.snapshot({ executionRoot, memoryOwner });
  if (override === undefined) {
    return snapshot;
  }
  const activeModel = await modelProviderConfigForRun(runtime, override);
  const overrides = await runtime.configCenter.listModelCapabilityOverrides();
  return {
    ...snapshot,
    activeModel,
    modelCapabilities: resolveModelCapabilities({ profile: activeModel, overrides }),
  };
}

function resolveSkillRoots(
  options: PanelServerOptions,
  input: PanelSkillRootsInput = {}
): readonly SkillRootInput[] {
  if (options.skillRoots !== undefined) {
    return options.skillRoots;
  }
  return [
    ...resolveDefaultPanelSkillRoots({ executionRoot: input.executionRoot }),
    ...(options.additionalSkillRoots ?? []),
  ];
}

function resolveSubAgentRoots(
  options: PanelServerOptions,
  input: PanelSubAgentRootsInput = {}
): readonly SubAgentRootInput[] {
  if (options.subAgentRoots !== undefined) {
    return options.subAgentRoots;
  }
  return [
    ...resolveDefaultPanelSubAgentRoots({ executionRoot: input.executionRoot }),
    ...(options.additionalSubAgentRoots ?? []),
  ];
}

export function resolveDefaultPanelSkillRoots(input: {
  readonly cwd?: string;
  readonly home?: string;
  readonly executionRoot?: string;
} = {}): readonly SkillRootInput[] {
  const projectBase = input.executionRoot ?? input.cwd ?? process.cwd();
  const projectRoot = path.join(projectBase, ".agents", "skills");
  const userRoot = path.join(input.home ?? homeDirectory(), ".agents", "skills");
  if (path.resolve(projectRoot) === path.resolve(userRoot)) {
    return [{
      rootPath: projectRoot,
      sourceKind: "project",
      sourceRootId: "project",
      precedence: 100,
    }];
  }
  return [
    {
      rootPath: userRoot,
      sourceKind: "user",
      sourceRootId: "user",
      precedence: 10,
    },
    {
      rootPath: projectRoot,
      sourceKind: "project",
      sourceRootId: "project",
      precedence: 100,
    },
  ];
}

export function resolveDefaultPanelSubAgentRoots(input: {
  readonly cwd?: string;
  readonly home?: string;
  readonly builtinRoot?: string;
  readonly executionRoot?: string;
} = {}): readonly SubAgentRootInput[] {
  const builtinRoot = input.builtinRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sub-agents", "builtin");
  const projectBase = input.executionRoot ?? input.cwd ?? process.cwd();
  const projectRoot = path.join(projectBase, ".agents", "sub-agents");
  const userRoot = path.join(input.home ?? homeDirectory(), ".agents", "sub-agents");
  const roots: SubAgentRootInput[] = [
    {
      rootPath: builtinRoot,
      sourceKind: "builtin",
      sourceRootId: "builtin",
      precedence: 1,
    },
  ];
  if (path.resolve(projectRoot) !== path.resolve(userRoot)) {
    roots.push({
      rootPath: userRoot,
      sourceKind: "user",
      sourceRootId: "user",
      precedence: 10,
    });
  }
  roots.push({
    rootPath: projectRoot,
    sourceKind: "project",
    sourceRootId: "project",
    precedence: 100,
  });
  return roots;
}

function homeDirectory(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
}

function resolveSkillStateStore(configDirectory: string): SkillStateStore {
  return new FileSystemSkillStateStore(resolveSkillStateStorePath(configDirectory));
}
