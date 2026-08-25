/**
 * Conversation workbench 的对话转录渲染器。
 *
 * 消费 ConversationDisplayItem[] 与 canonical tool result 数据，使用
 * 使用工作台的 --ui-* token 渲染，不依赖旧 Transcript 组件和主题。
 *
 * 数据权威不变：projectConversationDisplayList 产出什么，这里就渲染什么。
 * 全量可见性不变：工具活动、确认流、失败归因、Sub-Agent 嵌套全部保留。
 */
import React, { useEffect, useState } from "react";
import {
  Brain,
  Check,
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
import type { ConversationTurn, ConversationTurnAttachment } from "@ui/contracts/conversation";
import type { OrdinaryRun, OrdinaryWorkView, TranscriptNode } from "@ui/contracts/run";
import type { PanelToolCallResult as ToolCallResult } from "@panel-api/ordinary-agent";
import type { LiveRunBuffer } from "@panel-api/ui-read-model";
import type { WorklineProjectedTurn } from "@panel-api/ui-read-model";
import type { ChatModelOption } from "@ui/contracts/composer";
import { RichText, StreamingRichText } from "@ui/components/rich-text";
import { useStreamingText } from "@ui/features/conversations/transcript/use-streaming-text";
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
  readonly showModelUsage: boolean;
  readonly developerModeEnabled: boolean;
  readonly standaloneRun?: ConversationStandaloneRun;
  readonly models: readonly ChatModelOption[];
  readonly selectedModelId: string;
  readonly onDecision: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
  readonly confirmationBusy: boolean;
};

