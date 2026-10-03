import { SvgMark } from "@ui/components/svg-mark";
/**
 * Conversation workbench 的对话转录渲染器。
 *
 * 消费 ConversationDisplayItem[] 与 canonical tool result 数据，使用
 * 使用工作台的 --ui-* token 渲染，不依赖旧 Transcript 组件和主题。
 *
 * 数据权威不变：projectConversationDisplayList 产出什么，这里就渲染什么。
 * 全量可见性不变：工具活动、确认流、失败归因、Sub-Agent 嵌套全部保留。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  Terminal,
  Search,
  Globe2,
  Pencil,
  FolderOpen,
  Bot,
  Wrench,
} from "lucide-react";
import type { ConversationTurn } from "@ui/contracts/conversation";
import type { OrdinaryRun, OrdinaryWorkView, TranscriptNode } from "@ui/contracts/run";
import type { PanelToolCallResult as ToolCallResult } from "@panel-api/ordinary-agent";
import type { LiveRunBuffer } from "@panel-api/ui-read-model";
import type { WorklineProjectedTurn } from "@panel-api/ui-read-model";
import type { ChatModelOption } from "@ui/contracts/composer";
import { RichText, StreamingRichText } from "@ui/components/rich-text";
import { useStreamingText } from "@ui/features/conversations/transcript/use-streaming-text";
import { ConversationUserMessage } from "./ConversationUserMessage";
import { CopyActionButton } from "@ui/components/copy-action-button";
import { ActivityEvidencePanel } from "./ActivityEvidence";
import { toolResultForActivity } from "@ui/features/conversations/transcript/tool-result-association";
import { ConfirmationCard, type ConfirmationProjection } from "./ConfirmationCard";
import type { ConversationDisplayItem } from "@panel-api/ui-read-model";
import type { AssistantWorkflowDisplay } from "@panel-api/ui-read-model";
import { useConversationTranscriptProjection, type ConversationStandaloneRun } from "./use-conversation-transcript-projection";
import {
  isVisibleOrdinaryActivityItem,
  resolveActivityToolKind,
  type ActivityItem,
} from "@panel-api/ui-read-model";
import type { AgentWorkTimelineView } from "@panel-api/ui-read-model";
import {
  assistantTerminalNoticeTitle,
  type AssistantFailureParts,
  type AssistantTerminalStatus,
} from "@panel-api/ui-read-model";
import {
  assistantModelForTurn,
  selectedComposerModel,
  type ConversationModelBadge,
} from "./conversation-model-badge";

/* ─── 主入口 ─── */

export type ConversationTranscriptProps = {
  readonly conversationId?: string;
  readonly projectedTurns: readonly WorklineProjectedTurn<ConversationTurn>[];
  readonly turns: readonly ConversationTurn[];
  readonly currentRunId?: string;
  readonly currentRunNodes: readonly TranscriptNode[];
  readonly currentRunToolResults: readonly ToolCallResult[];
  readonly run?: OrdinaryRun;
  readonly live?: LiveRunBuffer;
  readonly workView?: OrdinaryWorkView;
  readonly pending?: ConfirmationProjection;
  readonly developerModeEnabled: boolean;
  readonly standaloneRun?: ConversationStandaloneRun;
  readonly models: readonly ChatModelOption[];
  readonly selectedModelId: string;
  readonly onSelectBranch?: (runId: string) => Promise<void>;
  readonly onEditTurn?: (runId: string, content: string) => Promise<boolean>;
  readonly onDecision: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
  readonly confirmationBusy: boolean;
};

