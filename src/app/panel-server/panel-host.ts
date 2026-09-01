import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  FileSystemAgentSessionRepository,
} from "../../adapters/intelligence/index.js";
import {
  FileSystemToolOutputStore,
  SqliteRuntimeDatabase,
} from "../../adapters/runtime-storage/index.js";
import type { ProductPaths } from "../../platform/storage/index.js";
import { createRuntimeAgentDefinitionCatalog } from "../agent-definitions/agent-definition-catalog.js";
import { runAgentDefinitionRefCacheKey } from "../agent-definitions/agent-definition-ref.js";
import type { AgentDefinitionRegistry } from "../agent-definitions/agent-definition-registry.js";
import type { AgentDefinition } from "../agent-prompts/contracts.js";
import { CapabilityCenter } from "../capability/capability-center.js";
import {
  captureKnowledgeAsset,
  managedKnowledgeDocumentTarget,
  observeKnowledgeAssetReadiness,
  readManagedKnowledgeAsset,
  reconcileKnowledgeAssets,
  removeKnowledgeAsset,
  stageKnowledgeAssetRemoval,
} from "./storage/knowledge-asset-store.js";
import { updateLocalDocumentText } from "./storage/local-document-preview.js";
import { ConfigCenter, createLocalConfigCenter } from "../config-center/index.js";
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
} from "../ordinary-agent/index.js";
import {
  createAgentNotesFeature,
  createFileSystemAgentNoteRepository,
  type AgentNotesFeature,
} from "../agent-notes/index.js";
import {
  createFileSystemPathDependencyRepository,
  createPathDependencyFeature,
  type PathDependencyFeature,
} from "../path-dependencies/index.js";
import {
  canonicalSpacePathIdentity,
  createSpaceRunPathAuthorization,
  createFileSystemSpaceReferenceDeletionJournal,
  createSpaceFeature,
  hasSpaceOwnerScope,
  inspectSpaceExternalSource,
  spaceReferenceIdFromAttachmentId,
  type SpaceFeature,
} from "../spaces/index.js";
import {
  createPersonalKnowledgeFeature,
  PersonalKnowledgeError,
  type PersonalKnowledgeFeature,
} from "../personal-knowledge/index.js";
import { createMemoryRuntime, renderImplicitMemoryBlock, type MemoryRuntime } from "../memory/index.js";
import {
  createSqliteWorkspaceRepository,
  createWorkspaceFeature,
  type WorkspaceFeature,
} from "../workspaces/index.js";
import type { WorkbenchCoordination } from "../workbench-coordination/index.js";
import type { WorkspaceDeletionCoordinator } from "../workbench-coordination/index.js";
import {
  applyPendingRestore,
  createDataMaintenance,
  type DataMaintenance,
} from "./storage/data-maintenance.js";
import { createSpaceReferenceDeletionFilePort } from "./spaces/space-reference-deletion.js";
import { resolveSpaceFilesystemReference } from "./spaces/space-workspace-reference.js";
import { resolveConversationSpaceAccess } from "./spaces/space-agent-access.js";
import {
  createOrdinaryConversationTitleGenerator,
} from "./ordinary/ordinary-conversation-title.js";
import {
  createPlatformProcessTerminator,
  InMemoryProcessRegistry,
  type ProcessCleanupResult,
  type ProcessTerminator,
} from "../runtime-guard/index.js";
import type { SkillRootInput, SkillStateStore } from "../skills/index.js";
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
import { PanelHttpError } from "./http-utils.js";
import { createOrdinaryAgentRunResourceAcquirer } from "./ordinary/ordinary-agent-run-resources.js";
import { createHostFeatureAgentToolContributionResolver } from "./ordinary/agent-tool-contributions.js";
import { resolveTriggeredSkillContexts } from "./settings/skill-service.js";
import { InMemoryLocalWorkspaceMutationCoordinator } from "../tool-center/adapters/local-workspace-mutation-coordinator.js";
import type { LocalWorkspaceMutationCoordinator } from "../tool-center/adapters/local-workspace-mutation-coordinator.js";
import {
  createInitialWorkbenchDataInitializer,
  initializeInitialWorkbenchData,
} from "./storage/initial-workbench-data.js";
import { ensureDefaultSpace as ensureBaseDefaultSpace } from "./storage/default-space-initializer.js";
import {
  createManagedAssetsFeature,
  type ManagedAssetRepository,
  type ManagedAssetsFeature,
} from "../managed-assets/index.js";
import {
  type SpaceConversationDeletionCoordinator,
  type ConversationLifecycleCoordinator,
} from "../workbench-coordination/index.js";
import { createSqliteSpaceConversationDeletionJournal } from "./spaces/space-conversation-deletion-journal.js";
import { createSqliteConversationLifecycleJournal } from "./storage/conversation-lifecycle-journal.js";
import {
  prepareOrdinaryRunBirth,
  reconstructFrozenOrdinaryDefinition,
} from "./ordinary-run-birth.js";
import { assertSpaceDeletionJournalIdle, openPanelStorage } from "./storage/panel-storage.js";
import {
  createSkillStateStore,
  resolveSkillRoots,
  resolveSubAgentRoots,
} from "./storage/runtime-asset-roots.js";
import { createApplicationRuntime } from "./composition/workbench-coordination-runtime.js";
import {
  createSpaceReferenceApplicationRuntime,
  type SpaceReferenceApplicationRuntime,
} from "./composition/space-reference-application-runtime.js";
import {
  createPanelProjectionRuntime,
  type PanelProjectionRuntime,
} from "./composition/panel-projection-runtime.js";
import {
  createSpaceReferenceRuntimeGuard,
  type SpaceReferenceRuntimeGuard,
} from "./composition/space-reference-runtime-guard.js";
import type { ManagedSpaceFolderApplication } from "../../domain/managed-space-folder.js";
import {
  createContextAttachmentUploadApplication,
  type ContextAttachmentUploadApplication,
} from "../application/context-attachment-application.js";
import { createWebReferenceMetadataWorker, type WebReferenceMetadataWorker } from "./spaces/web-reference-metadata-worker.js";
import { createWebReferenceMetadataDiagnostics, type WebReferenceMetadataDiagnostics } from "./spaces/web-reference-metadata-diagnostics.js";

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
  readonly contextAttachmentUploadApplication: ContextAttachmentUploadApplication;
  readonly agentNotesFeature: AgentNotesFeature;
  readonly pathDependencyFeature: PathDependencyFeature;
  readonly spaceFeature: SpaceFeature;
  readonly webReferenceMetadataWorker: WebReferenceMetadataWorker;
  readonly webReferenceMetadataDiagnostics: WebReferenceMetadataDiagnostics;
  readonly workspaceFeature: WorkspaceFeature;
  readonly conversationLifecycle: ConversationLifecycleCoordinator;
  readonly spaceConversationDeletion: SpaceConversationDeletionCoordinator;
  readonly workspaceDeletion: WorkspaceDeletionCoordinator;
  readonly workbenchCoordination: WorkbenchCoordination;
  readonly ordinaryTurnApplication: import("../application/ordinary-turn-application.js").OrdinaryTurnApplication;
  readonly managedSpaceFolderApplication: ManagedSpaceFolderApplication<import("../spaces/index.js").SpaceReferenceItem>;
  readonly spaceReferenceApplications: SpaceReferenceApplicationRuntime;
  readonly personalKnowledgeFeature: PersonalKnowledgeFeature<import("../panel-api/workbench.js").DocumentPreview>;
  /** Memory v2 运行时（Context Provider / Capture / Lifecycle）。 */
  readonly memoryRuntime: MemoryRuntime;
  readonly onRunBirthActivity?: (input: { readonly conversationId?: string; readonly owner: import("../../domain/execution-scope/index.js").ConversationOwner }) => void;
  readonly dataMaintenance: DataMaintenance;
  readonly toolOutputStore: ToolOutputStore;
  readonly database: SqliteRuntimeDatabase;
  readonly managedAssets: ManagedAssetRepository;
  readonly managedAssetFeature: ManagedAssetsFeature;
  readonly fileMutationCoordinator: LocalWorkspaceMutationCoordinator;
  readonly projectionRuntime: PanelProjectionRuntime;
  readonly spaceReferenceRuntimeGuard: SpaceReferenceRuntimeGuard;
  readonly knowledgeAssetRoot?: string;
  /** Host-owned root for physical directories created from Space. */
  readonly managedSpaceFolderRoot: string;
  readonly knowledgeAssetsReady: Promise<void>;
  readonly ensureDefaultSpace: () => Promise<void>;
  readonly flushSpaceKnowledgeSync: () => Promise<void>;
  readonly releaseAgentSessionStorage: () => Promise<void>;
  readonly resolveSubAgentRoots?: (input: PanelSubAgentRootsInput) => readonly SubAgentRootInput[];
};

