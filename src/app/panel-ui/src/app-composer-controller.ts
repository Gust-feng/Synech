import type React from "react";
import {
  discardManagedUploadAttachment,
  isManagedUploadAttachment,
  selectLocalContextAttachment,
  uniqueAttachments,
  uploadContextAttachmentFiles,
} from "./app-attachments";
import { ApiError } from "./api";
import type { ComposerToolConfirmationPolicy } from "./app-config-projection";
import type { AppState } from "./app-state";
import type { ContextAttachment } from "./contracts/context";

export type AppComposerController = {
  readonly selectInputModel: (modelOptionId: string) => void;
  readonly selectAttachment: () => Promise<void>;
  readonly uploadAttachments: (files: readonly File[]) => Promise<void>;
  readonly removeAttachment: (attachmentId: string) => Promise<void>;
  readonly changeToolConfirmationPolicy: (nextPolicy: ComposerToolConfirmationPolicy) => void;
};

export type AppComposerControllerOptions = {
  readonly setApp: React.Dispatch<React.SetStateAction<AppState>>;
  readonly mountedRef: React.MutableRefObject<boolean>;
  readonly contextBusy: boolean;
  readonly setContextBusy: React.Dispatch<React.SetStateAction<boolean>>;
  readonly attachmentUploadAttemptRef: React.MutableRefObject<{ readonly key: string; readonly id: string } | undefined>;
  readonly setAttachments: React.Dispatch<React.SetStateAction<readonly ContextAttachment[]>>;
  readonly attachments?: readonly ContextAttachment[];
  readonly selectedModelId: string;
  readonly setComposerSelectedModelId: React.Dispatch<React.SetStateAction<string | undefined>>;
  readonly selectComposerModel: (modelOptionId: string) => Promise<void>;
  readonly toolConfirmationPolicy: ComposerToolConfirmationPolicy;
  readonly setToolConfirmationPolicy: React.Dispatch<React.SetStateAction<ComposerToolConfirmationPolicy>>;
  readonly saveToolConfirmationPolicy: (policy: ComposerToolConfirmationPolicy) => Promise<void>;
};

export function createAppComposerController(
  options: AppComposerControllerOptions,
): AppComposerController {
  function selectInputModel(modelOptionId: string): void {
    const fallbackModelId = options.selectedModelId;
    options.setComposerSelectedModelId(modelOptionId);
    void options.selectComposerModel(modelOptionId).catch(() => {
      if (!options.mountedRef.current) return;
      options.setComposerSelectedModelId((current) => current === modelOptionId ? fallbackModelId || undefined : current);
    });
  }

  async function selectAttachment(): Promise<void> {
    if (options.contextBusy) return;
    options.setContextBusy(true);
    try {
      const attachment = await selectLocalContextAttachment();
      if (options.mountedRef.current && attachment !== undefined) {
        options.setAttachments((previous) => uniqueAttachments([...previous, attachment]));
        options.setApp((previous) => ({ ...previous, error: undefined }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({ ...previous, error: errorText(error, "添加附件失败。") }));
      }
    } finally {
      if (options.mountedRef.current) options.setContextBusy(false);
    }
  }

  async function uploadAttachments(files: readonly File[]): Promise<void> {
    if (options.contextBusy || files.length === 0) return;
    const requestKey = JSON.stringify(files.map((file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
    })));
    const existingAttempt = options.attachmentUploadAttemptRef.current;
    const uploadRequestId = existingAttempt?.key === requestKey
      ? existingAttempt.id
      : crypto.randomUUID();
    options.attachmentUploadAttemptRef.current = { key: requestKey, id: uploadRequestId };
    options.setContextBusy(true);
    try {
      const uploaded = await uploadContextAttachmentFiles(files, uploadRequestId);
      if (options.attachmentUploadAttemptRef.current?.id === uploadRequestId) {
        options.attachmentUploadAttemptRef.current = undefined;
      }
      if (!options.mountedRef.current) {
        await Promise.allSettled(uploaded.filter(isManagedUploadAttachment).map((attachment) =>
          discardManagedUploadAttachment(attachment.attachmentId)));
      } else if (uploaded.length > 0) {
        options.setAttachments((previous) => uniqueAttachments([...previous, ...uploaded]));
        options.setApp((previous) => ({ ...previous, error: undefined }));
      }
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 &&
        options.attachmentUploadAttemptRef.current?.id === uploadRequestId) {
        options.attachmentUploadAttemptRef.current = undefined;
      }
      if (options.mountedRef.current) {
        options.setApp((previous) => ({ ...previous, error: errorText(error, "上传附件失败。") }));
      }
    } finally {
      if (options.mountedRef.current) options.setContextBusy(false);
    }
  }

  async function removeAttachment(attachmentId: string): Promise<void> {
    const attachment = options.attachments?.find((candidate) => candidate.attachmentId === attachmentId);
    options.setAttachments((previous) => previous.filter((candidate) => candidate.attachmentId !== attachmentId));
    if (attachment === undefined || !isManagedUploadAttachment(attachment)) return;
    try {
      await discardManagedUploadAttachment(attachmentId);
    } catch (error) {
      if (!options.mountedRef.current) return;
      options.setAttachments((previous) => uniqueAttachments([...previous, attachment]));
      options.setApp((previous) => ({ ...previous, error: errorText(error, "移除附件失败。") }));
    }
  }

  function changeToolConfirmationPolicy(nextPolicy: ComposerToolConfirmationPolicy): void {
    const previousPolicy = options.toolConfirmationPolicy;
    options.setToolConfirmationPolicy(nextPolicy);
    void options.saveToolConfirmationPolicy(nextPolicy)
      .catch(() => {
        if (!options.mountedRef.current) return;
        options.setToolConfirmationPolicy(previousPolicy);
      });
  }

  return {
    selectInputModel,
    selectAttachment,
    uploadAttachments,
    removeAttachment,
    changeToolConfirmationPolicy,
  };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}