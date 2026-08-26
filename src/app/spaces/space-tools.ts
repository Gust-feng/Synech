import path from "node:path";
import type { ToolDefinition, ToolExecutionContext, ToolExecutor, ToolJsonSchema, ToolJsonSchemaValue } from "../../domain/tools/index.js";
import { asOptionalRecord, asRecord, stringOrUndefined } from "../../kernel/values/index.js";
import type { ContextAttachmentRunContext } from "../tool-center/adapters/context-attachment-access.js";
import type { ManagedSpaceFolderApplication } from "../../domain/managed-space-folder.js";
import type { AgentToolRegistryContribution } from "../tool-center/factory.js";
import {
  attachmentEntries,
  resolveAttachmentTarget,
} from "../tool-center/adapters/context-attachment-access.js";
import {
  spaceReferenceIdFromAttachmentId,
} from "./space-file-access.js";
import {
  inspectSpaceExternalSource,
  type SpaceExternalSourceInspector,
} from "./space-external-source.js";
import { SpaceFeatureError, type SpaceDirectReference, type SpaceFeature, type SpaceReference, type SpaceReferenceActorRecord, type SpaceReferenceAnnotation, type SpaceReferenceAnnotationInput, type SpaceReferenceAnnotationPatch, type SpaceReferenceItem, type SpaceTarget } from "./contracts.js";
import { SpaceReferenceContentApplicationError } from "../space-reference-contracts/application-error.js";
import type {
  SpaceReferenceContentApplicationPort,
  SpaceReferenceLifecycleApplicationPort,
} from "../space-reference-contracts/application-port.js";

type SpaceReferenceContentApplication = SpaceReferenceContentApplicationPort<
  unknown,
  SpaceReferenceItem,
  SpaceReferenceActorRecord,
  SpaceReferenceAnnotationPatch
>;

type SpaceReferenceLifecycleApplication = SpaceReferenceLifecycleApplicationPort<
  SpaceDirectReference,
  SpaceReferenceItem,
  SpaceTarget,
  SpaceReferenceActorRecord,
  SpaceReferenceAnnotationInput
>;

export type SpaceToolOptions = {
  readonly spaces: Pick<SpaceFeature, "commands" | "queries">;
  readonly workspaceRoot: string;
  readonly runContext?: ContextAttachmentRunContext;
  /**
   * These applications are required rather than optional fallbacks. Agent and
   * HTTP adapters must share admission, lock-time revalidation and error facts;
   * reintroducing direct Feature/file mutations here creates a second policy.
   */
  readonly spaceReferenceContentApplication: SpaceReferenceContentApplication;
  readonly spaceReferenceLifecycleApplication: SpaceReferenceLifecycleApplication;
  /** Host-owned durable Space deletion workflow. */
  readonly deleteSpace?: (spaceId: string) => Promise<void>;
  /** Host-owned durable Conversation deletion workflow. */
  readonly deleteConversation?: (conversationId: string) => Promise<void>;
  /** Revocations observed since this run froze its grants. */
  readonly revocationOverlay?: SpaceRevocationOverlay;
  /** Shared application command for software-managed Space folders. */
  readonly managedSpaceFolderApplication?: ManagedSpaceFolderApplication<SpaceReferenceItem>;
  /** Filesystem source inspector; defaults to the real filesystem. */
  readonly externalSourceInspector?: SpaceExternalSourceInspector;
  /** Application command for atomically attaching a complete directory through an implicit Workspace. */
  readonly attachWorkspaceDirectory?: (input: {
    readonly spaceId: string;
    readonly path: string;
    readonly title: string;
    readonly actor: SpaceReferenceActorRecord;
    readonly annotation?: SpaceReferenceAnnotationInput;
  }) => Promise<SpaceReferenceItem>;
  /** Host composition for resolving a Space Workspace relationship to its current active mount. */
  readonly resolveWorkspaceDirectory?: (workspaceId: string) => Promise<{
    readonly path: string;
    readonly sourceIdentity: string;
    readonly mountVersion: string;
  } | undefined>;
};

/** All Agent-visible operations on the reference-only SpaceTree feature. */
export function createSpaceTools(options: SpaceToolOptions): readonly ToolExecutor[] {
  const tools = [
    createSpaceListTool(options),
    createSpaceCreateTool(options),
    createSpaceDeleteTool(options),
    createConversationDeleteTool(options),
    createSpaceMoveTool(options),
    createSpaceAddReferenceTool(options),
    createSpaceMountLocalPathTool(options),
    createSpaceCreateManagedFolderTool(options),
    createSpaceCreateEntryTool(options),
    createSpaceRenameEntryTool(options),
    createSpaceDeleteEntryTool(options),
    createSpaceUpdateCaptionTool(options),
    createSpaceReadReferenceTool(options),
    createSpaceUpdateReferenceAnnotationTool(options),
    createSpaceUnlinkReferenceTool(options),
    createSpaceRemoveReferenceTool(options),
    createSpaceRenameTool(options),
  ];
  // File I/O stays on the mature Read/Glob/Grep/Write/Edit executors. The Host
  // injects Space path authority into those tools, avoiding a second file API.
  return tools;
}

