import type { ReactElement } from "react";
import type { ChatInputProps } from "../../../../contracts/composer";
import type { Conversation } from "../../../../contracts/conversation";
import type { CurrentRunProjection } from "../../../../features/conversations/run/projection";
import type { AgentDeliverable, OrdinaryWorkView, PendingConfirmation, TranscriptNode } from "../../../../contracts/run";
import { ConversationPage } from "./ConversationPage";
import { ConversationTranscript } from "./ConversationTranscript";
import { SurfaceErrorBoundary } from "./SurfaceErrorBoundary";
import type { ConfirmationProjection } from "./ConfirmationCard";
import type { ConversationSurfaceProjection, LiveConversationState } from "./conversation-surface-state";
import type { ResearchScopeCardState } from "../../../../features/conversations/run/research-scope-card";
import type { ResearchScopeGateFailureView } from "@panel-api/research";

/** 范围卡在 run 视图里的可用输入：三个来源都缺省时卡片不渲染。 */
export type ConversationResearchScopeInput = {
  readonly busy: boolean;
  readonly missing: readonly ResearchScopeGateFailureView[] | null;
  readonly settledKeys?: readonly string[];
  readonly onApprove?: (state: ResearchScopeCardState) => void;
  readonly onDismiss?: (proposalKey: string) => void;
};

const EMPTY_SCOPE_KEYS: readonly string[] = [];

export type ConversationSurfaceProps = {
  readonly conversation?: Conversation;
  readonly projection: ConversationSurfaceProjection;
  readonly state: LiveConversationState;
  readonly input: ChatInputProps;
  readonly currentRun: CurrentRunProjection;
  readonly showModelUsage: boolean;
  readonly developerModeEnabled: boolean;
  readonly confirmationBusy: boolean;
  readonly onDecision: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
  /** 范围卡（ADR 0001 §2.2）：在途门、缺失字段清单与两个用户决定。 */
  readonly researchScopeBusy?: boolean;
  readonly researchScopeMissing?: readonly ResearchScopeGateFailureView[] | null;
  readonly onApproveResearchScope?: (state: ResearchScopeCardState) => void;
  readonly onDismissResearchScope?: (proposalKey: string) => void;
  readonly settledResearchScopeKeys?: readonly string[];
  readonly focus?: boolean;
  readonly onExitFocus?: () => void;
};

export function ConversationSurface(props: ConversationSurfaceProps): ReactElement {
  const active = props.projection;
  const composerInput = confirmationGuidanceInput(
    props.input,
    active.pending,
    props.confirmationBusy,
    props.onDecision,
  );
  const content = active.hasVisibleContent ? (
    <SurfaceErrorBoundary resetKey={props.currentRun.run?.runId ?? props.conversation?.conversationId ?? "transcript"} label="对话内容暂时无法显示">
      <ConversationTranscript
        conversationId={props.conversation?.conversationId}
        projectedTurns={active.workline.turns}
        turns={props.conversation?.turns ?? []}
        currentRunId={active.currentRunId}
        currentRunNodes={active.currentRunProjection.nodes}
        currentRunToolResults={props.currentRun.detail?.toolResults ?? []}
        run={props.currentRun.run}
        live={props.currentRun.live}
        workView={props.currentRun.workView}
        pending={active.pending}
        showModelUsage={props.showModelUsage}
        developerModeEnabled={props.developerModeEnabled}
        standaloneRun={active.workline.standaloneRun !== true ? undefined : {
          currentRunId: active.currentRunId,
          runStatus: props.currentRun.run?.status,
          answer: active.answer,
          failure: props.currentRun.detail?.error,
          deliverable: active.deliverable,
          runProjection: active.currentRunProjection,
          pending: active.pending,
        }}
        models={props.input.models}
        selectedModelId={props.input.selectedModelId}
        onDecision={props.onDecision}
        confirmationBusy={props.confirmationBusy}
        researchScope={{
          busy: props.researchScopeBusy === true,
          missing: props.researchScopeMissing ?? null,
          settledKeys: props.settledResearchScopeKeys ?? EMPTY_SCOPE_KEYS,
          onApprove: props.onApproveResearchScope,
          onDismiss: props.onDismissResearchScope,
        }}
      />
    </SurfaceErrorBoundary>
  ) : undefined;
  const title = props.conversation?.title ?? "新的对话";
  const scrollKey = `${props.conversation?.conversationId ?? "new-conversation"}:${active.currentRunId ?? "idle"}`;

  return <ConversationPage
    scrollKey={scrollKey}
    content={content}
    input={composerInput}
    focus={props.focus ? {
      title,
      state: props.state,
      onExit: props.onExitFocus ?? (() => undefined),
    } : undefined}
  />;
}

function confirmationGuidanceInput(
  input: ChatInputProps,
  pending: ConfirmationProjection | undefined,
  confirmationBusy: boolean,
  onDecision: ConversationSurfaceProps["onDecision"],
): ChatInputProps {
  if (pending === undefined || pending.resumeAvailability === "lost_after_restart") return input;
  return {
    ...input,
    placeholder: "补充要求...",
    onSubmit: () => {
      const guidance = input.value.trim();
      if (guidance.length === 0 || confirmationBusy) return;
      onDecision("guidance", guidance);
      input.onChange("");
    },
  };
}
