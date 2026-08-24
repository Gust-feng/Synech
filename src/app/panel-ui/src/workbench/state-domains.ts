import type { LiveRunBuffer } from "../../../panel-api/ui-read-model";
import type { ConfigResponse } from "../../../panel-api/config";
import type { Conversation, ConversationSummary } from "../contracts/conversation";
import type {
  OrdinaryRun,
  OrdinaryRunDetail,
  OrdinaryWorkView,
  RunCapabilityResolution,
  RunEvent,
  TranscriptNode,
} from "../contracts/run";
import type { SkillDefinition } from "../contracts/skills";
import type { SubAgentDefinition } from "../contracts/sub-agents";
import type { ToolsResponse } from "../../../panel-api/tools";

/** Data loaded before the active workbench can render its capabilities. */
export type AppBootstrapState = {
  readonly config?: ConfigResponse;
  readonly tools?: ToolsResponse;
  readonly skills: readonly SkillDefinition[];
  readonly subAgents: readonly SubAgentDefinition[];
};

/** Conversation summaries and the currently opened Ordinary conversation. */
export type AppConversationState = {
  readonly conversations: readonly ConversationSummary[];
  readonly conversation?: Conversation;
};

/** Agent Run facts and their observable transcript projection. */
export type AppRunObservationState = {
  readonly run?: OrdinaryRun;
  readonly workView?: OrdinaryWorkView;
  readonly capabilityResolution?: RunCapabilityResolution;
  readonly capabilityResolutionRunId?: string;
  readonly transcriptNodes: readonly TranscriptNode[];
  readonly transcriptNodesByRunId: Record<string, readonly TranscriptNode[]>;
  readonly events: readonly RunEvent[];
  readonly live?: LiveRunBuffer;
  readonly detail?: OrdinaryRunDetail;
  readonly busy: boolean;
  readonly error?: string;
};