/** Host-selected contribution; it does not create a registry or make visibility decisions. */
export function createSpaceToolRegistryContribution(options: SpaceToolOptions): AgentToolRegistryContribution {
  return (register) => {
    for (const executor of createSpaceTools(options)) {
      register({ executor, scopes: ["agent-basic"], enabledByDefault: true });
    }
  };
}

export function createSpaceListTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceList",
    description: "List the user's Spaces and their folder/reference counts, or read one SpaceTree when spaceId is provided. Tree entries are model projections: source identities and audit fields are never returned.",
    metadata: readMetadata,
    inputSchema: { type: "object", properties: { spaceId: { type: "string", description: "Optional Space id to read as a tree." } } },
    execute: async (input) => {
      const spaceId = stringOrUndefined(asRecord(input).spaceId);
      if (spaceId === undefined) return { status: "listed", spaces: await options.spaces.queries.list() };
      const tree = await options.spaces.queries.getTree(spaceId);
      if (tree === undefined) return { status: "space_not_found", spaceId };
      return {
        status: "found",
        tree: {
          space: tree.space,
          entries: tree.entries.map((entry) => ({ kind: "reference" as const, item: spaceReferenceModelView(entry.item) })),
        },
      };
    },
  });
}

export function createSpaceCreateTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceCreate",
    description: "Create an empty top-level Space for organizing references. It does not create a local directory or external resource.",
    metadata: writeMetadata,
    inputSchema: requiredSchema({ title: { type: "string", description: "Visible Space title." } }, ["title"]),
    execute: async (input) => {
      const title = stringOrUndefined(asRecord(input).title);
      if (title === undefined) return invalid("title must be a string.");
      return resultFor(() => options.spaces.commands.createSpace({ title }), (space) => ({ status: "created", space }));
    },
  });
}

export function createSpaceDeleteTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceDelete",
    description: "Delete a Space and its Space-owned materials and Conversations. External files and folders are only unlinked; their source content is preserved.",
    metadata: destructiveMetadata,
    inputSchema: requiredSchema({ spaceId: { type: "string", minLength: 1 } }, ["spaceId"]),
    execute: async (input) => {
      const spaceId = stringOrUndefined(asRecord(input).spaceId);
      if (spaceId === undefined) return invalid("spaceId must be a string.");
      if (options.deleteSpace === undefined) return { status: "space_delete_unavailable", spaceId, message: "The Host Space deletion coordinator is not available." };
      return resultFor(() => options.deleteSpace!(spaceId), () => ({ status: "deleted", spaceId }));
    },
  });
}

export function createConversationDeleteTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "ConversationDelete",
    description: "Delete a Conversation and its Space owner link. This is irreversible for the Conversation history and requires confirmation.",
    metadata: destructiveMetadata,
    inputSchema: requiredSchema({ conversationId: { type: "string", minLength: 1 } }, ["conversationId"]),
    execute: async (input) => {
      const conversationId = stringOrUndefined(asRecord(input).conversationId);
      if (conversationId === undefined) return invalid("conversationId must be a string.");
      if (options.deleteConversation === undefined) return { status: "conversation_delete_unavailable", conversationId, message: "The Host Conversation deletion coordinator is not available." };
      return resultFor(() => options.deleteConversation!(conversationId), () => ({ status: "deleted", conversationId }));
    },
  });
}

export function createSpaceMoveTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceMove",
    description: "Move a Space-owned material to another Space. External file/folder references and Conversation owners cannot be moved; web pages and generated artifacts may retain metadata-only moves.",
    metadata: writeMetadata,
    inputSchema: requiredSchema({
      targetKind: { type: "string", enum: ["reference"] }, targetId: { type: "string" }, destinationSpaceId: { type: "string" },
    }, ["targetKind", "targetId", "destinationSpaceId"]),
    execute: async (input) => {
      const record = asRecord(input);
      const target = movableTarget(record.targetKind, record.targetId);
      const destinationSpaceId = stringOrUndefined(record.destinationSpaceId);
      if (target === undefined || destinationSpaceId === undefined) return invalid("targetKind, targetId and destinationSpaceId are required strings.");
      const item = await options.spaces.queries.getReference(target.id);
      if (item === undefined) return { status: "space_reference_not_found", itemId: target.id };
      if (!isMovableSpaceMaterial(item.reference)) {
        return {
          status: "space_reference_move_unavailable",
          itemId: target.id,
          referenceKind: item.reference.kind,
          message: "External file/folder references and Conversation owners cannot be moved.",
        };
      }
      return resultFor(
        () => options.spaceReferenceLifecycleApplication.move({
          sourceSpaceId: item.spaceId,
          target: { kind: "reference", id: target.id },
          destinationSpaceId,
        }).then(() => undefined),
        () => ({ status: "moved", target, destinationSpaceId }),
      );
    },
  });
}

