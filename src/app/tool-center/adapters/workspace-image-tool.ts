import path from "node:path";
import { imageMimeTypeForExtension } from "../../local-filesystem/index.js";
import { toolOutputWithAttachments, type ToolExecutor } from "../../../domain/tools/index.js";
import {
  asRecord, authorizedPathFacts, runAuthorizedWorkspaceAccess, stringOrFallback,
  type LocalWorkspaceToolOptions,
} from "./local-workspace-common.js";
import { InMemoryLocalWorkspaceMutationCoordinator } from "./local-workspace-mutation-coordinator.js";
import { assertSandboxAllowed, createLocalWorkspaceSandboxPolicy, sandboxRequest } from "./local-workspace-sandbox.js";
import { imageDetailFromUnknown, readImageInput } from "./image-input.js";

/** Uses the same live path authority as Read; images remain explicit model inputs. */
export function createWorkspaceImageTool(
  rootDirectory: string,
  options: LocalWorkspaceToolOptions & { readonly supportsVisionInput?: boolean } = {},
): ToolExecutor {
  const sandboxPolicy = options.sandboxPolicy ?? createLocalWorkspaceSandboxPolicy();
  const coordinator = options.mutationCoordinator ?? new InMemoryLocalWorkspaceMutationCoordinator();
  return {
    definition: {
      name: "ViewImage",
      description: "View an authorized workspace image by absolute or run-root-relative path as model vision input.",
      metadata: { category: "filesystem", riskLevel: "low", operationType: "read-only", requiresConfirmation: false },
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "Absolute or run-root-relative image path." },
          detail: { type: "string", enum: ["auto", "low", "high"], description: "Vision detail hint; defaults to auto." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async execute(value, context) {
      const record = asRecord(value);
      return runAuthorizedWorkspaceAccess({
        rootDirectory,
        requestedPath: stringOrFallback(record.path, ""),
        operation: "read",
        context,
        authorization: options.pathAuthorization,
        coordinator,
        access: async (target) => {
          assertSandboxAllowed(sandboxPolicy, sandboxRequest("read", target.rootDirectory, target.relativePath));
          const detail = imageDetailFromUnknown(record.detail);
          const mimeType = imageMimeTypeForExtension(path.extname(target.absolutePath).toLowerCase());
          const refId = `workspace:file:${target.relativePath}`;
          const image = await readImageInput({
            absolutePath: target.absolutePath, mimeType, supportsVisionInput: options.supportsVisionInput,
            detail, filename: path.basename(target.absolutePath), inputRef: refId, abortSignal: context.abortSignal,
          });
          const output = {
            refId, path: target.relativePath, ...authorizedPathFacts(target), mimeType,
            bytes: image.bytes, format: "image", readable: image.readable, detail,
            ...(image.readable ? {} : { reason: image.reason }),
          };
          return image.readable ? toolOutputWithAttachments(output, [image.attachment]) : output;
        },
      });
    },
  };
}