export function ConversationTranscript(props: ConversationTranscriptProps): React.ReactElement | null {
  const { conversationDisplay, toolResultsByRunId, nodesByRunId } = useConversationTranscriptProjection(props);
  const items = conversationDisplay.items;
  if (items.length === 0) return null;

  return (
    <div className="ui-conversation-stream">
      {items.map((item) => {
        if (item.kind === "user") {
          return <ConversationUserMessage key={item.key} turn={item.turn} onSelectBranch={props.onSelectBranch}
            onEdit={item.turn.runId === undefined || props.onEditTurn === undefined ? undefined :
              (content) => props.onEditTurn!(item.turn.runId!, content)} />;
        }
        if (item.failure !== undefined) {
          return (
            <ConversationFailureMessage
              key={item.key}
              failure={item.failure}
              terminalStatus={item.terminalStatus}
              model={modelBadgeForItem(item, props.models, props.selectedModelId)}
              workflow={item.workflow}
              toolResultsByRunId={toolResultsByRunId}
              developerModeEnabled={props.developerModeEnabled}
              onDecision={props.onDecision}
              confirmationBusy={props.confirmationBusy}
            />
          );
        }
        return (
          <ConversationAssistantMessage
            key={item.key}
            live={item.live}
            durationSeconds={conversationRunDurationSeconds(
              item.source === "turn" ? item.turn.runId : props.standaloneRun?.currentRunId ?? props.currentRunId,
              props.run,
              nodesByRunId,
            )}
            model={modelBadgeForItem(item, props.models, props.selectedModelId)}
            workflow={item.workflow}
            toolResultsByRunId={toolResultsByRunId}
            developerModeEnabled={props.developerModeEnabled}
            onDecision={props.onDecision}
            confirmationBusy={item.hasPendingConfirmation && props.confirmationBusy}
          />
        );
      })}
    </div>
  );
}

/* ─── 助手消息 ─── */

function modelBadgeForItem(
  item: Extract<ConversationDisplayItem<ConversationTurn, TranscriptNode, ConfirmationProjection>, { readonly kind: "assistant" }>,
  models: readonly ChatModelOption[],
  selectedModelId: string,
): ConversationModelBadge | undefined {
  if (item.source === "turn" && item.turn !== undefined) {
    return assistantModelForTurn(item.turn, models, selectedModelId);
  }
  return selectedComposerModel(models, selectedModelId);
}

function ConversationAssistantMessage(props: {
  readonly live?: boolean;
  readonly durationSeconds?: number;
  readonly model?: ConversationModelBadge;
  readonly workflow?: AssistantWorkflowDisplay<TranscriptNode, ConfirmationProjection>;
  readonly toolResultsByRunId: Readonly<Record<string, readonly ToolCallResult[]>>;
  readonly developerModeEnabled: boolean;
  readonly onDecision?: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
  readonly confirmationBusy?: boolean;
}) {
  const workflow = props.workflow;
  if (workflow === undefined) {
    return <ConversationPendingDots />;
  }
  const needsConfirmation = workflow.segments.some((segment) =>
    segment.kind === "activity" &&
    segment.timeline.confirmation.current !== undefined
  );
  const lastToolIndex = workflow.segments.reduce((lastIndex, segment, index) =>
    segment.kind === "activity" && segment.timeline.items.some((item) => item.tone === "tool") ? index : lastIndex,
    -1,
  );
  const finalAnswerStart = workflow.segments.findIndex((segment, index) =>
    index > lastToolIndex && segment.kind === "body" && segment.text.trim().length > 0
  );
  const hasFinalAnswer = workflow.showCopyActions && !props.live && !needsConfirmation && finalAnswerStart >= 0;
  const answerCopyText = hasFinalAnswer
    ? workflow.segments.slice(finalAnswerStart).filter((segment) => segment.kind === "body").map((segment) => segment.copyText).join("\n\n")
    : workflow.copyText;
  return (
    <div className="ui-conversation-turn ui-conversation-turn--assistant space-y-3">
      <ConversationModelLabel model={props.model} />
      <ConversationRunProcess
        segments={workflow.segments}
        settled={hasFinalAnswer}
        finalAnswerStart={hasFinalAnswer ? finalAnswerStart : undefined}
        live={props.live}
        durationSeconds={props.durationSeconds}
        attention={needsConfirmation}
        onDecision={props.onDecision}
        confirmationBusy={props.confirmationBusy === true}
        toolResultsByRunId={props.toolResultsByRunId}
        developerModeEnabled={props.developerModeEnabled}
      />
      <div className="ui-message-actions ui-message-actions--assistant">
        <ConversationAnswerActions
          text={answerCopyText}
          visible={workflow.showCopyActions}
        />
      </div>
    </div>
  );
}

function formatProcessDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

function conversationRunDurationSeconds(
  runId: string | undefined,
  run: OrdinaryRun | undefined,
  nodesByRunId: Readonly<Record<string, readonly TranscriptNode[]>>,
): number | undefined {
  if (runId === undefined) return undefined;
  const nodes = nodesByRunId[runId] ?? [];
  const startedAt = run?.runId === runId
    ? run.createdAt
    : nodes.find((node) => node.eventType === "model.requested")?.timestamp;
  const finishedAt = nodes.find((node) => node.eventType === "run.completed")?.timestamp;
  const endedAt = finishedAt ?? (run?.runId === runId && run.status === "completed" ? run.updatedAt : undefined);
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const elapsed = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed / 1000) : undefined;
}

type ConversationProcessSegment = AssistantWorkflowDisplay<TranscriptNode, ConfirmationProjection>["segments"][number];

function useObservedThinkingDurations(segments: readonly ConversationProcessSegment[]): Readonly<Record<string, number>> {
  const starts = useRef(new Map<string, number>());
  const [durations, setDurations] = useState<Readonly<Record<string, number>>>({});
  useEffect(() => {
    const completed: Record<string, number> = {};
    for (const segment of segments) {
      if (segment.kind !== "activity") continue;
      for (const item of segment.timeline.items) {
        if (item.tone !== "thinking") continue;
        if (item.phase !== "completed") {
          if (!starts.current.has(item.key)) starts.current.set(item.key, Date.now());
          continue;
        }
        const startedAt = starts.current.get(item.key);
        if (startedAt !== undefined && durations[item.key] === undefined) {
          completed[item.key] = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        }
      }
    }
    if (Object.keys(completed).length > 0) {
      setDurations((current) => ({ ...current, ...completed }));
    }
  }, [segments, durations]);
  return durations;
}

function hasVisibleProcessActivity(segments: readonly ConversationProcessSegment[], developerModeEnabled: boolean): boolean {
  return segments.some((segment) => segment.kind === "activity" && (
    segment.timeline.confirmation.current !== undefined ||
    segment.timeline.items.some((item) =>
      isVisibleOrdinaryActivityItem(item) && (developerModeEnabled || item.tone !== "thinking")
    )
  ));
}