export function createSpaceAddReferenceTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceAddReference",
    description: "Add an external file/folder reference or Space material from the current run-context attachment. Select local files and folders by attachmentId from AttachmentList; raw local paths are not accepted. Conversation owners are created only by the conversation workflow. annotation is the Agent-maintained understanding of the source, never the source body: when the source needs understanding, read it first with the existing reading tools, then submit your own summary, key points and tags; do not fabricate content without reading the source. This tool never fetches web pages or files implicitly.",
    metadata: writeMetadata,
    inputSchema: requiredSchema({
      spaceId: { type: "string" }, title: { type: "string" }, reference: referenceSchema, annotation: annotationSchema,
    }, ["spaceId", "title", "reference"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const spaceId = stringOrUndefined(record.spaceId);
      const title = stringOrUndefined(record.title);
      if (spaceId === undefined || title === undefined) return invalid("spaceId, title and a valid reference are required.");
      const resolution = await resolveAgentSpaceReference(record.reference, options);
      if ("error" in resolution) return resolution.error;
      const annotation = parseAgentAnnotation(record.annotation);
      if (annotation === "invalid") return invalid("annotation must be an object with a markdown string.");
      const actor = agentActor(context);
      if ("workspacePath" in resolution) {
        if (options.attachWorkspaceDirectory === undefined) {
          return { status: "space_reference_source_unavailable", message: "Workspace attachment is unavailable in this environment." };
        }
        return resultFor(
          () => options.attachWorkspaceDirectory!({
            spaceId,
            path: resolution.workspacePath,
            title,
            actor,
            ...(annotation === undefined ? {} : { annotation }),
          }),
          (item) => ({ status: "added", item: spaceReferenceModelView(item), annotationStatus: item.annotation === undefined ? "missing" : "written" }),
        );
      }
      return resultFor(
        () => options.spaceReferenceLifecycleApplication.addReference({
          spaceId,
          title,
          reference: resolution.reference,
          actor,
          ...(annotation === undefined ? {} : { annotation }),
        }),
        (item) => ({ status: "added", item: spaceReferenceModelView(item), annotationStatus: item.annotation === undefined ? "missing" : "written" }),
      );
    },
  });
}

/**
 * 挂载用户明确给出的本地文件/文件夹引用。路径必须由用户在本轮对话中
 * 给出；确认框是授权落地点，工具绝不猜测或编造路径。登记后引用进入
 * 下一轮 run 的冻结授权，本轮文件工具尚不能写入该路径。
 */
export function createSpaceMountLocalPathTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceMountLocalPath",
    description: "Mount a local file or folder into a Space using an absolute path the user explicitly provided in this conversation. The run shows the exact path for user confirmation before registering; the tool never guesses or invents paths. The reference becomes readable and writable by file tools starting with the next run.",
    metadata: mountMetadata,
    inputSchema: requiredSchema({
      spaceId: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1, maxLength: 160 },
      targetKind: { type: "string", enum: ["file", "folder"], description: "Whether the path is a single file or a folder." },
      path: { type: "string", minLength: 1, description: "Absolute local path provided by the user." },
    }, ["spaceId", "title", "targetKind", "path"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const spaceId = stringOrUndefined(record.spaceId);
      const title = stringOrUndefined(record.title);
      const targetKind = stringOrUndefined(record.targetKind);
      const rawPath = stringOrUndefined(record.path);
      if (spaceId === undefined || title === undefined || (targetKind !== "file" && targetKind !== "folder") || rawPath === undefined) {
        return invalid("spaceId, title, targetKind and path are required.");
      }
      if (!path.isAbsolute(rawPath)) {
        return invalid("path must be an absolute local path provided by the user.");
      }
      const absolutePath = path.resolve(rawPath);
      const inspect = options.externalSourceInspector ?? inspectSpaceExternalSource;
      const snapshot = await inspect(absolutePath);
      const expectedKind = targetKind === "file" ? "file" : "folder";
      if (snapshot === undefined || snapshot.kind !== expectedKind) {
        return {
          status: "space_reference_source_unavailable",
          path: absolutePath,
          message: `No ${targetKind} exists at ${absolutePath}. Ask the user to verify the path before retrying.`,
        };
      }
      if (targetKind === "folder" && options.attachWorkspaceDirectory === undefined) {
        return { status: "space_reference_source_unavailable", path: absolutePath, message: "Workspace registration is unavailable in this environment." };
      }
      return resultFor(
        () => targetKind === "folder"
          ? options.attachWorkspaceDirectory!({ spaceId, path: absolutePath, title, actor: agentActor(context) })
          : options.spaceReferenceLifecycleApplication.addReference({ spaceId, title, reference: { kind: "local_file", path: absolutePath }, actor: agentActor(context) }),
        (item) => ({
          status: "added",
          item: spaceReferenceModelView(item),
          annotationStatus: item.annotation === undefined ? "missing" : "written",
          note: "The reference is registered. File tools of the current run cannot write into it yet; it becomes readable and writable starting with the next run.",
        }),
      );
    },
  });
}

