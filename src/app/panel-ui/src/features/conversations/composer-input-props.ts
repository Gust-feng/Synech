import type { ComposerToolConfirmationPolicy } from "../settings/config-projection";
import type {
  ChatInputProps,
  ChatModelOption,
  ConversationFollowUpMode,
} from "../../contracts/composer";
import type { ContextAttachment } from "../../contracts/context";
import type { ContextWindowUsage } from "./context-window-usage";
import type { ModelRunReasoningEffort } from "@panel-api/config";

export type WorkbenchInputPropsOptions = {
  readonly goal: string;
  readonly setGoal: (value: string) => void;
  readonly attachments: readonly ContextAttachment[];
  readonly setAttachments: (attachments: readonly ContextAttachment[]) => void;
  readonly selectAttachment: () => void | Promise<void>;
  readonly uploadAttachments: (files: readonly File[]) => void | Promise<void>;
  readonly removeAttachment: (attachmentId: string) => void;
  readonly contextBusy: boolean;
  readonly busy: boolean;
  readonly models: readonly ChatModelOption[];
  readonly selectedModelId: string;
  readonly contextUsage?: ContextWindowUsage;
  readonly reasoningEffort: "" | ModelRunReasoningEffort;
  readonly reasoningEffortEnabled: boolean;
  readonly onReasoningEffortChange: (value: "" | ModelRunReasoningEffort) => void;
  readonly toolConfirmationPolicy: ComposerToolConfirmationPolicy;
  readonly onToolConfirmationPolicyChange: (value: ComposerToolConfirmationPolicy) => void;
  readonly closeSignal: number;
  readonly onModelSelect: (modelId: string) => void | Promise<void>;
  readonly onOpenSettings: () => void;
  readonly enqueueMessage: (content: string, attachments: readonly ContextAttachment[]) => void;
  readonly startTask: (explicitGoal?: string) => void | Promise<boolean>;
  readonly clearQueuedMessages: () => void;
  readonly cancelRun: () => void | Promise<void>;
  readonly modelResponding: boolean;
  readonly followUpMode: ConversationFollowUpMode;
};

export type WorkbenchInputPropsViewModel = {
  readonly inputProps: ChatInputProps;
};

export function workbenchInputPropsFrom(
  options: WorkbenchInputPropsOptions,
): WorkbenchInputPropsViewModel {
  const inputProps: ChatInputProps = {
    value: options.goal,
    onChange: options.setGoal,
    attachments: options.attachments,
    onSelectAttachment: () => void options.selectAttachment(),
    onUploadAttachmentFiles: options.uploadAttachments,
    onRemoveAttachment: options.removeAttachment,
    contextBusy: options.contextBusy,
    busy: options.busy,
    running: options.modelResponding,
    models: options.models,
    selectedModelId: options.selectedModelId,
    contextUsage: options.contextUsage,
    reasoningEffort: options.reasoningEffort,
    reasoningEffortEnabled: options.reasoningEffortEnabled,
    onReasoningEffortChange: options.onReasoningEffortChange,
    toolConfirmationPolicy: options.toolConfirmationPolicy,
    onToolConfirmationPolicyChange: options.onToolConfirmationPolicyChange,
    closeSignal: options.closeSignal,
    onModelSelect: options.onModelSelect,
    onOpenSettings: options.onOpenSettings,
    onSubmit: () => {
      if (options.contextBusy) return;
      const content = options.goal.trim() || (options.attachments.some((attachment) => attachment.status === "ready")
        ? "请查看这些附件。" : "");
      if (content.length === 0) return;
      if (options.modelResponding && options.followUpMode === "guide") {
        options.setGoal("");
        void options.startTask(content);
      } else if (options.busy || options.modelResponding) {
        options.enqueueMessage(content, options.attachments);
        options.setAttachments([]);
        options.setGoal("");
      } else {
        void options.startTask(content);
      }
    },
    allowInputWhileBusy: true,
    onCancel: () => {
      options.clearQueuedMessages();
      void options.cancelRun();
    },
  };
  return {
    inputProps,
  };
}