function ConversationRunProcess(props: {
  readonly segments: readonly ConversationProcessSegment[];
  readonly settled: boolean;
  readonly finalAnswerStart?: number;
  readonly live?: boolean;
  readonly durationSeconds?: number;
  readonly attention: boolean;
  readonly failed?: boolean;
  readonly onDecision?: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
  readonly confirmationBusy: boolean;
  readonly toolResultsByRunId: Readonly<Record<string, readonly ToolCallResult[]>>;
  readonly developerModeEnabled: boolean;
}) {
  // A completion transition closes earlier work without remounting the answer.
  const [disclosure, setDisclosure] = useState({ settled: props.settled, open: !props.settled });
  const open = disclosure.settled === props.settled ? disclosure.open : !props.settled;
  const thinkingDurations = useObservedThinkingDurations(props.segments);
  const expanded = props.attention || open;
  const hasVisibleActivity = hasVisibleProcessActivity(props.segments, props.developerModeEnabled);
  const toolCount = props.segments.reduce((count, segment) => segment.kind === "activity"
    ? count + segment.timeline.items.filter((item) => item.tone === "tool").length
    : count, 0);
  return (
    <div className="ui-run-process" data-state={props.attention ? "attention" : props.failed ? "failed" : props.settled ? "settled" : "running"}>
      {hasVisibleActivity && <button
        type="button"
        className="ui-run-process__summary"
        data-conversation-disclosure
        onClick={() => setDisclosure({ settled: props.settled, open: !open })}
        disabled={props.attention}
        aria-expanded={expanded}
      >
        <span>{props.attention ? "需要确认" : props.failed ? "过程" : props.settled
          ? props.durationSeconds === undefined ? "已完成" : `用时 ${formatProcessDuration(props.durationSeconds)}`
          : "正在处理"}</span>
        {toolCount > 0 && !props.settled && <span className="ui-run-process__count">{toolCount} 项操作</span>}
        {!props.attention && (expanded
          ? <ChevronDown size={13} aria-hidden="true" />
          : <ChevronRight size={13} aria-hidden="true" />)}
      </button>}
      <div className="ui-run-process__segments">
        {props.segments.map((segment, index) => {
          const isIntermediateBody = segment.kind === "body" && props.settled &&
            props.finalAnswerStart !== undefined && index < props.finalAnswerStart;
          const isProcess = segment.kind === "activity" || isIntermediateBody;
          const visibleActivity = segment.kind === "activity" &&
            hasVisibleProcessActivity([segment], props.developerModeEnabled);
          const hidden = isProcess && (!expanded || (segment.kind === "activity" && !visibleActivity));
          const segmentKey = segment.kind === "awaiting" ? `awaiting-${index}` : segment.segmentKey;
          return (
            <div key={segmentKey} className={isProcess ? "ui-run-process__step" : "ui-run-process__body"} hidden={hidden}>
              {segment.kind === "activity" ? (
                <ConversationActivitySegment
                  segment={segment}
                  onDecision={props.onDecision}
                  confirmationBusy={props.confirmationBusy}
                  toolResultsByRunId={props.toolResultsByRunId}
                  developerModeEnabled={props.developerModeEnabled}
                  thinkingDurations={thinkingDurations}
                />
              ) : segment.kind === "awaiting" ? <ConversationPendingDots /> : (
                <ConversationAnswerBlock text={segment.text} live={props.live === true && segment.live} />
              )}
            </div>
          );
        })}
        {!hasVisibleActivity && props.live && props.segments.length > 0 &&
          props.segments.every((segment) => segment.kind === "activity") && <ConversationPendingDots />}
      </div>
    </div>
  );
}

/* ─── 失败消息 ─── */

function ConversationFailureMessage(props: {
  readonly failure: AssistantFailureParts;
  readonly terminalStatus?: AssistantTerminalStatus;
  readonly model?: ConversationModelBadge;
  readonly workflow?: AssistantWorkflowDisplay<TranscriptNode, ConfirmationProjection>;
  readonly toolResultsByRunId: Readonly<Record<string, readonly ToolCallResult[]>>;
  readonly developerModeEnabled: boolean;
  readonly onDecision?: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
  readonly confirmationBusy: boolean;
}) {
  const workflow = props.workflow;
  const bodySegments = workflow?.segments.filter((s) => s.kind !== "activity") ?? [];
  const activitySegments = workflow?.segments.filter((s) => s.kind === "activity") ?? [];
  return (
    <div className="ui-conversation-turn ui-conversation-turn--assistant space-y-3">
      <ConversationModelLabel model={props.model} />
      {bodySegments.map((segment, index) => {
        if (segment.kind === "awaiting") return <ConversationPendingDots key={`a-${index}`} />;
        return <ConversationAnswerBlock key={segment.segmentKey} text={segment.text} live={false} />;
      })}
      <ConversationAnswerActions text={workflow?.copyText ?? ""} visible={workflow?.showCopyActions === true} />
      {/* 失败通知 */}
      <div
        className="flex items-start gap-2.5 rounded-lg px-4 py-3 text-sm"
        style={{ background: "rgba(200,64,64,0.06)", border: "1px solid rgba(200,64,64,0.15)", color: "var(--ui-text-1)" }}
      >
        <CircleAlert size={14} className="mt-0.5 shrink-0" style={{ color: "var(--ui-status-error, #C84040)" }} />
        <div className="min-w-0 space-y-1">
          <p className="font-medium" style={{ color: "var(--ui-status-error, #C84040)" }}>
            {assistantTerminalNoticeTitle(props.terminalStatus ?? "failed", props.failure.code)}
          </p>
          {props.failure.error !== undefined && (
            <p className="text-xs" style={{ color: "var(--ui-text-2)", lineHeight: 1.6 }}>{props.failure.error}</p>
          )}
        </div>
      </div>
      {hasVisibleProcessActivity(activitySegments, props.developerModeEnabled) && (
        <ConversationRunProcess
          segments={activitySegments}
          settled={false}
          attention={false}
          failed
          onDecision={props.onDecision}
          confirmationBusy={props.confirmationBusy}
          toolResultsByRunId={props.toolResultsByRunId}
          developerModeEnabled={props.developerModeEnabled}
        />
      )}
    </div>
  );
}