/** 在 Host 托管存储根下创建软件自有文件夹并登记为 managed_folder 引用。 */
export function createSpaceCreateManagedFolderTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceCreateManagedFolder",
    description: "Create a software-managed folder inside a Space. Managed folders are software-owned directories under the Space storage root; entries inside them are managed through Space tools and the workbench. The title becomes the reference title.",
    metadata: writeMetadata,
    inputSchema: requiredSchema({
      spaceId: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1, maxLength: 160 },
    }, ["spaceId", "title"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const spaceId = stringOrUndefined(record.spaceId);
      const title = stringOrUndefined(record.title);
      if (spaceId === undefined || title === undefined) return invalid("spaceId and title are required.");
      if (options.managedSpaceFolderApplication === undefined) {
        return { status: "space_managed_folder_unavailable", spaceId, message: "The Host managed Space folder storage is not available in this environment." };
      }
      return resultFor(async () => {
        return await options.managedSpaceFolderApplication!.create({
          spaceId,
          title,
          actor: agentActor(context),
        });
      }, (item) => ({ status: "created", item: spaceReferenceModelView(item) }));
    },
  });
}

/** 在 Workspace / managed_folder 引用根内新建文件或目录条目。 */
export function createSpaceCreateEntryTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceCreateEntry",
    description: "Create a new file or directory entry inside a Space workspace folder or managed folder reference. The entry is created under the reference root; only entries inside the root are allowed.",
    metadata: writeMetadata,
    inputSchema: requiredSchema({
      itemId: { type: "string", minLength: 1 },
      parentRelativePath: { type: "string", description: "Parent directory relative to the reference root; empty string for the root itself." },
      name: { type: "string", minLength: 1, maxLength: 255 },
      kind: { type: "string", enum: ["file", "directory"] },
    }, ["itemId", "parentRelativePath", "name", "kind"]),
    execute: async (input) => {
      const record = asRecord(input);
      const itemId = stringOrUndefined(record.itemId);
      const parentRelativePath = typeof record.parentRelativePath === "string" ? record.parentRelativePath.trim() : undefined;
      const name = stringOrUndefined(record.name);
      const kind = stringOrUndefined(record.kind);
      if (itemId === undefined || parentRelativePath === undefined || name === undefined || (kind !== "file" && kind !== "directory")) {
        return invalid("itemId, parentRelativePath, name and kind are required.");
      }
      if (!validEntryName(name)) return invalid("name is invalid.");
      const relativePath = joinEntryPath(parentRelativePath, name);
      if (relativePath === undefined) return invalid("parentRelativePath is invalid.");
      return resultFor(
        () => options.spaceReferenceContentApplication.createEntry({ itemId, parentRelativePath, name, kind }),
        (result) => ({ status: "created", itemId, relativePath: result.relativePath }),
      );
    },
  });
}

/** 重命名 Workspace / managed_folder 引用根内的文件或目录条目。 */
export function createSpaceRenameEntryTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceRenameEntry",
    description: "Rename a file or directory entry inside a Space workspace folder or managed folder reference. Only entries inside the reference root can be renamed.",
    metadata: writeMetadata,
    inputSchema: requiredSchema({
      itemId: { type: "string", minLength: 1 },
      relativePath: { type: "string", minLength: 1, description: "Entry path relative to the reference root." },
      name: { type: "string", minLength: 1, maxLength: 255, description: "New entry name within the same parent directory." },
    }, ["itemId", "relativePath", "name"]),
    execute: async (input) => {
      const record = asRecord(input);
      const itemId = stringOrUndefined(record.itemId);
      const relativePath = stringOrUndefined(record.relativePath);
      const name = stringOrUndefined(record.name);
      if (itemId === undefined || relativePath === undefined || name === undefined) {
        return invalid("itemId, relativePath and name are required.");
      }
      if (relativePath.length === 0) return invalid("relativePath cannot be the reference root.");
      if (!validEntryName(name)) return invalid("name is invalid.");
      return resultFor(
        () => options.spaceReferenceContentApplication.renameEntry({ itemId, relativePath, name }),
        (result) => ({ status: "renamed", itemId, relativePath: result.relativePath }),
      );
    },
  });
}

/** 删除 Workspace / managed_folder 引用根内的文件或目录条目。 */
export function createSpaceDeleteEntryTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceDeleteEntry",
    description: "Delete a file or directory entry inside a Space workspace folder or managed folder reference. Directory deletion is recursive; the reference root itself cannot be deleted.",
    metadata: destructiveMetadata,
    inputSchema: requiredSchema({
      itemId: { type: "string", minLength: 1 },
      relativePath: { type: "string", minLength: 1, description: "Entry path relative to the reference root." },
    }, ["itemId", "relativePath"]),
    execute: async (input) => {
      const record = asRecord(input);
      const itemId = stringOrUndefined(record.itemId);
      const relativePath = stringOrUndefined(record.relativePath);
      if (itemId === undefined || relativePath === undefined) return invalid("itemId and relativePath are required.");
      if (relativePath.length === 0) return invalid("relativePath cannot be the reference root.");
      return resultFor(
        async () => { await options.spaceReferenceContentApplication.deleteEntry({ itemId, relativePath }); return { status: "deleted", itemId, relativePath }; },
        (result) => result,
      );
    },
  });
}

