import type { ComposerToolConfirmationPolicy } from "../features/settings/config-projection";
import type { ContextWindowUsage } from "../features/conversations/context-window-usage";
import type { ContextAttachment } from "./context";
import type { ModelCapabilities } from "@panel-api/config";
import type { ModelProviderIdentity } from "../features/settings/model/provider-logos";

export type ChatModelOption = {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly providerLabel: string;
  readonly providerIdentity: ModelProviderIdentity;
  readonly profileId: string;
  readonly modelId: string;
  readonly capabilities?: ModelCapabilities;
  readonly iconSvg?: string;
};

export type QueuedChatMessage = {
  readonly id: string;
  readonly content: string;
};

export type ConversationFollowUpMode = "guide" | "queue";

type AttachmentInputProps = {
  readonly attachments: readonly ContextAttachment[];
  readonly onSelectAttachment: () => void;
  readonly onUploadAttachmentFiles?: (files: readonly File[]) => void | Promise<void>;
  readonly onRemoveAttachment: (attachmentId: string) => void;
  readonly contextBusy?: boolean;
};

export type ChatInputProps = AttachmentInputProps & {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly busy: boolean;
  readonly allowInputWhileBusy?: boolean;
  readonly models: readonly ChatModelOption[];
  readonly selectedModelId: string;
  readonly contextUsage?: ContextWindowUsage;
  readonly reasoningEffort: "" | "low" | "medium" | "high";
  readonly reasoningEffortEnabled: boolean;
  readonly onReasoningEffortChange: (value: "" | "low" | "medium" | "high") => void;
  readonly toolConfirmationPolicy: ComposerToolConfirmationPolicy;
  readonly onToolConfirmationPolicyChange: (value: ComposerToolConfirmationPolicy) => void;
  readonly onModelSelect: (modelId: string) => void | Promise<void>;
  readonly onOpenSettings: () => void;
  readonly onSubmit: () => void;
  readonly onCancel?: () => void;
  readonly cancelLabel?: string;
  readonly autoFocus?: boolean;
  readonly running?: boolean;
  readonly placeholder?: string;
  readonly variant?: "embedded" | "floating";
  readonly queuedMessages?: readonly QueuedChatMessage[];
  readonly onRemoveQueuedMessage?: (id: string) => void;
  readonly onUpdateQueuedMessage?: (id: string, content: string) => void;
  readonly onGuideQueuedMessage?: (id: string) => Promise<boolean> | void;
  readonly closeSignal?: number;
};
