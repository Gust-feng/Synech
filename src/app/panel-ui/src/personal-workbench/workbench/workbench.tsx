import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CurrentRunProjection } from "../../features/conversations/run/projection";
import { projectChatActiveView } from "../../features/conversations/transcript/live-view";
import type { ChatInputProps } from "../../contracts/composer";
import { WorkbenchSettingsDialog, type WorkbenchSettingsDialogProps } from "../../features/settings/components/workbench-dialog";
import { WorkbenchBootstrapLoading } from "../../components/workbench-bootstrap-loading";
import type { Conversation, ConversationSummary } from "../../contracts/conversation";
import type { PendingConfirmation } from "../../contracts/run";
import type { PersonalSpaceActions, PersonalSpaceProjection } from "../space";
import { useWorkspaceProjection } from "../../features/spaces/workspace-state";

import { SurfaceErrorBoundary } from "./app/components/SurfaceErrorBoundary";



import { Sidebar } from "./app/components/Sidebar";

import { TopBar } from "./app/components/TopBar";
import type { ConversationSurfaceProjection } from "./app/components/conversation-surface-state";
import { WorkbenchViewRenderer } from "./app/components/WorkbenchViewRenderer";
import { WorkbenchViewTransition } from "./app/components/WorkbenchViewTransition";
import { WorkbenchStatusCenter, type WorkbenchStatusNotice } from "./app/components/WorkbenchStatusCenter";
import { projectLiveConversationState } from "./app/components/conversation-surface-state";
import { resolveById } from "./app/components/brainStore";
import {
  type ConversationOwnerSelection,
  type WorkbenchView,
} from "../../workbench/navigation-state";
import { useWorkbenchNavigation } from "../../workbench/use-workbench-navigation";
import { useConversationMode } from "../../workbench/use-conversation-mode";
import { useWorkbenchEnvironment } from "../../workbench/use-workbench-environment";

export type PersonalWorkbenchProps = {
  readonly personalKnowledgePersistenceEnabled?: boolean;
  readonly bootstrapState: {
    readonly status: "loading" | "ready" | "retrying" | "error";
    readonly error?: string;
    readonly onRetry: () => void;
  };
  readonly sidebarCollapsed: boolean;
  readonly onToggleSidebar: () => void;
  readonly conversation?: Conversation;
  readonly conversations: readonly ConversationSummary[];
  readonly currentRun: CurrentRunProjection;
  readonly inputProps: ChatInputProps;
  readonly showModelUsage: boolean;
  readonly developerModeEnabled: boolean;
  readonly error?: string;
  readonly onDismissError?: () => void;
  readonly pendingConfirmation?: PendingConfirmation | NonNullable<CurrentRunProjection["workView"]>["pendingConfirmation"];
  readonly confirmationBusy: boolean;
  readonly onDecision: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
  readonly onStartNewConversation: (owner?: ConversationOwnerSelection) => Promise<boolean>;
  readonly onOpenConversation: (conversationId: string) => boolean | Promise<boolean>;
  readonly pendingConversationIds?: ReadonlySet<string>;
  readonly onRenameConversation: (conversationId: string, title: string) => void | Promise<void>;
  readonly onToggleConversationPinned: (conversationId: string, pinned: boolean) => void | Promise<void>;
  readonly onDeleteConversation: (conversationId: string) => void | Promise<void>;
  readonly spaces?: readonly PersonalSpaceProjection[];
  readonly spaceLoadState?: {
    readonly loading: boolean;
    readonly mutationPending?: boolean;
    readonly error?: string;
    readonly onRetry: () => void | Promise<void>;
  };
  readonly onOpenSpace?: (spaceId: string) => void | Promise<void>;
  readonly onOpenSpaceItem?: (spaceId: string, itemId: string) => void | Promise<void>;
  readonly onCreateSpace?: (title: string) => void | Promise<void>;
  readonly spaceActions?: PersonalSpaceActions;
  readonly onOpenSettings: () => void;
  readonly settingsDialogProps?: WorkbenchSettingsDialogProps;
};