/** 更新空间引用图片的 Agent 维护说明（caption）。 */
export function createSpaceUpdateCaptionTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceUpdateCaption",
    description: "Update the caption of an image inside a Space local file, workspace folder or managed folder reference. Only image entries support captions.",
    metadata: writeMetadata,
    inputSchema: requiredSchema({
      itemId: { type: "string", minLength: 1 },
      relativePath: { type: "string", description: "Image path relative to the reference root; empty string for a local file reference." },
      caption: { type: "string", maxLength: 16 * 1024 },
    }, ["itemId", "relativePath", "caption"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const itemId = stringOrUndefined(record.itemId);
      const relativePath = typeof record.relativePath === "string" ? record.relativePath.trim() : undefined;
      const caption = stringOrUndefined(record.caption);
      if (itemId === undefined || relativePath === undefined || caption === undefined) {
        return invalid("itemId, relativePath and caption are required.");
      }
      if (relativePath.length > 4_096) return invalid("relativePath is too long.");
      const item = await options.spaces.queries.getReference(itemId);
      if (item === undefined) return { status: "space_reference_not_found", itemId };
      if (item.reference.kind !== "local_file"
        && item.reference.kind !== "workspace"
        && item.reference.kind !== "managed_folder") {
        return { status: "space_reference_caption_unavailable", itemId, message: "Only file and folder references can own image captions." };
      }
      if (item.reference.kind === "local_file" && relativePath.length > 0) {
        return invalid("A local file reference caption must use the root path.");
      }
      const workspaceCurrent = item.reference.kind !== "workspace"
        || await options.resolveWorkspaceDirectory?.(item.reference.workspaceId) !== undefined;
      if (!workspaceCurrent) {
        return { status: "space_reference_source_missing", itemId, message: "The source path no longer exists or was replaced." };
      }
      const expectedRevision = item.imageCaptions?.[relativePath]?.revision ?? 0;
      return resultFor(
        () => options.spaceReferenceContentApplication.updateCaption({
          itemId,
          update: { relativePath, expectedFingerprint: `space-image-caption:${expectedRevision}`, caption },
          actor: agentActor(context),
        }),
        () => ({ status: "updated", itemId, revision: expectedRevision + 1 }),
      );
    },
  });
}

const mountMetadata = { category: "workspace", riskLevel: "medium", operationType: "read-write", requiresConfirmation: true } as const;

export function createSpaceReadReferenceTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceReadReference",
    description: "Read one Space reference: its source fact and the current Agent-maintained annotation (markdown, key points, tags, revision). This tool only reads what the Space saved; it never connects to the web, refreshes a source, or reads external file content. Source content stays on WebFetch, AttachmentRead, AttachmentReadImage and file tools.",
    metadata: readMetadata,
    inputSchema: requiredSchema({ itemId: { type: "string" } }, ["itemId"]),
    execute: async (input) => {
      const itemId = stringOrUndefined(asRecord(input).itemId);
      if (itemId === undefined) return invalid("itemId must be a string.");
      const item = await options.spaces.queries.getReference(itemId);
      return item === undefined ? { status: "space_reference_not_found", itemId } : { status: "found", item: spaceReferenceModelView(item) };
    },
  });
}

export function createSpaceUpdateReferenceAnnotationTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceUpdateReferenceAnnotation",
    description: "Update the Agent-maintained annotation of one Space reference with an expectedRevision read from SpaceReadReference. Provided content fields replace their current values; absent fields are kept unchanged. It never refetches the source: reading the source again is a separate Agent decision using WebFetch or file tools. Returns the complete current annotation after a successful update.",
    metadata: writeMetadata,
    inputSchema: requiredSchema({
      itemId: { type: "string" },
      expectedRevision: { type: "number", description: "Current revision read from SpaceReadReference." },
      ...annotationContentProperties,
    }, ["itemId", "expectedRevision"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const itemId = stringOrUndefined(record.itemId);
      const expectedRevision = typeof record.expectedRevision === "number" ? record.expectedRevision : undefined;
      if (itemId === undefined || expectedRevision === undefined || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
        return invalid("itemId and a non-negative integer expectedRevision are required.");
      }
      const item = await options.spaces.queries.getReference(itemId);
      if (item === undefined) return { status: "space_reference_not_found", itemId };
      const patch = annotationPatchFromRecord(record);
      if (patch === undefined) return invalid("At least one content field (markdown, keyPoints or tags) is required.");
      return resultFor(
        () => options.spaceReferenceContentApplication.updateAnnotation({ itemId, expectedRevision, patch, actor: agentActor(context) }),
        (updated) => ({ status: "updated", item: spaceReferenceModelView(updated) }),
      );
    },
  });
}

export function createSpaceUnlinkReferenceTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceUnlinkReference",
    description: "Remove an external file, folder, web page, or generated artifact reference while preserving its source. Space-owned materials use their own deletion workflows.",
    metadata: writeMetadata,
    inputSchema: requiredSchema({ itemId: { type: "string" } }, ["itemId"]),
    execute: async (input) => {
      const itemId = stringOrUndefined(asRecord(input).itemId);
      if (itemId === undefined) return invalid("itemId must be a string.");
      const item = await options.spaces.queries.getReference(itemId);
      if (item === undefined) return { status: "space_reference_not_found", itemId };
      if (!isExternalReference(item.reference)) {
        return {
          status: "space_reference_unlink_unavailable",
          itemId,
          referenceKind: item.reference.kind,
          message: "Space-owned materials must be deleted through their material workflow.",
        };
      }
      return resultFor(
        () => options.spaceReferenceLifecycleApplication.unlink({ itemId }),
        () => ({ status: "unlinked", itemId }),
      );
    },
  });
}

export function createSpaceRemoveReferenceTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceRemoveReference",
    description: "Delete a Space-owned material and remove its Space metadata. External files, folders, web pages, and generated artifacts cannot be physically deleted by this tool.",
    metadata: destructiveMetadata,
    inputSchema: requiredSchema({ itemId: { type: "string" } }, ["itemId"]),
    execute: async (input) => {
      const itemId = stringOrUndefined(asRecord(input).itemId);
      if (itemId === undefined) return invalid("itemId must be a string.");
      const item = await options.spaces.queries.getReference(itemId);
      if (item === undefined) return { status: "space_reference_not_found", itemId };
      if (!isSpaceOwnedMaterial(item.reference)) {
        return {
          status: "reference_delete_unavailable",
          itemId,
          referenceKind: item.reference.kind,
          message: "This external reference can only be unlinked; its source cannot be deleted by SpaceRemoveReference.",
        };
      }
      return resultFor(
        () => options.spaceReferenceLifecycleApplication.remove({ itemId }),
        () => ({ status: "removed", itemId }),
      );
    },
  });
}

export function createSpaceRenameTool(options: SpaceToolOptions): ToolExecutor {
  return tool({
    name: "SpaceRename",
    description: "Rename a Space or a top-level reference display label. It does not rename the referenced filesystem object.",
    metadata: writeMetadata,
    inputSchema: requiredSchema({ targetKind: { type: "string", enum: ["space", "reference"] }, targetId: { type: "string" }, title: { type: "string" } }, ["targetKind", "targetId", "title"]),
    execute: async (input) => {
      const record = asRecord(input);
      const target = targetFrom(record.targetKind, record.targetId);
      const title = stringOrUndefined(record.title);
      if (target === undefined || title === undefined) return invalid("targetKind, targetId and title must be strings.");
      const spaceId = target.kind === "space" ? target.id : await (async () => {
        const item = await options.spaces.queries.getReference(target.id);
        return item === undefined ? undefined : item.spaceId;
      })();
      if (spaceId === undefined) return { status: "space_reference_not_found", itemId: target.id };
      return resultFor(
        () => options.spaceReferenceLifecycleApplication.rename({ target, title }).then(() => undefined),
        () => ({ status: "renamed", target, title }),
      );
    },
  });
}

type ToolSpec = {
  readonly name: string;
  readonly description: string;
  readonly metadata: NonNullable<ToolDefinition["metadata"]>;
  readonly inputSchema: ToolDefinition["inputSchema"];
  readonly execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
};
function tool(spec: ToolSpec): ToolExecutor {
  return {
    definition: {
      name: spec.name,
      description: spec.description,
      metadata: spec.metadata,
      inputSchema: spec.inputSchema,
    },
    execute: (input: unknown, context: ToolExecutionContext) => spec.execute(input, context),
  };
}

const readMetadata = { category: "workspace", riskLevel: "low", operationType: "read-only", requiresConfirmation: false } as const;
const writeMetadata = { category: "workspace", riskLevel: "low", operationType: "read-write", requiresConfirmation: false } as const;
const destructiveMetadata = { category: "workspace", riskLevel: "high", operationType: "read-write", requiresConfirmation: true, fileOperation: "delete" } as const;

function requiredSchema(properties: ToolDefinition["inputSchema"]["properties"], required: readonly string[]): ToolDefinition["inputSchema"] {
  return { type: "object" as const, properties, required };
}

const referenceSchema: ToolJsonSchema = {
  type: "object",
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "local_attachment" },
        attachmentId: { type: "string", minLength: 1, description: "Current run-context attachment id returned by AttachmentList." },
      },
      required: ["kind", "attachmentId"],
      additionalProperties: false,
    },
    { type: "object", properties: { kind: { const: "web_page" }, url: { type: "string", format: "uri" } }, required: ["kind", "url"], additionalProperties: false },
  ],
};

const annotationContentProperties: Record<string, ToolJsonSchemaValue> = {
  markdown: { type: "string", minLength: 1, maxLength: 512 * 1024, description: "Agent 对来源的整理内容 Markdown，不是来源正文。" },
  keyPoints: { type: "array", items: { type: "string", minLength: 1, maxLength: 512 }, maxItems: 32, description: "关键要点列表。" },
  tags: { type: "array", items: { type: "string", minLength: 1, maxLength: 64 }, maxItems: 32, description: "标签列表。" },
};

const annotationSchema: ToolJsonSchema = {
  type: "object",
  properties: annotationContentProperties,
  required: ["markdown"],
  additionalProperties: false,
};

/**
 * 解析 Agent 提交的 annotation 输入。返回 undefined 表示未提供
 * （允许保存来源引用但不生成注释），返回 "invalid" 表示提供了但结构非法。
 */