/* ─── 模型徽标 ─── */

function ConversationModelLabel(props: { readonly model?: ConversationModelBadge }): React.ReactElement | null {
  if (props.model === undefined) return null;
  return (
    <div className="ui-model-badge">
      {props.model.iconSvg !== undefined && (
        <span
          className="ui-model-badge__icon"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: props.model.iconSvg }}
        />
      )}
      <span className="ui-model-badge__name">{props.model.modelName}</span>
    </div>
  );
}

/* ─── 回答文本块 ─── */

const ConversationAnswerBlock = React.memo(function ConversationAnswerBlock(props: {
  readonly text: string;
  readonly live: boolean;
}) {
  if (props.text.trim().length === 0) return null;
  return (
    <div
      className="ui-answer-block assistant-answer reading-prose"
      style={{ color: "var(--ui-text-1)", lineHeight: 1.85 }}
    >
      <StreamingRichText text={props.text} live={props.live} />
    </div>
  );
});

function ConversationAnswerActions(props: { readonly text: string; readonly visible: boolean }): React.ReactElement | null {
  if (!props.visible || props.text.trim().length === 0) return null;
  return (
    <div className="ui-answer-actions">
      <CopyActionButton value={props.text} label="复制回答" className="ui-answer-copy" />
    </div>
  );
}

/* ─── 等待指示器 ─── */

function ConversationPendingDots() {
  return (
    <div className="flex items-center gap-1.5 py-2" role="status" aria-label="正在处理">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--ui-accent, #6865a7)", opacity: 0.5, animation: `ui-thinking 1.2s ${i * 0.18}s infinite` }}
        />
      ))}
      <style>{`@keyframes ui-thinking{0%,80%,100%{transform:scale(0.7);opacity:0.3}40%{transform:scale(1);opacity:0.75}}`}</style>
    </div>
  );
}

/* ─── 工具活动时间线 ─── */

/**
 * 保留一次模型请求的思考与工具执行顺序，供整次运行的过程区使用。
 */
function ConversationActivitySegment(props: {
  readonly segment: Extract<
    AssistantWorkflowDisplay<TranscriptNode, ConfirmationProjection>["segments"][number],
    { readonly kind: "activity" }
  >;
  readonly onDecision?: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
  readonly confirmationBusy: boolean;
  readonly developerModeEnabled: boolean;
  readonly toolResultsByRunId: Readonly<Record<string, readonly ToolCallResult[]>>;
  readonly thinkingDurations?: Readonly<Record<string, number>>;
}) {
  const segments = activityTimelineSegments({
    ...props.segment.timeline,
    items: props.segment.timeline.items.filter((item) => props.developerModeEnabled || item.tone !== "thinking"),
  });
  return (
    <>
      {segments.map((segment) => segment.kind === "thinking" ? (
        <ConversationThinkingBlock
          key={segment.item.key}
          item={segment.item}
          durationSeconds={props.thinkingDurations?.[segment.item.key]}
          text={props.segment.timeline.nodes.find((node) => node.nodeId === segment.item.nodeId)?.text ??
            segment.item.copy.expandedDetail ?? segment.item.copy.detail}
        />
      ) : (
        <ConversationActivityTimeline
          key={segment.key}
          timeline={segment.timeline}
          onDecision={props.onDecision}
          confirmationBusy={props.confirmationBusy}
          toolResultsByRunId={props.toolResultsByRunId}
          developerModeEnabled={props.developerModeEnabled}
        />
      ))}
    </>
  );
}

