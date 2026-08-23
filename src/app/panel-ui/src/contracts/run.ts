import type {
  OrdinaryPanelCapabilityResolution,
  OrdinaryPanelDeliverable,
  OrdinaryPanelReplay,
  OrdinaryPanelRun,
  OrdinaryPanelRunDetail,
  OrdinaryPanelRunEvent,
  OrdinaryPanelRunView,
  OrdinaryPanelTranscriptNode,
  OrdinaryPanelWorkView,
  PanelModelUsage,
  PanelRunAgentDefinitionRef,
} from "../../../panel-api/ordinary-agent";
import type { ToolDisplayProjection, ToolErrorFacts } from "./tools";

export type RunAgentDefinitionRef = PanelRunAgentDefinitionRef;
export type RunCapabilityResolution = OrdinaryPanelCapabilityResolution;
export type OrdinaryRun = OrdinaryPanelRun;
export type RunEvent = OrdinaryPanelRunEvent;
export type ModelUsage = PanelModelUsage;

/** Live SSE payload before it is merged into the settled Panel read model. */
export type PanelStreamEvent = {
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type: string;
  readonly createdAt: string;
  readonly agentLabel?: string;
  readonly summary?: string;
  readonly status?: string;
  readonly toolName?: string;
  readonly detail?: {
    readonly action?: string;
    readonly path?: string;
    readonly query?: string;
    readonly command?: string;
    readonly exitCode?: number;
    readonly preview?: string;
    readonly display?: ToolDisplayProjection;
    readonly error?: string;
    readonly errorDomain?: string;
    readonly errorFacts?: ToolErrorFacts;
    readonly failureAttribution?: "schema_validation" | "execution_failure";
    readonly delegatedExecution?: {
      readonly modelRounds: number;
      readonly toolCallCount: number;
      readonly usage: ModelUsage;
    };
    readonly truncated?: boolean;
    readonly modelUsage?: ModelUsage;
  };
};

export type TranscriptNodeKind = OrdinaryPanelTranscriptNode["kind"];
export type TranscriptNodePhase = OrdinaryPanelTranscriptNode["phase"];
export type TranscriptConfirmation = NonNullable<OrdinaryPanelTranscriptNode["confirmation"]>;
export type TranscriptNode = OrdinaryPanelTranscriptNode;

export type OrdinaryRunDetail = OrdinaryPanelRunDetail;

export type PendingConfirmation = {
  readonly confirmationId: string;
  readonly title: string;
  readonly question: string;
  readonly consequence: string;
  readonly affectedResources?: readonly string[];
  readonly riskLevel: string;
  readonly resumeAvailability?: "live" | "lost_after_restart";
  readonly requestedAt?: string;
  readonly expiresAt?: string;
  readonly sourceRefs?: readonly string[];
};

export type OrdinaryRunCursor = string;
export type OrdinaryRunReplay = OrdinaryPanelReplay;
export type AgentDeliverable = OrdinaryPanelDeliverable;
export type OrdinaryWorkViewAnswer = NonNullable<OrdinaryPanelWorkView["answer"]>;
export type OrdinaryWorkView = OrdinaryPanelWorkView;
export type OrdinaryRunView = OrdinaryPanelRunView;