type PanelSkillRootsInput = {
  readonly executionRoot?: string;
};

type PanelSubAgentRootsInput = {
  readonly executionRoot?: string;
};

export type PanelHostOptions = Omit<PanelServerOptions, "host" | "port" | "productHome"> & {
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
      restorePicker: options.restorePicker,
      externalResourceOpener: options.externalResourceOpener,
      skillRoots: resolveSkillRoots(options),
      resolveSkillRoots: (input) => resolveSkillRoots(options, input),
      subAgentRoots: resolveSubAgentRoots(options),
      resolveSubAgentRoots: (input) => resolveSubAgentRoots(options, input),
      skillStateStore: createSkillStateStore(options.productPaths.configDirectory),
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
    restorePicker: options.restorePicker,
    externalResourceOpener: options.externalResourceOpener,
    skillRoots: resolveSkillRoots(options),
    resolveSkillRoots: (input) => resolveSkillRoots(options, input),
    subAgentRoots: resolveSubAgentRoots(options),
    resolveSubAgentRoots: (input) => resolveSubAgentRoots(options, input),
    skillStateStore: createSkillStateStore(local.configDirectory),
    processTerminator: options.processTerminator,
    productPaths: options.productPaths,
  });
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
  readonly restorePicker?: () => Promise<string | undefined>;
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
  const productPaths = input.productPaths;
  const toolOutputStore = new FileSystemToolOutputStore(productPaths.data.agent.evidence);
  const processTerminator = input.processTerminator ?? createPlatformProcessTerminator();
  const productHome = productPaths.productHome;
  const knowledgeAssetRoot = productPaths.data.knowledge.assets;
  const managedSpaceFolderRoot = path.join(productPaths.data.spaces.files, "folders");
  const managedSpaceRoot = productPaths.data.spaces.files;
  let knowledgeAssetsReady = Promise.resolve();
  applyPendingRestore(productPaths, {
    assertSpaceDeletionIdle: () => assertSpaceDeletionJournalIdle(productPaths),
  });
  const {
    database,
    managedAssets,
    spaceRepository,
    personalKnowledgeRepository,
    memoryControlRepository,
  } = openPanelStorage(productPaths);
  const managedAssetFeature = createManagedAssetsFeature(managedAssets);
  const spaceConversationDeletionJournal = createSqliteSpaceConversationDeletionJournal(database);
  const conversationLifecycleJournal = createSqliteConversationLifecycleJournal(database);
  let beforeRestoreStage: (() => Promise<void>) | undefined;
  const dataMaintenance = createDataMaintenance({
    database,
    productPaths,
    restorePicker: input.restorePicker,
    beforeRestoreStage: async () => {
      if (beforeRestoreStage === undefined) {
        throw new Error("Panel runtime restore preparation is not initialized.");
      }
      await beforeRestoreStage();
    },
    runOwnedStorageSnapshot: async (operation) => {
      await knowledgeAssetsReady;
      return await fileMutationCoordinator.runExclusive(productHome, async () => {
        if ((await spaceReferenceDeletionJournal.list()).length > 0) {
          throw new Error("Workbench storage cannot be snapshotted while a Space deletion journal is pending.");
        }
        if ((await spaceConversationDeletionJournal.list()).length > 0) {
          throw new Error("Workbench storage cannot be snapshotted while a Space deletion lifecycle is pending.");
        }
        if ((await conversationLifecycleJournal.list()).length > 0) {
          throw new Error("Workbench storage cannot be snapshotted while a Conversation lifecycle is pending.");
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
    repository: createFileSystemAgentNoteRepository(productPaths.data.memory.agentNotes),
  });
  // Path dependencies are durable methodology memories. They deliberately
  // live beside, rather than inside, Ordinary run snapshots: Ordinary owns
  // the run-bound read/adoption facts, while this feature owns the reusable
  // content and its revision history.
  const pathDependencyFeature = createPathDependencyFeature({
    repository: createFileSystemPathDependencyRepository(productPaths.data.memory.methods),
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
  const webReferenceMetadataDiagnostics = createWebReferenceMetadataDiagnostics(
    productPaths.state.diagnostics.webReferenceMetadata,
  );
  const webReferenceMetadataWorker = createWebReferenceMetadataWorker({
    spaces: spaceFeature,
    faviconRoot: productPaths.data.spaces.webMetadata,
    onDiagnostic: webReferenceMetadataDiagnostics.record,
  });
  void webReferenceMetadataWorker.ready().catch((error) => console.error(
    "[panel-server] Web metadata worker startup scan failed; pending references will retry on next startup",
    error,
  ));
  const invalidateSpaceReferenceAccess = async (
    referenceId: string,
    expectedMountVersion?: string,
  ): Promise<void> => {
    const item = await spaceFeature.queries.getReference(referenceId);
    if (item?.reference.kind === "workspace" && expectedMountVersion !== undefined) {
      await workspaceFeature.commands.invalidateMount({
        workspaceId: item.reference.workspaceId,
        expectedMountVersion,
      });
    }
  };
  const workspaceFeature: WorkspaceFeature = createWorkspaceFeature({
    repository: createSqliteWorkspaceRepository(database),
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
      const resolved = item.reference.kind === "local_file" || item.reference.kind === "workspace" || item.reference.kind === "managed_folder"
        ? await resolveSpaceFilesystemReference({ workspaceFeature }, item)
        : undefined;
      const asset = await captureKnowledgeAsset(knowledgeAssetRoot, assetId, item, relativePath, resolved?.path);
      if (item.reference.kind !== "workspace") return asset;
      try {
        await resolveSpaceFilesystemReference({ workspaceFeature }, item);
        return asset;
      } catch {
        await removeKnowledgeAsset(knowledgeAssetRoot, assetId);
        return undefined;
      }
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
  // Memory v2（隐式长期记忆）：Phase 1 装配走 Noop Provider/Capture（恒空贡献/跳过
  // 提炼）+ 基于控制表的 Durable 删除生命周期；主链路模型可见输出零变化。
  const memoryRuntime: MemoryRuntime = createMemoryRuntime({
    controlRepository: memoryControlRepository,
  });
  const initialWorkbenchData = createInitialWorkbenchDataInitializer(async () =>
    await initializeInitialWorkbenchData({
      database,
      spaceFeature,
      personalKnowledgeFeature,
      managedAssets,
      managedSpaceRoot,
      managedSpaceFolderRoot,
    }),
  );
  const knowledgeAssetReconciliation = personalKnowledgeFeature.queries.snapshot().then(async (snapshot) => {
    await fileMutationCoordinator.runExclusive(knowledgeAssetRoot, async () => await reconcileKnowledgeAssets(
      knowledgeAssetRoot,
      new Set(snapshot.pages.filter((page) => page.asset?.status === "managed").map((page) => page.refId)),
    ));
  });
  knowledgeAssetsReady = observeKnowledgeAssetReadiness(knowledgeAssetReconciliation, (error) => {
    console.error(
      "[panel-server] Knowledge asset reconciliation failed; managed Knowledge operations and backups remain unavailable until restart",
      error,
    );
  });
  // Start initial content materialization early; consumers await the same retryable attempt.
  void initialWorkbenchData.ensure().catch(() => undefined);
  const ensurePanelDefaultData = async (): Promise<void> => {
    try {
      await knowledgeAssetsReady;
    } catch {
      // Space and the rest of Panel remain usable even when the managed
      // Knowledge directory could not be reconciled on this startup.
      await ensureBaseDefaultSpace({ spaceFeature, managedSpaceRoot });
      return;
    }
    await initialWorkbenchData.ensure();
  };
  const spaceKnowledgeSync = Promise.resolve();
  const spaceReferenceRuntimeGuard = createSpaceReferenceRuntimeGuard({
    spaces: spaceFeature,
    processes: processRegistry,
    processTerminator,
  });
  const spaceRevocationOverlay = spaceReferenceRuntimeGuard.revocationOverlay;
  const contextAttachmentReadAuthorization = {
    async assertReadAllowed(attachmentId: string): Promise<void> {
      spaceRevocationOverlay.assertReadAllowed(attachmentId);
      const referenceId = spaceReferenceIdFromAttachmentId(attachmentId);
      if (referenceId === undefined) return;
      const item = await spaceFeature.queries.getReference(referenceId);
      if (item === undefined) {
        throw new Error(`Space reference ${referenceId} was removed and is no longer readable.`);
      }
      if (item.reference.kind !== "workspace") return;
      await resolveSpaceFilesystemReference({ workspaceFeature }, item);
    },
  };
  let workbenchCoordination!: WorkbenchCoordination;
  let spaceReferenceApplications!: SpaceReferenceApplicationRuntime;
  let managedSpaceFolderApplication!: ManagedSpaceFolderApplication<import("../spaces/index.js").SpaceReferenceItem>;
  const resolveFeatureToolContributions = createHostFeatureAgentToolContributionResolver({
    agentNotes: agentNotesFeature,
    pathDependencies: pathDependencyFeature,
    spaces: spaceFeature,
    personalKnowledge: personalKnowledgeFeature,
    revocationOverlay: spaceRevocationOverlay,
    spaceReferenceContentApplication: () => spaceReferenceApplications.content,
    spaceReferenceLifecycleApplication: () => spaceReferenceApplications.lifecycle,
    deleteSpace: (spaceId) => workbenchCoordination.commands.deleteSpace(spaceId),
    deleteConversation: (conversationId) => conversationLifecycle.deleteConversation(conversationId),
    managedSpaceFolderApplication: () => managedSpaceFolderApplication,
    attachWorkspaceDirectory: async ({ spaceId, path: workspacePath, title, actor, annotation }) =>
      (await workbenchCoordination.commands.attachWorkspaceToSpace({
        spaceId,
        rootPath: workspacePath,
        title,
        actor,
        ...(annotation === undefined ? {} : { annotation }),
      })).item,
    resolveWorkspaceDirectory: async (workspaceId) => {
      const workspace = await workspaceFeature.queries.get(workspaceId);
      const mount = workspace?.status === "available"
        ? workspace.currentMount
        : undefined;
      if (mount === undefined) return undefined;
      const source = await inspectSpaceExternalSource(mount.rootPath);
      if (source?.kind !== "folder" || source.identity !== mount.sourceIdentity) {
        await workspaceFeature.commands.invalidateMount({
          workspaceId,
          expectedMountVersion: mount.mountVersion,
        });
        return undefined;
      }
      return {
        path: mount.rootPath,
        sourceIdentity: mount.sourceIdentity,
        mountVersion: mount.mountVersion,
      };
    },
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
      commandLogDirectory: productPaths.cache.commandLogs,
      managedMcpBinDirectory: productPaths.state.runtimeTools.mcp.bin,
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
    resolveImplicitMemoryBlock: async ({ owner, conversationId, userText }) => {
      // Recall 截止时间是实验参数（《手册》检索预算），Noop 不消费；Phase 3 接真实预算。
      const contribution = await memoryRuntime.contextProvider.contribute({
        owner,
        conversationId,
        currentUserText: userText,
        deadlineAt: Date.now() + 700,
      });
      return renderImplicitMemoryBlock(contribution);
    },
    contextAttachmentReadAuthorization,
    resolveWorkspacePathAuthorization: ({ runContext, workspaceRoot }) =>
      createSpaceRunPathAuthorization({
        runContext,
        workspaceRoot,
        revocationOverlay: spaceRevocationOverlay,
        resolveCurrentSource: async (referenceId) => {
          const item = await spaceFeature.queries.getReference(referenceId);
          if (item === undefined) return undefined;
          if (item.reference.kind === "local_file") {
            return { path: item.reference.path, sourceIdentity: item.sourceIdentity };
          }
          if (item.reference.kind === "managed_folder") {
            return { path: item.reference.path };
          }
          if (item.reference.kind !== "workspace") return undefined;
          const workspace = await workspaceFeature.queries.get(item.reference.workspaceId);
          const mount = workspace?.status === "available"
            ? workspace.currentMount
            : undefined;
          return mount === undefined ? undefined : {
            path: mount.rootPath,
            sourceIdentity: mount.sourceIdentity,
            mountVersion: mount.mountVersion,
          };
        },
        onInvalidReference: invalidateSpaceReferenceAccess,
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
        console.error(`[panel-server] Agent run ${diagnostic.runId} session finalization failed; the conversation queue remains paused`, diagnostic.error);
      } else if (diagnostic.kind === "conversation_unavailable") {
        console.error(`[panel-server] Ordinary conversation ${diagnostic.conversationId} is unavailable after startup recovery; its data remains on disk for diagnosis`, diagnostic.error);
      } else if (diagnostic.kind === "successor_activation_failed") {
        const activationOwner = diagnostic.predecessorRunId ?? diagnostic.conversationId;
        console.error(`[panel-server] Agent successor activation failed for ${activationOwner}; the queued run remains available`, diagnostic.error);
      } else if (diagnostic.kind === "cancellation_cleanup_failed") {
        console.error(`[panel-server] Ordinary run ${diagnostic.runId} cancellation cleanup failed during ${diagnostic.phase}; its durable cancelled fact remains authoritative`, diagnostic.error);
      } else if (diagnostic.kind === "conversation_cleanup_failed") {
        const resourceOwner = diagnostic.runId ?? diagnostic.conversationId;
        console.error(`[panel-server] Agent conversation ${diagnostic.conversationId} cleanup failed during ${diagnostic.phase} for ${resourceOwner}; durable state remains authoritative`, diagnostic.error);
      } else if (diagnostic.kind === "managed_attachment_cleanup_failed") {
        console.error(`[panel-server] Agent conversation ${diagnostic.conversationId} managed attachment cleanup failed`, diagnostic.error);
      } else if (diagnostic.kind === "managed_attachment_recovery_issue") {
        console.error(`[panel-server] Ordinary managed attachment ${diagnostic.identity ?? "storage"} recovery was isolated`, diagnostic.error);
      } else if (diagnostic.kind === "managed_attachment_claim_rollback_failed") {
        console.error(`[panel-server] Agent run ${diagnostic.runId} could not roll back managed attachment claims`, diagnostic.error);
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
  // Memory v2 Capture：run 稳定终结后把信号交给 Capture Runtime（Phase 1 Noop 恒 skipped）。
  const unsubscribeStableTerminalRuns = ordinaryAgentFeature.events.subscribeStableTerminalRuns((runId) => {
    void (async () => {
      try {
        const facts = await ordinaryAgentFeature.queries.getStableTerminalRunFacts(runId);
        if (facts === undefined) return;
        const owner = await ordinaryAgentFeature.queries
          .getConversationOwner(facts.turn.conversationId);
        if (owner === undefined) return;
        // Memory v2 Capture 口：Phase 1 Noop 恒 skipped；Phase 3 起在此 durable 接单。
        await memoryRuntime.captureRuntime.acceptStableSignal({
          owner,
          conversationId: facts.turn.conversationId,
          stableThrough: {
            turnId: facts.turn.userTurnId,
            ordinal: facts.turn.ordinal,
            sourceRevision: facts.sourceRevision,
          },
        });
      } catch (error) {
        console.error("[panel-server] Could not accept stable memory capture signal", error);
      }
    })();
  });
  const contextAttachmentUploadApplication = createContextAttachmentUploadApplication({
    ordinaryAgentFeature,
    resolveManagedAttachmentPath,
  });
  let host!: PanelHost;
  const applicationRuntime = createApplicationRuntime({
    productPaths,
    inspectDirectory: inspectSpaceExternalSource,
    spaceFeature,
    workspaceFeature,
    ordinaryAgentFeature,
    personalKnowledgeFeature,
    agentNotesFeature,
    pathDependencyFeature,
    memoryLifecycle: memoryRuntime.lifecycle,
    processRegistry,
    processTerminator,
    fileMutationCoordinator,
    spaceConversationDeletionJournal,
    conversationLifecycleJournal,
    managedSpaceFolderRoot,
    resolveSpaceAccess: ({ conversationId, contextInput, requestedSpaceId }) => resolveConversationSpaceAccess(
      spaceFeature,
      workspaceFeature,
      (id) => ordinaryAgentFeature.queries.getConversationOwner(id),
      conversationId,
      contextInput,
      requestedSpaceId,
    ),
    prepareOrdinaryRunBirth: (runInput, conversationId) => prepareOrdinaryRunBirth(host, runInput, conversationId),
  });
  const {
    conversationLifecycle,
    spaceConversationDeletion,
    workspaceDeletion,
  } = applicationRuntime;
  managedSpaceFolderApplication = applicationRuntime.managedSpaceFolderApplication;
  workbenchCoordination = applicationRuntime.workbenchCoordination;
  spaceReferenceApplications = createSpaceReferenceApplicationRuntime({
    spaces: spaceFeature,
    workspaces: workspaceFeature,
    managedAssets: managedAssetFeature,
    admission: {
      assertAvailable: (spaceId) => spaceConversationDeletion.assertAvailable(spaceId),
      admit: (spaceId, operation) => spaceConversationDeletion.admit(spaceId, operation),
    },
    coordination: workbenchCoordination,
    mutations: fileMutationCoordinator,
  });

  const projectionRuntime = createPanelProjectionRuntime({
    spaces: spaceFeature,
    personalKnowledge: personalKnowledgeFeature,
    managedAssets: managedAssetFeature,
    workspaces: workspaceFeature,
    fileMutations: fileMutationCoordinator,
    ordinary: ordinaryAgentFeature,
    managedSpaceRoot,
  });

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
    contextAttachmentUploadApplication,
    agentNotesFeature,
    pathDependencyFeature,
    spaceFeature,
    webReferenceMetadataWorker,
    webReferenceMetadataDiagnostics,
    workspaceFeature,
    conversationLifecycle,
    spaceConversationDeletion,
    workspaceDeletion,
    workbenchCoordination,
    ordinaryTurnApplication: applicationRuntime.ordinaryTurnApplication,
    managedSpaceFolderApplication,
    spaceReferenceApplications,
    personalKnowledgeFeature,
    memoryRuntime,
    // run birth 时异步补扫 Capture 缺口（典型为上次关闭错过稳定信号）；
    // Memory v2 Capture 口要求不阻塞、不向主链路抛出。
    onRunBirthActivity: ({ conversationId, owner }) => {
      if (conversationId === undefined) return;
      void memoryRuntime.captureRuntime.noteActivity({ conversationId, owner }).catch((error) => {
        console.error("[panel-server] Memory capture catch-up failed", error);
      });
    },
    dataMaintenance,
    toolOutputStore,
    database,
    managedAssets,
    managedAssetFeature,
    fileMutationCoordinator,
    projectionRuntime,
    spaceReferenceRuntimeGuard,
    knowledgeAssetRoot,
    managedSpaceFolderRoot,
    knowledgeAssetsReady,
    ensureDefaultSpace: ensurePanelDefaultData,
    flushSpaceKnowledgeSync: () => spaceKnowledgeSync,
    releaseAgentSessionStorage: () => agentSessionEnvironment.cleanup(),
  };

  let restorePreparation: Promise<void> | undefined;
  beforeRestoreStage = () => restorePreparation ??= (async () => {
    host.isQuiescing = true;
    unsubscribeStableTerminalRuns();
    await memoryRuntime.captureRuntime.release();
    await ordinaryAgentFeature.release();
    await pathDependencyFeature.release();
    await initialWorkbenchData.ensure();
    await personalKnowledgeFeature.release();
    await webReferenceMetadataWorker.release();
    await spaceFeature.release();
  })();
  return host;
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

export async function cleanupPanelHostOwnedProcesses(
  runtime: PanelHost
): Promise<ProcessCleanupResult> {
  await runtime.spaceReferenceRuntimeGuard.flush();
  return runtime.processRegistry.cleanupOwnedProcesses(runtime.processTerminator);
}