type ActivityTimelineSegment =
  | { readonly kind: "thinking"; readonly item: ActivityItem }
  | { readonly kind: "process"; readonly key: string; readonly timeline: AgentWorkTimelineView<TranscriptNode, ConfirmationProjection> };

function activityTimelineSegments(
  timeline: AgentWorkTimelineView<TranscriptNode, ConfirmationProjection>,
): readonly ActivityTimelineSegment[] {
  const segments: ActivityTimelineSegment[] = [];
  let processItems: ActivityItem[] = [];
  const flushProcess = (includeConfirmation: boolean): void => {
    const confirmation = includeConfirmation ? timeline.confirmation : { ...timeline.confirmation, current: undefined };
    if (processItems.length === 0 && confirmation.current === undefined) return;
    segments.push({
      kind: "process",
      key: processItems[0]?.key ?? "pending-confirmation",
      timeline: { ...timeline, items: processItems, confirmation, hasContent: true },
    });
    processItems = [];
  };
  // Keep each model block at its chronological position. Only adjacent process
  // items share a disclosure; a later request's reasoning never joins an earlier one.
  for (const item of timeline.items.filter(isVisibleOrdinaryActivityItem)) {
    if (item.tone === "thinking") {
      flushProcess(false);
      segments.push({ kind: "thinking", item });
    } else {
      processItems.push(item);
    }
  }
  flushProcess(true);
  return segments;
}

/* ─── 思考块 ─── */

/** 进行态保持单行流式输出；完成后按需展开完整思考。 */
function ConversationThinkingBlock(props: { readonly item: ActivityItem; readonly text: string; readonly durationSeconds?: number }) {
  const thinkingInProgress = props.item.phase !== "completed";
  const displayed = useStreamingText(props.text, thinkingInProgress, { tone: "thinking", animateOnMount: true });
  const [open, setOpen] = useState(false);
  const contentId = React.useId();
  const streamRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (thinkingInProgress && streamRef.current !== null) {
      streamRef.current.scrollLeft = streamRef.current.scrollWidth;
    }
  }, [displayed, thinkingInProgress]);
  if (thinkingInProgress) return (
    <div className="ui-thinking-block__summary" data-state="streaming">
      <span className="ui-thinking-block__stream" ref={streamRef}>{displayed}</span>
    </div>
  );
  return (
    <div className="ui-thinking-block">
      <button
        type="button"
        className="ui-thinking-block__summary ui-thinking-block__trigger"
        data-conversation-disclosure
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={contentId}
      >
        <Brain size={13} className="shrink-0" aria-hidden="true" />
        <span className="ui-thinking-block__label">思考</span>
        <span className="ui-thinking-block__duration">· {props.durationSeconds === undefined ? "已完成" : formatProcessDuration(props.durationSeconds)}</span>
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
      </button>
      {open && (
        <div id={contentId} className="ui-thinking-block__content" data-conversation-detail role="region" aria-label="思考内容" tabIndex={0}>
          <div className="ui-thinking-block__toolbar">
            <CopyActionButton value={props.text} label="复制思考" className="ui-thinking-block__copy" />
          </div>
          <div className="ui-thinking-block__text">{props.text}</div>
        </div>
      )}
    </div>
  );
}

function ConversationActivityTimeline(props: {
  readonly timeline: AgentWorkTimelineView<TranscriptNode, ConfirmationProjection>;
  readonly onDecision?: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
  readonly confirmationBusy: boolean;
  readonly toolResultsByRunId: Readonly<Record<string, readonly ToolCallResult[]>>;
  readonly developerModeEnabled: boolean;
}) {
  const visibleItems = props.timeline.items.filter(isVisibleOrdinaryActivityItem);
  const confirmation = props.timeline.confirmation.current;
  if (visibleItems.length === 0 && confirmation === undefined) return null;

  return (
    <>
      {visibleItems.length > 0 && (
        <div className="ui-process-actions">
          {visibleItems.map((item) => (
            <ConversationActivityItem
              key={item.key}
              item={item}
              toolResult={toolResultForActivity(item, props.timeline.nodes, props.toolResultsByRunId)}
              resolveChildResult={(child) => toolResultForActivity(child, props.timeline.nodes, props.toolResultsByRunId)}
              showCanonicalToolResult={props.developerModeEnabled}
            />
          ))}
        </div>
      )}
      {confirmation !== undefined && (
        <div className="ui-activity-confirmation">
          <ConfirmationCard
            confirmation={confirmation}
            busy={props.confirmationBusy}
            onDecision={props.onDecision}
          />
        </div>
      )}
    </>
  );
}