type ConversationMode = "normal" | "focus";

/** Conversation uses one canonical projection and is composed into the active Synech surface. */
export function PersonalWorkbench(props: PersonalWorkbenchProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const navigation = useWorkbenchNavigation();
  const {
    state: navigationState,
    navigate: reduceNavigation,
    setBrainSelection,
    setSpaceTarget,
    setActiveSpace,
    setHomeOwner,
    focusHomeInput,
    setConversationSurface,
    syncContextSelection,
  } = navigation;
  const {
    view,
    previousView,
    brainSelectedId,
    spaceTargetId,
    activeSpaceId,
    homeOwnerSelection,
    homeFocusRequest,
    conversationSurfaceRequest,
  } = navigationState;
  const navigationIntentRef = useRef(view);
  // 异步提交/打开会话的 .then 可能晚于本次 render 执行，这里始终镜像最新事实，
  // 避免闭包读到旧的 conversation / spaces / activeSpaceId。
  const conversationRef = useRef(props.conversation);
  conversationRef.current = props.conversation;
  const spacesRef = useRef(props.spaces);
  spacesRef.current = props.spaces;
  const activeSpaceIdRef = useRef(activeSpaceId);
  activeSpaceIdRef.current = activeSpaceId;
  // 会话 id 尚未确定（如首页提交后响应未落地）时，先记录承载空间，等真实会话
  // 落地（带 owner）后再由 landing effect 补写 conversationSurfaceRequest。
  const pendingSurfaceSpaceRef = useRef<string | null>(null);
  const activeConversation = props.conversation;
  const conversationProjection = projectConversationSurface(props, activeConversation);
  const conversationState = projectLiveConversationState({
    projection: conversationProjection,
    error: props.error,
    runStatus: props.currentRun.run?.status,
  });
  const workspaceProjection = useWorkspaceProjection(true);
  const { knowledgeLoadState, knowledgeError, retryKnowledge, refreshKnowledge, dismissKnowledgeError } = useWorkbenchEnvironment({
    rootRef,
    personalKnowledgePersistenceEnabled: props.personalKnowledgePersistenceEnabled === true,
    spaceLoadStateLoading: props.spaceLoadState?.loading === true,
    spaces: props.spaces ?? [],
    workspaceIds: workspaceProjection.workspaces.map((workspace) => workspace.workspaceId),
    view,
    syncContextSelection,
  });
  const surfaceTitle = view === "space"
    ? props.spaces?.find((space) => space.spaceId === activeSpaceId)?.title ?? "空间"
    : undefined;
  const surfaceOwner = undefined;

  const { mode: conversationMode, setMode: setConversationMode } = useConversationMode(rootRef);


  /** Resolve the active Conversation projection and its current Synech surface. */
  const surfaceConversation = (
    conversationId: string | undefined,
    owner?: ConversationOwnerSelection,
  ): void => {
    const effectiveOwner = owner ?? conversationRef.current?.owner;
    const targetSpaceId = effectiveOwner?.kind === "space"
      ? effectiveOwner.id
      : (activeSpaceIdRef.current ?? spacesRef.current?.[0]?.spaceId);
    if (targetSpaceId === undefined) return;
    setActiveSpace(targetSpaceId);
    if (conversationId !== undefined) {
      setConversationSurface({ conversationId, spaceId: targetSpaceId });
    } else {
      // 会话 id 尚未确定：记录承载空间，等待真实会话落地后由 effect 补写请求。
      pendingSurfaceSpaceRef.current = targetSpaceId;
    }
    navigate("space");
  };

  // 首页/侧栏/搜索打开会话后，提交响应或加载响应把真实会话写入 props.conversation。
  // 若当时会话 id 未知（pendingSurfaceSpaceRef 有值），在这里补写承载请求。
  // 乐观占位会话（无 owner 的 optimistic-*）期间不消费，等真实会话（固定 owner）落地。
  useEffect(() => {
    const pendingSpaceId = pendingSurfaceSpaceRef.current;
    if (pendingSpaceId === null) return;
    const conversation = props.conversation;
    if (conversation === undefined || conversation.owner === undefined) return;
    pendingSurfaceSpaceRef.current = null;
    const targetSpaceId = conversation.owner.kind === "space"
      ? conversation.owner.id
      : pendingSpaceId;
    setConversationSurface({ conversationId: conversation.conversationId, spaceId: targetSpaceId });
    // 只有用户仍停留在空间视图（提交后已导航过去）时才补导航；
    // 用户已主动离开则不劫持，request 仍保留，再次回到该空间时面板照常展示。
    if (navigationIntentRef.current === "space") {
      setActiveSpace(targetSpaceId);
      navigate("space");
    }
  }, [props.conversation]);

  // Startup recovery runs once after mount; when no surface is ready, Synech remains on Home.
  const startupRecoveryAttemptedRef = useRef(false);
  useEffect(() => {
    if (startupRecoveryAttemptedRef.current) return;
    startupRecoveryAttemptedRef.current = true;
    if (!requiresImmediateConversationView(props)) return;
    surfaceConversation(props.conversation?.conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 启动恢复只执行一次，闭包读取挂载时事实
  }, []);

  const navigate = (target: WorkbenchView): void => {
    // Record explicit intent synchronously so an already-resolving home
    // submission cannot navigate back after the user chose another surface.
    navigationIntentRef.current = target;
    const updateNavigation = (): void => {
      reduceNavigation(target);
    };
    if (conversationMode === "focus") {
      setConversationMode("normal", updateNavigation);
      return;
    }
    updateNavigation();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        navigate("search");
      }
      if (event.key === "Escape" && view === "search") navigate(previousView);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [conversationMode, previousView, view]);

  const homeInput = useMemo<ChatInputProps>(() => ({
    ...props.inputProps,
    autoFocus: true,
    placeholder: "想从哪里开始？",
    onSubmit: () => {
      if (props.inputProps.value.trim().length === 0) return;
      void props.onStartNewConversation(homeOwnerSelection ?? undefined).then((started) => {
        if (navigationIntentRef.current !== "home") return;
        if (started) {
          // Home creates the Conversation, then the host selects its presentation surface.
          // 会话 id 由提交响应确定（conversationRef 已镜像最新活动会话）；
          // owner 优先取首页选择器已确定的归属，响应未落地时由 landing effect 补写请求。
          surfaceConversation(conversationRef.current?.conversationId, homeOwnerSelection ?? undefined);
        } else {
          focusHomeInput();
        }
      });
    },
  }), [homeOwnerSelection, props.inputProps, props.onStartNewConversation]);

  /** Open an existing Conversation and let the host select its presentation surface. */
  const openConversationInSurface = useCallback(async (conversationId: string): Promise<boolean> => {
    const opened = await props.onOpenConversation(conversationId);
    if (opened === false) return false;
    surfaceConversation(conversationId);
    return true;
  }, [props.onOpenConversation]);

  const conversationInput = useMemo<ChatInputProps>(() => ({
    ...props.inputProps,
    autoFocus: true,
    placeholder: activeConversation === undefined ? "从一个想法开始" : "继续对话...",
  }), [activeConversation, props.inputProps]);
  const statusNotices = useMemo<readonly WorkbenchStatusNotice[]>(() => {
    const notices: WorkbenchStatusNotice[] = [];
    if (props.bootstrapState.status === "error") {
      notices.push({
        id: "bootstrap-error",
        message: props.bootstrapState.error ?? "工作台启动数据加载失败。",
        onRetry: props.bootstrapState.onRetry,
      });
    }
    if (props.bootstrapState.status === "retrying") {
      notices.push({ id: "bootstrap-retrying", message: "正在重新连接工作台...", retrying: true });
    }
    if (props.bootstrapState.status === "ready" && knowledgeLoadState.status === "error") {
      notices.push({
        id: "knowledge-load-error",
        message: knowledgeLoadState.message,
        onRetry: () => void retryKnowledge().catch(() => undefined),
      });
    }
    if (props.bootstrapState.status === "ready" && knowledgeLoadState.status === "ready" && knowledgeError !== undefined) {
      notices.push({
        id: "knowledge-refresh-error",
        message: knowledgeError,
        onRetry: () => void refreshKnowledge().catch(() => undefined),
        onDismiss: dismissKnowledgeError,
      });
    }
    if (props.error !== undefined && props.bootstrapState.status === "ready" && knowledgeError === undefined) {
      notices.push({ id: "conversation-error", message: props.error, onDismiss: props.onDismissError });
    }
    return notices;
  }, [
    dismissKnowledgeError,
    knowledgeError,
    knowledgeLoadState,
    props.bootstrapState,
    props.error,
    props.onDismissError,
    refreshKnowledge,
    retryKnowledge,
  ]);
  const showLoadingFallback = (
    props.bootstrapState.status === "loading" && view !== "home"
  ) || (
    isKnowledgeView(view) && (knowledgeLoadState.status === "loading" || knowledgeLoadState.status === "retrying")
  );
  return (
    <div
      ref={rootRef}
      className="ui-workbench-root flex h-screen min-h-0 w-full overflow-hidden"
      spellCheck={false}
      style={{
        backgroundColor: "var(--ui-canvas)",
        color: "var(--ui-text-1)",
        fontFamily: '"Noto Sans SC", Inter, system-ui, -apple-system, sans-serif',
      }}
    >
      <style>{`
        @keyframes viewFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .ui-workbench-root .view-enter { animation: viewFadeIn 140ms ease; }
      `}</style>
      <Sidebar
        view={view}
        collapsed={props.sidebarCollapsed}
        conversations={props.conversations}
        spaces={props.spaces ?? []}
        spaceLoadState={props.spaceLoadState}
        workspaces={workspaceProjection.workspaces}
        workspaceLoadState={{
          loading: workspaceProjection.loading,
          mutationPending: workspaceProjection.mutationPending,
          error: workspaceProjection.error,
          onRetry: workspaceProjection.refresh,
        }}
        onAddWorkspace={workspaceProjection.addWorkspace}
        onHideWorkspace={workspaceProjection.hideWorkspace}
        onReconnectWorkspace={workspaceProjection.reconnectWorkspace}
        activeSpaceId={activeSpaceId}
        activeConversationId={props.conversation?.conversationId}
        onNavigate={navigate}
        onOpenConversation={openConversationInSurface}
        pendingConversationIds={props.pendingConversationIds ?? EMPTY_ID_SET}
        onRenameConversation={props.onRenameConversation}
        onToggleConversationPinned={props.onToggleConversationPinned}
        onDeleteConversation={props.onDeleteConversation}
        onOpenSpace={props.onOpenSpace}
        onActiveSpaceChange={(id) => setActiveSpace(id)}
        onCreateSpace={props.onCreateSpace}
        onRenameSpace={props.spaceActions?.rename === undefined
          ? undefined
          : (spaceId, title) => props.spaceActions?.rename?.({ kind: "space", id: spaceId }, title)}
        onDeleteSpace={props.spaceActions?.deleteSpace}
        onOpenSettings={props.onOpenSettings}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          view={view}
          onNavigate={navigate}
          onSearch={() => navigate("search")}
          sidebarCollapsed={props.sidebarCollapsed}
          onToggleSidebar={props.onToggleSidebar}
          surfaceTitle={surfaceTitle}
          surfaceOwner={surfaceOwner}
          conversationState={conversationState}
          onEnterFocus={undefined}
          brainFileTitle={brainSelectedId === null ? null : resolveById(brainSelectedId)?.title ?? null}
          onBrainRoot={() => setBrainSelection(null)}
        />

        <main
          aria-label={viewLabel(view)}
          className="ui-workbench-main flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <WorkbenchViewTransition view={view}>
            {showLoadingFallback ? <WorkbenchBootstrapLoading /> : (
              <SurfaceErrorBoundary resetKey={view} label="这个视图暂时无法打开">
                  <WorkbenchViewRenderer
                    view={view}
                    spaces={props.spaces ?? []}
                    conversations={props.conversations}
                    spaceActions={props.spaceActions}
                    onOpenSpaceItem={props.onOpenSpaceItem}
                    onOpenConversation={props.onOpenConversation}
                    onRenameConversation={props.onRenameConversation}
                    onToggleConversationPinned={props.onToggleConversationPinned}
                    onDeleteConversation={props.onDeleteConversation}
                    activeConversation={activeConversation}
                    conversationProjection={conversationProjection}
                    conversationState={conversationState}
                    currentRun={props.currentRun}
                    showModelUsage={props.showModelUsage}
                    developerModeEnabled={props.developerModeEnabled}
                    confirmationBusy={props.confirmationBusy}
                    onDecision={props.onDecision}
                    homeInput={homeInput}
                    homeFocusRequest={homeFocusRequest}
                    workspaceProjection={workspaceProjection}
                    homeOwnerSelection={homeOwnerSelection}
                    onHomeOwnerChange={setHomeOwner}
                    conversationInput={conversationInput}
                    brainSelectedId={brainSelectedId}
                    spaceTargetId={spaceTargetId}
                    activeSpaceId={activeSpaceId}
                    onActiveSpaceChange={setActiveSpace}
                    conversationMode={conversationMode}
                    conversationSurfaceRequest={conversationSurfaceRequest}
                    onBrainSelect={setBrainSelection}
                    navigate={navigate}
                    onEnterFocus={() => setConversationMode("focus")}
                    onExitFocus={() => setConversationMode("normal")}
                    onOpenConversationInSurface={openConversationInSurface}
                    onOpenInSpace={(spaceId, id) => {
                      // Navigation clears stale targets; apply the explicit
                      // search target after entering the Space surface so it
                      // remains available to SpacePage for this transition.
                      navigate("space");
                      setActiveSpace(spaceId);
                      setSpaceTarget(id);
                    }}
                  />
              </SurfaceErrorBoundary>
            )}
          </WorkbenchViewTransition>
        </main>
      </div>

      <WorkbenchStatusCenter notices={statusNotices} />

      {props.settingsDialogProps?.open === true && <WorkbenchSettingsDialog {...props.settingsDialogProps} />}
    </div>
  );
}

function viewLabel(view: WorkbenchView): string {
  switch (view) {
    case "home": return "个人首页";
    case "space": return "空间";
    case "brain": return "知识库";
    case "search": return "搜索";
  }
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set();

function projectConversationSurface(
  props: PersonalWorkbenchProps,
  conversation: Conversation | undefined,
) {
  return projectChatActiveView({
    conversation,
    run: props.currentRun.run,
    workView: props.currentRun.workView,
    transcriptNodes: props.currentRun.transcriptNodes,
    detail: props.currentRun.detail,
    live: props.currentRun.live,
    error: props.error,
    pendingConfirmation: props.pendingConfirmation,
  });
}

function isKnowledgeView(view: WorkbenchView): boolean {
  return view === "space" || view === "brain" || view === "search";
}

function requiresImmediateConversationView(props: Pick<PersonalWorkbenchProps, "currentRun" | "pendingConfirmation">): boolean {
  return props.pendingConfirmation !== undefined
    || props.currentRun.run?.status === "running";
}
