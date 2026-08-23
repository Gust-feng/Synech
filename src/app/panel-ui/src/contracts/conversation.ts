import type {
  OrdinaryRunView,
} from "./run";
import type { WorkspaceFolderSummary } from "./common";

export type ConversationTurnAttachment = {
  readonly attachmentId: string;
  readonly kind: "workspace" | "file" | "project" | "web";
  readonly title: string;
  readonly summary?: string;
  readonly readonlyPreviewMeta?: {
    readonly available?: boolean;
    readonly title?: string;
    readonly byteLength?: number;
    readonly mimeType?: string;
    readonly truncated?: boolean;
  };
  readonly mediaPreview?: {
    readonly kind: "image";
    readonly url: string;
    readonly mimeType: string;
    readonly byteLength?: number;
  };
};

export type ConversationTurn = {
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly title?: string;
  readonly content: string;
  readonly status: string;
  readonly interruption?: "user_cancelled" | "runtime_stopped";
  readonly runId?: string;
  readonly attachments?: readonly ConversationTurnAttachment[];
  readonly responseModel?: {
    readonly profileId: string;
    readonly label?: string;
    readonly providerKind?: string;
    readonly protocolKind?: string;
    readonly baseUrl?: string;
    readonly model?: string;
  };
};

export type ConversationOwnerView = {
  readonly kind: "space" | "workspace";
  readonly id: string;
};

export type Conversation = {
  readonly conversationId: string;
  readonly owner?: ConversationOwnerView;
  readonly spaceId?: string;
  readonly title: string;
  readonly titleEditedAt?: string;
  readonly turns: readonly ConversationTurn[];
  readonly activeRunId?: string;
  readonly latestRunId?: string;
  readonly currentRun?: OrdinaryRunView;
  readonly workspaceFolder?: WorkspaceFolderSummary;
  readonly queuedRunIds?: readonly string[];
  readonly pinnedAt?: string;
  readonly updatedAt?: string;
};

export type ConversationPendingAction = {
  readonly kind: "approval" | "input";
  readonly runId: string;
  readonly assistantTurnId: string;
};

export type ConversationSummary = {
  readonly conversationId: string;
  readonly owner?: ConversationOwnerView;
  readonly spaceId?: string;
  readonly title: string;
  readonly titleEditedAt?: string;
  readonly preview?: string;
  readonly currentAction?: string;
  readonly nextStep?: string;
  readonly status?: string;
  readonly activeRunId?: string;
  readonly latestRunId?: string;
  readonly workspaceFolder?: WorkspaceFolderSummary;
  readonly queuedRunIds?: readonly string[];
  readonly queuedRunCount?: number;
  readonly pinnedAt?: string;
  readonly updatedAt?: string;
  readonly requiresUserAction?: boolean;
  readonly pendingAction?: ConversationPendingAction;
};