function parseAgentAnnotation(value: unknown): SpaceReferenceAnnotationInput | "invalid" | undefined {
  const record = asOptionalRecord(value);
  if (record === undefined) return undefined;
  const markdown = stringOrUndefined(record.markdown);
  if (markdown === undefined || markdown.length === 0) return "invalid";
  const keyPoints = optionalStringArray(record.keyPoints);
  const tags = optionalStringArray(record.tags);
  if (keyPoints === "invalid" || tags === "invalid") return "invalid";
  return { markdown, ...(keyPoints === undefined || keyPoints.length === 0 ? {} : { keyPoints }), ...(tags === undefined || tags.length === 0 ? {} : { tags }) };
}

/** 从更新输入组装 patch；只包含真正出现的字段，未提供字段保持原值。 */
function annotationPatchFromRecord(record: Readonly<Record<string, unknown>>): SpaceReferenceAnnotationPatch | undefined {
  const markdown = stringOrUndefined(record.markdown);
  const keyPoints = optionalStringArray(record.keyPoints);
  const tags = optionalStringArray(record.tags);
  if (keyPoints === "invalid" || tags === "invalid") return undefined;
  if (markdown === undefined && keyPoints === undefined && tags === undefined) return undefined;
  return {
    ...(markdown === undefined ? {} : { markdown }),
    ...(keyPoints === undefined ? {} : { keyPoints }),
    ...(tags === undefined ? {} : { tags }),
  };
}

function optionalStringArray(value: unknown): readonly string[] | "invalid" | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) return "invalid";
  return value as string[];
}

function invalid(message: string) { return { status: "invalid_input", message }; }

/**
 * Deny set layered over the run's frozen grants. It records only references
 * observed being revoked, because "absent from this Space" cannot distinguish a
 * revoked reference from one that was never there, and denying on absence alone
 * would reject legitimate writes.
 */
export type SpaceRevocationOverlay = {
  has(referenceId: string): boolean;
  assertReadAllowed(attachmentId: string): void;
};

/** Accumulates live revocations so in-flight runs cannot reuse removed references. */
export function createSpaceRevocationOverlay(
  events: Pick<SpaceFeature, "events">["events"],
): SpaceRevocationOverlay & { dispose(): void } {
  const revoked = new Set<string>();
  const unsubscribe = events.subscribe((event) => {
    if (event.type === "space.reference_removed") {
      revoked.add(event.itemId);
      for (const id of event.removedItemIds) revoked.add(id);
    } else if (event.type === "space.deleted") {
      for (const id of event.removedReferenceIds) revoked.add(id);
    }
  });
  return {
    has: (referenceId) => revoked.has(referenceId),
    assertReadAllowed(attachmentId) {
      const referenceId = spaceReferenceIdFromAttachmentId(attachmentId);
      if (referenceId !== undefined && revoked.has(referenceId)) {
        throw new Error(`Space reference ${referenceId} was revoked and is no longer readable.`);
      }
    },
    dispose: unsubscribe,
  };
}

function targetFrom(kind: unknown, id: unknown): SpaceTarget | undefined {
  const targetKind = stringOrUndefined(kind);
  const targetId = stringOrUndefined(id);
  if (targetId === undefined || (targetKind !== "space" && targetKind !== "reference")) return undefined;
  return { kind: targetKind, id: targetId };
}

function movableTarget(kind: unknown, id: unknown): { readonly kind: "reference"; readonly id: string } | undefined {
  const target = targetFrom(kind, id);
  return target?.kind === "reference" ? { kind: "reference", id: target.id } : undefined;
}

type AgentSpaceReferenceResolution =
  | { readonly reference: SpaceDirectReference }
  | { readonly workspacePath: string }
  | { readonly error: Readonly<Record<string, unknown>> };

async function resolveAgentSpaceReference(
  value: unknown,
  options: SpaceToolOptions,
): Promise<AgentSpaceReferenceResolution> {
  const record = asOptionalRecord(value);
  if (record === undefined) return { error: invalid("spaceId, title and a valid reference are required.") };
  const kind = stringOrUndefined(record.kind);
  if (kind === "local_attachment") {
    const attachmentId = stringOrUndefined(record.attachmentId);
    if (attachmentId === undefined) return { error: invalid("local_attachment requires attachmentId from AttachmentList.") };
    const attachment = attachmentEntries(options.runContext).find((entry) => entry.attachmentId === attachmentId);
    if (attachment === undefined) {
      return {
        error: {
          status: "space_reference_attachment_not_found",
          attachmentId,
          message: "No current run-context attachment matched this attachmentId.",
        },
      };
    }
    if (!attachment.authorized) {
      return {
        error: {
          status: "space_reference_attachment_not_authorized",
          attachmentId,
          message: "The selected attachment is not authorized for reading in this run.",
        },
      };
    }
    try {
      const target = await resolveAttachmentTarget({
        entry: attachment,
        workspaceRoot: options.workspaceRoot,
        requireFile: false,
        projectPathRequired: false,
      });
      if (target.rootKind !== "file" && options.attachWorkspaceDirectory === undefined) {
        return { error: { status: "space_reference_source_unavailable", message: "Workspace registration is unavailable in this environment." } };
      }
      return {
        ...(target.rootKind === "file"
          ? { reference: { kind: "local_file" as const, path: target.rootAbsolutePath } }
          : { workspacePath: target.rootAbsolutePath }),
      };
    } catch (error) {
      return {
        error: {
          status: "space_reference_attachment_unsupported",
          attachmentId,
          message: error instanceof Error ? error.message : "The selected attachment is not a local file or folder.",
        },
      };
    }
  }
  if (kind === "web_page" && stringOrUndefined(record.url) !== undefined) return { reference: { kind, url: stringOrUndefined(record.url)! } };
  return { error: invalid("spaceId, title and a valid reference are required.") };
}