export function ConversationTranscript(props: ConversationTranscriptProps): React.ReactElement | null {
  const { conversationDisplay, toolResultsByRunId } = useConversationTranscriptProjection(props);
  const items = conversationDisplay.items;
  if (items.length === 0) return null;

  return (
    <div className="ui-conversation-stream">
      {items.map((item) => {
        if (item.kind === "user") {
          return <ConversationUserMessage key={item.key} content={item.turn.content} attachments={item.turn.attachments} />;
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

/* ─── 用户消息 ─── */

const ConversationUserMessage = React.memo(function ConversationUserMessage(props: {
  readonly content: string;
  readonly attachments?: readonly ConversationTurnAttachment[];
}) {
  const attachments = props.attachments?.filter((a) => a.attachmentId.trim().length > 0) ?? [];
  return (
    <div className="ui-conversation-turn ui-conversation-turn--user flex justify-end">
      <div className="ui-user-message flex max-w-[520px] flex-col items-end gap-1.5">
        {attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {attachments.map((attachment) => (
              <span
                key={attachment.attachmentId}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
                style={{ background: "var(--ui-surface-hover, #eeebe6)", color: "var(--ui-text-2)" }}
              >
                <FileText size={11} className="shrink-0" />
                <span className="max-w-[160px] truncate">{attachment.title}</span>
              </span>
            ))}
          </div>
        )}
        {props.content.trim().length > 0 && (
          <div
            className="ui-user-message__body user-message-content px-3.5 py-2.5"
            style={{ lineHeight: 1.7, color: "var(--ui-text-1)" }}
          >
            <RichText text={props.content} />
          </div>
        )}
      </div>
    </div>
  );
});

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
  return (
    <div className="ui-conversation-turn ui-conversation-turn--assistant space-y-3">
      <ConversationModelLabel model={props.model} />
      {workflow.segments.map((segment, index) => {
        if (segment.kind === "activity") {
          return (
            <ConversationActivitySegment
              key={segment.segmentKey}
              segment={segment}
              onDecision={props.onDecision}
              confirmationBusy={props.confirmationBusy === true}
              toolResultsByRunId={props.toolResultsByRunId}
              developerModeEnabled={props.developerModeEnabled}
            />
          );
        }
        if (segment.kind === "awaiting") {
          return <ConversationPendingDots key={`awaiting-${index}`} />;
        }
        return (
          <ConversationAnswerBlock
            key={segment.segmentKey}
            text={segment.text}
            live={props.live === true && index === workflow.segments.length - 1}
          />
        );
      })}
      <ConversationAnswerActions text={workflow.copyText} visible={workflow.showCopyActions} />
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
            {assistantTerminalNoticeTitle(props.terminalStatus ?? "failed")}
          </p>
          {props.failure.error !== undefined && (
            <p className="text-xs" style={{ color: "var(--ui-text-2)", lineHeight: 1.6 }}>{props.failure.error}</p>
          )}
        </div>
      </div>
      {activitySegments.map((segment) => (
        segment.kind === "activity" ? (
          <ConversationActivitySegment
            key={segment.segmentKey}
            segment={segment}
            onDecision={props.onDecision}
            confirmationBusy={props.confirmationBusy}
            toolResultsByRunId={props.toolResultsByRunId}
            developerModeEnabled={props.developerModeEnabled}
          />
        ) : null
      ))}
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
      {props.live ? <StreamingRichText text={props.text} live /> : <RichText text={props.text} />}
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
 * 一个活动段由两部分组成：独立的思考块（模型推理过程）与工具工作流时间线。
 * 思考不属于工具调用过程，展示上与工具条目分开。
 */
function ConversationActivitySegment(props: {
  readonly segment: Extract<
    AssistantWorkflowDisplay<TranscriptNode, ConfirmationProjection>["segments"][number],
    { readonly kind: "activity" }
  >;
  readonly onDecision?: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
  readonly confirmationBusy: boolean;
  readonly toolResultsByRunId: Readonly<Record<string, readonly ToolCallResult[]>>;
  readonly developerModeEnabled: boolean;
}) {
  const { thinkingItems, processTimeline } = splitThinkingTimeline(props.segment.timeline);
  return (
    <>
      {thinkingItems.length > 0 && <ConversationThinkingBlock items={thinkingItems} />}
      <ConversationActivityTimeline
        timeline={processTimeline}
        collapsed={props.segment.collapsed}
        lifecycle={props.segment.lifecycle}
        onDecision={props.onDecision}
        confirmationBusy={props.confirmationBusy}
        toolResultsByRunId={props.toolResultsByRunId}
        developerModeEnabled={props.developerModeEnabled}
      />
    </>
  );
}

function splitThinkingTimeline(timeline: AgentWorkTimelineView<TranscriptNode, ConfirmationProjection>): {
  readonly thinkingItems: readonly ActivityItem[];
  readonly processTimeline: AgentWorkTimelineView<TranscriptNode, ConfirmationProjection>;
} {
  const visibleItems = timeline.items.filter(isVisibleOrdinaryActivityItem);
  const thinkingItems = visibleItems.filter((item) => item.tone === "thinking");
  const processItems = visibleItems.filter((item) => item.tone !== "thinking");
  return {
    thinkingItems,
    processTimeline: {
      ...timeline,
      items: processItems,
      hasContent: processItems.length > 0 || timeline.confirmation.current !== undefined,
    },
  };
}

/* ─── 思考块 ─── */

/**
 * 模型推理过程的专门展示：独立于工具工作流。思考进行中保持展开以实时显示
 * 推理内容；思考一旦完成（终态条目），自动收起为「思考」标题行。
 */
function ConversationThinkingBlock(props: { readonly items: readonly ActivityItem[] }) {
  const thinkingInProgress = props.items.some((item) => item.phase !== "completed");
  const [open, setOpen] = useState(thinkingInProgress);
  useEffect(() => {
    // 只在思考阶段切换时自动开合，不覆盖用户手动展开/收起。
    setOpen(thinkingInProgress);
  }, [thinkingInProgress]);
  const text = props.items
    .map((item) => item.copy.expandedDetail ?? item.copy.detail)
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join("\n\n");
  // reasoning 流平滑逐字显示；终态内容到达时立即结算为权威内容。
  const displayed = useStreamingText(text, thinkingInProgress);
  if (displayed.length === 0) return null;
  return (
    <div className="ui-thinking-block">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "收起思考" : "展开思考"}
        className="flex w-full items-center gap-2 text-left"
        style={{ color: "var(--ui-text-2)" }}
      >
        <Brain size={12} className="shrink-0" style={{ color: "var(--ui-text-3)" }} />
        <span className="text-[12px] font-medium tracking-wide">思考</span>
        <span className="ml-auto" style={{ color: "var(--ui-text-3)" }}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </button>
      {open && (
        <div
          className="ui-thinking-content mt-1.5 border-l-2 pl-3 text-[12px] leading-[1.75]"
          style={{ borderColor: "var(--ui-border)", color: "var(--ui-text-2)", whiteSpace: "pre-wrap" }}
        >
          {displayed}
        </div>
      )}
    </div>
  );
}

function ConversationActivityTimeline(props: {
  readonly timeline: AgentWorkTimelineView<TranscriptNode, ConfirmationProjection>;
  readonly collapsed?: boolean;
  readonly lifecycle?: "open" | "settled" | "attention";
  readonly onDecision?: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
  readonly confirmationBusy: boolean;
  readonly toolResultsByRunId: Readonly<Record<string, readonly ToolCallResult[]>>;
  readonly developerModeEnabled: boolean;
}) {
  const { confirmation, items, hasContent } = props.timeline;
  // Hooks 必须在任何 early return 之前无条件调用：该组件被父级无条件渲染，
  // 活动段从「无内容」变为「有工具调用」时若 useState 位于 return 之后，Hook 数量
  // 会从 0 变 1，触发 React "rendered more hooks" 崩溃。
  const autoOpen = props.lifecycle === "open" || props.lifecycle === "attention" || confirmation.current !== undefined;
  const [open, setOpen] = useState(autoOpen || props.collapsed !== true);

  if (!hasContent) return null;
  const visibleItems = items.filter(isVisibleOrdinaryActivityItem);
  if (visibleItems.length === 0 && confirmation.current === undefined) return null;

  const doneCount = visibleItems.filter((i) => i.phase === "completed").length;
  const failedCount = visibleItems.filter((i) => i.phase === "failed").length;
  const running = visibleItems.some((i) => i.phase === "executing" || i.phase === "preparing");
  const summaryState = confirmation.current !== undefined
    ? "attention"
    : running
      ? "running"
      : failedCount > 0
        ? "failed"
        : "settled";
  const summaryLabel = summaryState === "attention"
    ? "等待你的确认"
    : summaryState === "running"
      ? `正在处理 ${doneCount}/${visibleItems.length}`
      : summaryState === "failed"
        ? `${failedCount} 项操作未完成`
        : `完成 ${visibleItems.length} 项操作`;
  const summaryColor = summaryState === "running"
    ? "var(--ui-accent)"
    : summaryState === "attention"
      ? "var(--ui-status-wait)"
      : summaryState === "failed"
        ? "var(--ui-status-error)"
        : "var(--ui-text-2)";
  const summaryContent = (
    <>
      <Wrench size={11} style={{ color: "var(--ui-text-3)" }} />
      <span className="font-medium" style={{ color: summaryColor }}>
        {summaryLabel}
      </span>
      {running && (
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--ui-accent)", animation: "pulse 1.2s infinite" }} />
      )}
    </>
  );

  return (
    <div className="ui-activity-timeline overflow-hidden" data-state={summaryState}>
      {/* 摘要行 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="ui-activity-summary flex w-full items-center gap-2 text-left"
        style={{ color: "var(--ui-text-2)" }}
      >
        {summaryContent}
        <span className="ml-auto" style={{ color: "var(--ui-text-3)" }}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </button>

      {/* 展开的活动列表 */}
      {open && visibleItems.length > 0 && (
        <div className="ui-activity-details space-y-1">
          <div className="space-y-2">
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
        </div>
      )}

      {/* 确认卡片 */}
      {confirmation.current !== undefined && (
        <div className="ui-activity-confirmation">
          <ConfirmationCard
            confirmation={confirmation.current}
            busy={props.confirmationBusy}
            onDecision={props.onDecision}
          />
        </div>
      )}
    </div>
  );
}

/* ─── 单条活动记录 ─── */

const TOOL_ICONS: Record<string, React.ReactNode> = {
  terminal: <Terminal size={11} />,
  file_read: <FileText size={11} />,
  file_write: <Pencil size={11} />,
  search: <Search size={11} />,
  web: <Globe2 size={11} />,
  folder: <FolderOpen size={11} />,
  sub_agent: <Bot size={11} />,
};

function ConversationActivityItem(props: {
  readonly item: ActivityItem;
  readonly toolResult?: ToolCallResult;
  readonly resolveChildResult: (item: ActivityItem) => ToolCallResult | undefined;
  readonly showCanonicalToolResult: boolean;
}) {
  const { item } = props;
  const toolKind = item.toolKind ?? resolveActivityToolKind(item);
  const icon = TOOL_ICONS[toolKind] ?? <Wrench size={11} />;
  const isActive = item.phase === "executing" || item.phase === "preparing";
  const isFailed = item.phase === "failed";
  const displayText = item.lead !== undefined ? `${item.lead.action} ${item.lead.subject}` : item.copy.detail;
  const badgeLabel = item.badges?.[0]?.label;
  const hasEvidence = (item.expandedSections?.length ?? 0) > 0 ||
    item.copy.expandedDetail !== undefined ||
    (props.toolResult !== undefined && props.showCanonicalToolResult);
  const [open, setOpen] = useState(false);

  return (
    <div className="ui-activity-item min-w-0" style={{ color: "var(--ui-text-2)" }}>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 text-left"
        onClick={hasEvidence ? () => setOpen((value) => !value) : undefined}
        aria-expanded={hasEvidence ? open : undefined}
        style={{ cursor: hasEvidence ? "pointer" : "default" }}
      >
      {/* 状态指示 */}
      {isActive ? (
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-t-transparent animate-spin"
          style={{ borderColor: "var(--ui-accent)", borderTopColor: "transparent" }}
        />
      ) : isFailed ? (
        <CircleAlert size={10} className="shrink-0" style={{ color: "var(--ui-status-error, #C84040)" }} />
      ) : (
        <Check size={10} className="shrink-0" style={{ color: "var(--ui-status-done, #48A870)" }} />
      )}
      {/* 工具图标 */}
      <span className="shrink-0" style={{ color: "var(--ui-text-3)", lineHeight: 0 }}>{icon}</span>
      {/* 标签 */}
      <span className="min-w-0 truncate">{displayText}</span>
      {/* 详情 */}
      {badgeLabel !== undefined && (
        <span className="ui-activity-item__badge ml-auto shrink-0" style={{ color: "var(--ui-text-3)" }}>{badgeLabel}</span>
      )}
      {hasEvidence && (
        <span className="ml-auto shrink-0" style={{ color: "var(--ui-text-3)" }}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      )}
      </button>
      {open && hasEvidence && (
        <div className="min-w-0 pb-1 pl-[34px] pt-2">
          <ActivityEvidencePanel
            item={item}
            toolResult={props.toolResult}
            showCanonicalToolResult={props.showCanonicalToolResult}
          />
        </div>
      )}
      {item.children !== undefined && item.children.length > 0 && (
        <div className="ml-3 mt-1 space-y-1 border-l pl-3" style={{ borderColor: "var(--ui-border)" }}>
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
