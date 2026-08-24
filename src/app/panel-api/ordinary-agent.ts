import type { ConfirmationRequest } from "../../domain/confirmation/index.js";
import type {
  RunAgentDefinitionRef,
} from "../../domain/config/index.js";
import type { ModelUsage } from "../../domain/intelligence/index.js";
import type {
  DelegatedAgentExecutionMetadata,
  ToolCallResult,
  ToolErrorDomain,
  ToolErrorFacts,
  ToolFailureAttribution,
} from "../../domain/tools/index.js";
import type { ToolDisplayProjection } from "./tool-display.js";

export type PanelModelUsage = ModelUsage;
export type PanelRunAgentDefinitionRef = RunAgentDefinitionRef;

export type PanelObservationRef = {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly version?: string | number;
};

export type OrdinaryPanelConfirmationRequest = ConfirmationRequest & {
  readonly ownerRunId: string;
};

export type OrdinaryPanelTaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "needs_input"
  | "approval_needed"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type OrdinaryPanelRun = {
  readonly runId: string;
  readonly conversationId?: string;
  readonly title: string;
  readonly goalSummary: string;
  readonly status: OrdinaryPanelTaskStatus;
  readonly agentDefinitionRef?: RunAgentDefinitionRef;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentStep?: string;
  readonly nextStep?: string;
  readonly requiresUserAction: boolean;
  readonly eventCursor: {
    readonly lastSequence: number;
    readonly eventCount: number;
  };
};

export type OrdinaryPanelRunEvent = {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type: string;
  readonly title: string;
  readonly summary?: string;
  readonly delta?: string;
  readonly status: OrdinaryPanelTaskStatus;
  readonly timestamp: string;
  readonly toolName?: string;
  readonly parentToolCallFactId?: string;
  readonly refs: readonly PanelObservationRef[];
  readonly visibility: "compact" | "expanded" | "debug";
  readonly detail?: {
    readonly action?: string;
    readonly path?: string;
    readonly query?: string;
    readonly command?: string;
    readonly exitCode?: number;
    readonly preview?: string;
    readonly display?: ToolDisplayProjection;
    readonly truncated?: boolean;
    readonly error?: string;
    readonly errorDomain?: ToolErrorDomain;
    readonly errorFacts?: ToolErrorFacts;
    readonly delegatedExecution?: DelegatedAgentExecutionMetadata;
  };
};

export type OrdinaryPanelTranscriptNode = {
  readonly nodeId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly kind: "thinking" | "tool" | "confirmation" | "user_decision" | "answer" | "body" | "system";
  readonly phase: "noted" | "preparing" | "waiting_approval" | "approved" | "denied" | "guidance" | "executing" | "completed" | "failed" | "blocked" | "cancelled";
  readonly title: string;
  readonly summary?: string;
  readonly text?: string;
  readonly timestamp: string;
  readonly toolName?: string;
  readonly failureAttribution?: ToolFailureAttribution;
  readonly error?: string;
  readonly parentToolCallFactId?: string;
  readonly delegatedExecution?: DelegatedAgentExecutionMetadata;
  readonly display?: ToolDisplayProjection;
  readonly confirmation?: OrdinaryPanelConfirmationRequest;
  readonly modelUsage?: ModelUsage;
  readonly refs: readonly PanelObservationRef[];
};

export type PanelContextAttachmentKind = "workspace" | "file" | "project" | "web";