/* ─── 单条活动记录 ─── */

const TOOL_ICONS: Partial<Record<NonNullable<ActivityItem["toolKind"]>, React.ReactNode>> = {
  command: <Terminal size={13} />,
  read: <FileText size={13} />,
  edit: <Pencil size={13} />,
  search: <Search size={13} />,
  web: <Globe2 size={13} />,
  directory: <FolderOpen size={13} />,
  agent: <Bot size={13} />,
};

function ConversationActivityItem(props: {
  readonly item: ActivityItem;
  readonly toolResult?: ToolCallResult;
  readonly resolveChildResult: (item: ActivityItem) => ToolCallResult | undefined;
  readonly showCanonicalToolResult: boolean;
}) {
  const { item } = props;
  const toolKind = item.toolKind ?? resolveActivityToolKind(item);
  const icon = TOOL_ICONS[toolKind] ?? <Wrench size={13} />;
  const isActive = item.phase === "executing" || item.phase === "preparing";
  const isFailed = item.phase === "failed";
  const displayText = item.lead !== undefined ? `${item.lead.action} ${item.lead.subject}` : item.copy.detail;
  const badgeLabel = item.badges?.[0]?.label;
  const hasEvidence = (item.expandedSections?.length ?? 0) > 0 ||
    item.copy.expandedDetail !== undefined ||
    (props.toolResult !== undefined && props.showCanonicalToolResult);
  const [open, setOpen] = useState(false);
  const evidenceId = React.useId();

  return (
    <div className="ui-activity-item min-w-0" data-state={isFailed ? "failed" : isActive ? "running" : "settled"}>
      <button
        type="button"
        className="ui-activity-item__trigger"
        data-conversation-disclosure={hasEvidence || undefined}
        onClick={hasEvidence ? () => setOpen((value) => !value) : undefined}
        disabled={!hasEvidence}
        aria-expanded={hasEvidence ? open : undefined}
        aria-controls={hasEvidence ? evidenceId : undefined}
        title={displayText}
      >
        <span className="ui-activity-item__icon" aria-hidden="true">
          {isFailed ? <CircleAlert size={13} /> : icon}
        </span>
        <span className="ui-activity-item__label">
          {item.lead === undefined ? displayText : (
            <><span className="ui-activity-item__verb">{item.lead.action}</span>{" "}<span className="ui-activity-item__subject">{item.lead.subject}</span></>
          )}
        </span>
        {badgeLabel !== undefined && <span className="ui-activity-item__badge">{badgeLabel}</span>}
        <span className="ui-activity-item__disclosure" aria-hidden="true" data-visible={hasEvidence}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {open && hasEvidence && (
        <div id={evidenceId} className="ui-activity-item__detail" data-conversation-detail role="region" aria-label={displayText}>
          <ActivityEvidencePanel
            item={item}
            toolResult={props.toolResult}
            showCanonicalToolResult={props.showCanonicalToolResult}
          />
        </div>
      )}
      {item.children !== undefined && item.children.length > 0 && (
        <div className="ui-activity-item__children">
          {item.children.map((child) => (
            <ConversationActivityItem
              key={child.key}
              item={child}
              toolResult={props.resolveChildResult(child)}
              resolveChildResult={props.resolveChildResult}
              showCanonicalToolResult={props.showCanonicalToolResult}
            />
          ))}
        </div>
      )}
    </div>
  );
}