function isExternalReference(reference: SpaceReference): boolean {
  return reference.kind === "local_file" ||
    reference.kind === "workspace" ||
    reference.kind === "web_page" ||
    reference.kind === "generated_artifact";
}

function isSpaceOwnedMaterial(reference: SpaceReference): boolean {
  return !isExternalReference(reference);
}

function isMovableSpaceMaterial(reference: SpaceReference): boolean {
  return reference.kind !== "local_file" && reference.kind !== "workspace";
}

async function resultFor<T>(operation: () => Promise<T>, project: (value: T) => unknown): Promise<unknown> {
  try {
    return project(await operation());
  } catch (error) {
    if (error instanceof SpaceReferenceContentApplicationError) {
      return { status: error.code, message: error.message };
    }
    if (error instanceof SpaceFeatureError && isExpectedSpaceOperationError(error.code)) {
      return { status: error.code, message: error.message };
    }
    throw error;
  }
}

function isExpectedSpaceOperationError(code: SpaceFeatureError["code"]): boolean {
  return code === "space_not_found"
    || code === "space_reference_not_found"
    || code === "space_reference_membership_changed"
    || code === "space_invalid_move"
    || code === "space_invalid_input"
    || code === "space_id_collision"
    || code === "space_workspace_mount_conflict"
    || code === "space_asset_ownership_conflict"
    || code === "space_reference_annotation_invalid"
    || code === "space_reference_annotation_revision_conflict"
    || code === "space_reference_annotation_too_large"
    || code === "space_reference_image_caption_invalid"
    || code === "space_reference_image_caption_revision_conflict"
    || code === "space_reference_image_caption_too_large";
}

function validEntryName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 255 && trimmed !== "." && trimmed !== ".." && !/[\\/:*?"<>|]/u.test(trimmed);
}

function joinEntryPath(parent: string, name: string): string | undefined {
  const parentPath = normalizeEntryPath(parent);
  if (parentPath === undefined) return undefined;
  const parts = parentPath.length === 0 ? [name] : [...parentPath.split("/"), name];
  return parts.join("/");
}

function normalizeEntryPath(value: string): string | undefined {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (normalized === "" || normalized === ".") return "";
  if (normalized.split("/").some((part) => part === "." || part === ".." || part.length === 0)) return undefined;
  return normalized;
}

/**
 * 模型可读的引用投影。只暴露 Agent 完成任务需要的事实：
 * itemId/spaceId/title/reference/annotation/时间，绝不暴露
 * `sourceIdentity` 等平台身份字段（它们只属于后端授权、审计与持久化层）。
 */
export type SpaceReferenceModelView = {
  readonly itemId: string;
  readonly spaceId: string;
  readonly title: string;
  readonly parentId?: string;
  readonly reference: SpaceReference;
  readonly annotation?: SpaceReferenceAnnotationModelView;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** 模型可读的 annotation 投影：内容与版本事实，不包含 actor 审计字段。 */
export type SpaceReferenceAnnotationModelView = {
  readonly markdown: string;
  readonly keyPoints?: readonly string[];
  readonly tags?: readonly string[];
  readonly revision: number;
  readonly updatedAt: string;
  readonly updatedBy: SpaceReferenceAnnotation["updatedBy"];
};

export function spaceReferenceModelView(item: SpaceReferenceItem): SpaceReferenceModelView {
  return {
    itemId: item.id,
    spaceId: item.spaceId,
    title: item.title,
    ...(item.parentId === undefined ? {} : { parentId: item.parentId }),
    reference: item.reference,
    ...(item.annotation === undefined ? {} : { annotation: spaceReferenceAnnotationModelView(item.annotation) }),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** 审计字段（actor/traceId/goalId/toolCallId）只留在持久化与后台查询，不进入模型可见输出。 */
export function spaceReferenceAnnotationModelView(
  annotation: SpaceReferenceAnnotation,
): SpaceReferenceAnnotationModelView {
  return {
    markdown: annotation.markdown,
    ...(annotation.keyPoints === undefined ? {} : { keyPoints: annotation.keyPoints }),
    ...(annotation.tags === undefined ? {} : { tags: annotation.tags }),
    revision: annotation.revision,
    updatedAt: annotation.updatedAt,
    updatedBy: annotation.updatedBy,
  };
}

/** 工具执行者恒为 Agent：把 ToolExecutionContext 映射为完整审计 actor。 */
function agentActor(context: ToolExecutionContext): SpaceReferenceActorRecord {
  return {
    kind: "agent",
    actorId: context.callerAgentId,
    ...(context.traceId === undefined ? {} : { traceId: context.traceId }),
    ...(context.goalId === undefined ? {} : { goalId: context.goalId }),
    ...(context.providerCallId === undefined ? {} : { toolCallId: context.providerCallId }),
  };
}