export type PanelContextAttachment = {
  readonly attachmentId: string;
  readonly kind: PanelContextAttachmentKind;
  readonly ref: string;
  readonly title: string;
  readonly summary: string;
  readonly readonlyPreview?: {
    readonly title?: string;
    readonly text: string;
    readonly truncated: boolean;
  };
  readonly permissionRefs: readonly string[];
  readonly readonlyPreviewMeta: {
    readonly available: boolean;
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
  readonly status: "ready" | "blocked";
  readonly warning?: string;
};

export type OrdinaryPanelDeliverable = {
  readonly deliverableId: string;
  readonly runId: string;
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly {
    readonly sectionId: string;
    readonly title: string;
    readonly content: string;
    readonly evidenceRefs: readonly PanelObservationRef[];
  }[];
  readonly evidenceRefs: readonly PanelObservationRef[];
  readonly toolDisplays: readonly ToolDisplayProjection[];
  readonly fileChanges: readonly ToolDisplayProjection[];
  readonly commands: readonly ToolDisplayProjection[];
  readonly nextActions: readonly string[];
  readonly createdAt: string;
};

export type OrdinaryPanelWorkView = {
  readonly run: OrdinaryPanelRun;
  readonly stage: "drafting" | "queued" | "understanding" | "gathering_context" | "using_tools" | "awaiting_approval" | "composing_result" | "completed" | "blocked" | "failed" | "cancelled";
  readonly headline: string;
  readonly currentAction: string;
  readonly contextAttachments: readonly PanelContextAttachment[];
  readonly pendingConfirmation?: OrdinaryPanelConfirmationRequest;
  readonly answer?: {
    readonly title: string;
    readonly content: string;
    readonly evidenceRefs: readonly PanelObservationRef[];
    readonly nextActions: readonly string[];
  };
  readonly deliverable?: OrdinaryPanelDeliverable;
  readonly visibleEvents: readonly OrdinaryPanelRunEvent[];
  readonly transcriptNodes: readonly OrdinaryPanelTranscriptNode[];
  readonly workSummary: {
    readonly summary: string;
    readonly pendingActionCount: number;
    readonly toolResultCount: number;
    readonly contextAttachmentCount: number;
  };
};

export type OrdinaryPanelCapabilityResolution = {
  readonly modelContextWindowTokens: number;
};

export type OrdinaryPanelReplayCursor = {
  readonly token: string;
  readonly lastSequence: number;
};

export type OrdinaryPanelReplay = {
  readonly reset: boolean;
  readonly events: readonly OrdinaryPanelRunEvent[];
  readonly cursor: OrdinaryPanelReplayCursor;
};

export type OrdinaryPanelRunDetail = {
  readonly runId: string;
  readonly status: OrdinaryPanelRun["status"];
  readonly error?: { readonly code: string; readonly message: string };
  readonly transcript?: { readonly transcriptNodes?: readonly OrdinaryPanelTranscriptNode[] };
  readonly stopReason?: string;
  readonly continuationAvailability?: "none" | "live" | "lost_after_restart" | "new_turn";
  readonly toolResults: readonly ToolCallResult[];
  readonly usage: ModelUsage;
};

export type OrdinaryPanelRunView = {
  readonly run: OrdinaryPanelRun;
  readonly agentDefinitionRef?: RunAgentDefinitionRef;
  readonly capabilityResolution?: OrdinaryPanelCapabilityResolution;
  readonly workView: OrdinaryPanelWorkView;
  readonly detail: OrdinaryPanelRunDetail;
  readonly replay: OrdinaryPanelReplay;
};

export type OrdinaryPanelConversationTurnStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked"
  | "needs_input";

export type OrdinaryPanelConversationStatus =
  | "idle"
  | "pending"
  | "running"
  | "approval_needed"
  | "needs_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export type OrdinaryPanelConversationTurnModel = {
  readonly profileId: string;
  readonly label?: string;
  readonly providerKind?: string;
  readonly protocolKind?: string;
  readonly baseUrl?: string;
  readonly model?: string;
};

export type OrdinaryPanelConversationTurnAttachment = {
  readonly attachmentId: string;
  readonly kind: PanelContextAttachmentKind;
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

export type OrdinaryPanelConversationTurn = {
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly title: string;
  readonly content: string;
  readonly status: OrdinaryPanelConversationTurnStatus;
  readonly interruption?: "user_cancelled" | "runtime_stopped";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runId?: string;
  readonly responseModel?: OrdinaryPanelConversationTurnModel;
  readonly attachments?: readonly OrdinaryPanelConversationTurnAttachment[];
};

export type OrdinaryPanelConversationPendingAction = {
  readonly kind: "approval" | "input";
  readonly runId: string;
  readonly assistantTurnId: string;
};

export type PanelWorkspaceFolderSummary = {
  readonly label: string;
  readonly path?: string;
  readonly selection: "default" | "explicit";
};

export type OrdinaryPanelConversation = {
  readonly conversationId: string;
  readonly owner?: { readonly kind: "space" | "workspace"; readonly id: string };
  readonly spaceId?: string;
  readonly title: string;
  readonly titleEditedAt?: string;
  readonly preview: string;
  readonly currentAction: string;
  readonly nextStep: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string;
  readonly status: OrdinaryPanelConversationStatus;
  readonly activeRunId?: string;
  readonly latestRunId?: string;
  readonly workspaceFolder?: PanelWorkspaceFolderSummary;
  readonly requiresUserAction: boolean;
  readonly pendingAction?: OrdinaryPanelConversationPendingAction;
  readonly queuedRunIds: readonly string[];
  readonly queuedRunCount: number;
  readonly currentRun?: OrdinaryPanelRunView;
  readonly turns: readonly OrdinaryPanelConversationTurn[];
};

export type OrdinaryPanelConversationSummary = Omit<OrdinaryPanelConversation, "turns">;
