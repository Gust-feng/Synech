import { AlertCircle, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { CurrentRunProjection } from "../../features/conversations/run/projection";
import { projectChatActiveView } from "../../features/conversations/transcript/live-view";
import type { ChatInputProps } from "../../contracts/composer";
import { WorkbenchSettingsDialog, type WorkbenchSettingsDialogProps } from "../../features/settings/components/workbench-dialog";
import { WorkbenchBootstrapLoading } from "../../components/workbench-bootstrap-loading";
import type { Conversation, ConversationSummary } from "../../contracts/conversation";
import type { PendingConfirmation } from "../../contracts/run";
import type { ConfirmationProjection } from "./app/components/ConfirmationCard";
import type { PersonalSpaceActions, PersonalSpaceProjection } from "../space";
import { useWorkspaceProjection } from "../../features/spaces/workspace-state";
import { ConversationPage } from "./app/components/ConversationPage";
import { BrainPage } from "./app/components/BrainPage";
import { SurfaceErrorBoundary } from "./app/components/SurfaceErrorBoundary";
import { HomePage } from "./app/components/HomePage";
import { MemoryPage } from "./app/components/MemoryPage";
import { ConversationTranscript } from "./app/components/ConversationTranscript";
import { SearchPage } from "./app/components/SearchPage";
import { type View, Sidebar } from "./app/components/Sidebar";
import { SpacePage } from "./app/components/SpacePage";
import { TopBar } from "./app/components/TopBar";
import type { LiveConversationState } from "./app/components/conversation-surface-state";
import { runFocusModeTransition, type FocusModeTransitionHandle } from "./app/components/focus-mode-transition";
import { resolveById } from "./app/components/brainStore";
import { warmStartupReferencePreviews } from "./app/components/space-reference-preview-warmup";
import { applyPrefs, handleReadingSizeWheel, loadPrefs } from "../../shell/reading-preferences";
import {
  initializePersonalKnowledge,
  getPersonalKnowledgeError,
  getPersonalKnowledgeLoadState,
  refreshPersonalKnowledge,
  subscribePersonalKnowledge,
  setActivePersonalKnowledgeSpace,
  setPersonalKnowledgePersistenceEnabled,
  clearPersonalKnowledgeError,
} from "./app/components/personalKnowledgeClient";

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
  readonly onStartNewConversation: (owner?: { readonly kind: "space" | "workspace"; readonly id: string }) => Promise<boolean>;
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

/** 宿主统一会话承载请求：指定某个会话在哪个空间右侧对话面板展示。 */
type ConversationSurfaceRequest = { readonly conversationId: string; readonly spaceId: string };

/** Conversation uses one canonical projection and is composed into the active Synech surface. */
export function PersonalWorkbench(props: PersonalWorkbenchProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(initialView);
  const [conversationMode, setConversationModeState] = useState<ConversationMode>("normal");
  const [previousView, setPreviousView] = useState<View>("home");
  const [brainSelectedId, setBrainSelectedId] = useState<string | null>(null);
  const [spaceTargetId, setSpaceTargetId] = useState<string | null>(null);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [homeOwnerSelection, setHomeOwnerSelection] = useState<{ readonly kind: "space" | "workspace"; readonly id: string } | null>(null);
  const [homeFocusRequest, setHomeFocusRequest] = useState(0);
  // The host surface request selects where the canonical Conversation projection is presented.
  const [conversationSurfaceRequest, setConversationSurfaceRequest] = useState<ConversationSurfaceRequest | null>(null);
  const observedViewRef = useRef(view);
  const navigationIntentRef = useRef(view);
  const focusTransitionRef = useRef<FocusModeTransitionHandle | null>(null);
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
  const knowledgeLoadState = useSyncExternalStore(
    subscribePersonalKnowledge,
    getPersonalKnowledgeLoadState,
    getPersonalKnowledgeLoadState,
  );
  const knowledgeError = useSyncExternalStore(
    subscribePersonalKnowledge,
    getPersonalKnowledgeError,
    getPersonalKnowledgeError,
  );

  const activeConversation = props.conversation;
  const conversationProjection = projectConversationSurface(props, activeConversation);
  const conversationState = projectLiveConversationState(conversationProjection, props);
  const workspaceProjection = useWorkspaceProjection(true);
  const surfaceTitle = view === "space"
    ? props.spaces?.find((space) => space.spaceId === activeSpaceId)?.title ?? "空间"
    : undefined;
  const surfaceOwner = undefined;

  useEffect(() => {
    setPersonalKnowledgePersistenceEnabled(props.personalKnowledgePersistenceEnabled === true);
  }, [props.personalKnowledgePersistenceEnabled]);

  useEffect(() => {
    const spaces = props.spaces ?? [];
    const firstSpaceId = spaces[0]?.spaceId;
    setActiveSpaceId((current) => current !== null && spaces.some((space) => space.spaceId === current)
      ? current
      : firstSpaceId ?? null);
    setHomeOwnerSelection((current) => {
      if (current !== null && (
        (current.kind === "space" && spaces.some((space) => space.spaceId === current.id)) ||
        (current.kind === "workspace" && workspaceProjection.workspaces.some((workspace) => workspace.workspaceId === current.id))
      )) return current;
      return firstSpaceId === undefined ? null : { kind: "space", id: firstSpaceId };
    });
    if (props.personalKnowledgePersistenceEnabled && props.spaceLoadState?.loading !== true) {
      void initializePersonalKnowledge(firstSpaceId).catch(() => undefined);
    }
  }, [props.personalKnowledgePersistenceEnabled, props.spaceLoadState?.loading, props.spaces, workspaceProjection.workspaces]);

  useEffect(() => {
    if (props.spaceLoadState?.loading === true) return undefined;
    return warmStartupReferencePreviews(props.spaces ?? []);
  }, [props.spaceLoadState?.loading, props.spaces]);

  useEffect(() => {
    setActivePersonalKnowledgeSpace(view === "space" ? activeSpaceId ?? undefined : undefined);
  }, [activeSpaceId, view]);

  useEffect(() => {
    const viewChanged = observedViewRef.current !== view;
    observedViewRef.current = view;
    if (
      !viewChanged
      || !props.personalKnowledgePersistenceEnabled
      || !isKnowledgeView(view)
      || knowledgeLoadState.status !== "ready"
    ) return;
    void refreshPersonalKnowledge().catch(() => undefined);
  }, [knowledgeLoadState.status, props.personalKnowledgePersistenceEnabled, view]);

  useEffect(() => () => {
    focusTransitionRef.current?.cancel();
    focusTransitionRef.current = null;
  }, []);

  useEffect(() => {
    applyPrefs(loadPrefs());
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      handleReadingSizeWheel(event);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, []);

  const setConversationMode = (next: ConversationMode, after?: () => void): void => {
    if (next === conversationMode) {
      after?.();
      return;
    }
    focusTransitionRef.current?.cancel();
    focusTransitionRef.current = runFocusModeTransition({
      root: rootRef.current,
      direction: next === "focus" ? "enter" : "exit",
      update: () => flushSync(() => {
        setConversationModeState(next);
        after?.();
      }),
    });
  };

  /** Resolve the active Conversation projection and its current Synech surface. */
  const surfaceConversation = (
    conversationId: string | undefined,
    owner?: { readonly kind: "space" | "workspace"; readonly id: string },
  ): void => {
    const effectiveOwner = owner ?? conversationRef.current?.owner;
    const targetSpaceId = effectiveOwner?.kind === "space"
      ? effectiveOwner.id
      : (activeSpaceIdRef.current ?? spacesRef.current?.[0]?.spaceId);
    if (targetSpaceId === undefined) return;
    setActiveSpaceId(targetSpaceId);
    if (conversationId !== undefined) {
      setConversationSurfaceRequest({ conversationId, spaceId: targetSpaceId });
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
    setConversationSurfaceRequest({ conversationId: conversation.conversationId, spaceId: targetSpaceId });
    // 只有用户仍停留在空间视图（提交后已导航过去）时才补导航；
    // 用户已主动离开则不劫持，request 仍保留，再次回到该空间时面板照常展示。
    if (navigationIntentRef.current === "space") {
      setActiveSpaceId(targetSpaceId);
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

  const navigate = (target: View): void => {
    // Record explicit intent synchronously so an already-resolving home
    // submission cannot navigate back after the user chose another surface.
    navigationIntentRef.current = target;
    const updateNavigation = (): void => {
      if (target === "search") setPreviousView(view);
      // Only search navigation sets a target explicitly. Normal navigation must
      // clear it, otherwise a later Space switch can reuse an id from another Space.
      setSpaceTargetId(null);
      if (target !== "brain") setBrainSelectedId(null);
      setView(target);
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
          setHomeFocusRequest((current) => current + 1);
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
        background: "var(--ui-canvas)",
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
        onActiveSpaceChange={setActiveSpaceId}
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
          onBrainRoot={() => setBrainSelectedId(null)}
        />

        <main
          aria-label={viewLabel(view)}
          className="ui-workbench-main flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <div
            className={`${view === "space" ? "" : "view-enter "}flex min-h-0 flex-1 flex-col overflow-hidden`}
            key={view}
          >
            {showLoadingFallback ? <WorkbenchBootstrapLoading /> : (
              <SurfaceErrorBoundary resetKey={view} label="这个视图暂时无法打开">
                  {renderView({
                    view,
                    props,
                    activeConversation,
                    conversationProjection,
                    conversationState,
                    homeInput,
                    homeFocusRequest,
                    workspaceProjection,
                    homeOwnerSelection,
                    onHomeOwnerChange: setHomeOwnerSelection,
                    conversationInput,
                    brainSelectedId,
                    spaceTargetId,
                    activeSpaceId,
                    onActiveSpaceChange: setActiveSpaceId,
                    conversationMode,
                    conversationSurfaceRequest,
                    onBrainSelect: setBrainSelectedId,
                    navigate,
                    onEnterFocus: () => setConversationMode("focus"),
                    onExitFocus: () => setConversationMode("normal"),
                    onOpenConversationInSurface: openConversationInSurface,
                    onOpenInSpace: (spaceId, id) => {
                      setActiveSpaceId(spaceId);
                      setSpaceTargetId(id);
                      navigate("space");
                    },
                  })}
              </SurfaceErrorBoundary>
            )}
          </div>
        </main>
      </div>

      {props.bootstrapState.status === "error" && (
        <WorkbenchStatusNotice
          message={props.bootstrapState.error ?? "工作台启动数据加载失败。"}
          onRetry={props.bootstrapState.onRetry}
          retrying={false}
        />
      )}

      {props.bootstrapState.status === "retrying" && (
        <WorkbenchStatusNotice message="正在重新连接工作台..." retrying />
      )}

      {props.bootstrapState.status === "ready" && knowledgeLoadState.status === "error" && (
        <WorkbenchStatusNotice
          message={knowledgeLoadState.message}
          onRetry={() => void initializePersonalKnowledge(activeSpaceId ?? undefined).catch(() => undefined)}
        />
      )}

      {props.bootstrapState.status === "ready" && knowledgeLoadState.status === "ready" && knowledgeError !== undefined && (
        <WorkbenchStatusNotice
          message={knowledgeError}
          onRetry={() => void refreshPersonalKnowledge().catch(() => undefined)}
          onDismiss={clearPersonalKnowledgeError}
        />
      )}

      {props.error !== undefined && props.bootstrapState.status === "ready" && knowledgeError === undefined && (
        <WorkbenchStatusNotice message={props.error} onDismiss={props.onDismissError} />
      )}

      {props.settingsDialogProps?.open === true && <WorkbenchSettingsDialog {...props.settingsDialogProps} />}
    </div>
  );
}

function viewLabel(view: View): string {
  switch (view) {
    case "home": return "个人首页";
    case "space": return "空间";
    case "brain": return "知识库";
    case "memory": return "记忆";
    case "search": return "搜索";
  }
}

function renderView(input: {
  readonly view: View;
  readonly props: PersonalWorkbenchProps;
  readonly activeConversation?: Conversation;
  readonly conversationProjection: ConversationSurfaceProjection;
  readonly conversationState: LiveConversationState;
  readonly homeInput: ChatInputProps;
  readonly homeFocusRequest: number;
  readonly workspaceProjection: ReturnType<typeof useWorkspaceProjection>;
  readonly homeOwnerSelection: { readonly kind: "space" | "workspace"; readonly id: string } | null;
  readonly onHomeOwnerChange: (owner: { readonly kind: "space" | "workspace"; readonly id: string } | null) => void;
  readonly conversationInput: ChatInputProps;
  readonly brainSelectedId: string | null;
  readonly spaceTargetId: string | null;
  readonly activeSpaceId: string | null;
  readonly onActiveSpaceChange: (spaceId: string | null) => void;
  readonly conversationMode: ConversationMode;
  readonly conversationSurfaceRequest: ConversationSurfaceRequest | null;
  readonly onBrainSelect: (id: string | null) => void;
  readonly navigate: (view: View) => void;
  readonly onEnterFocus: () => void;
  readonly onExitFocus: () => void;
  readonly onOpenConversationInSurface: (conversationId: string) => boolean | Promise<boolean>;
  readonly onOpenInSpace: (spaceId: string, id: string) => void;
}) {
  if (input.view === "home") {
    return <HomePage
      spaces={input.props.spaces ?? []}
      workspaces={input.workspaceProjection.workspaces}
      ownerSelection={input.homeOwnerSelection}
      onOwnerChange={input.onHomeOwnerChange}
      input={input.homeInput}
      focusRequest={input.homeFocusRequest}
    />;
  }
  if (input.view === "space") {
    const activeSpace = input.props.spaces?.find((space) => space.spaceId === input.activeSpaceId);
    return <SpacePage
      onNavigate={input.navigate}
      targetId={input.spaceTargetId}
      space={activeSpace}
      actions={input.props.spaceActions}
      onOpenItem={input.props.onOpenSpaceItem}
      onOpenConversation={input.props.onOpenConversation}
      activeConversationId={input.activeConversation?.conversationId}
      activeConversationOwner={input.activeConversation?.owner}
      activeConversationTitle={input.activeConversation?.title}
      conversationSurfaceRequest={input.conversationSurfaceRequest}
      conversationContent={
        <ConversationSurface
          props={input.props}
          conversation={input.activeConversation}
          projection={input.conversationProjection}
          state={input.conversationState}
          input={input.conversationInput}
          focus={input.conversationMode === "focus"}
          onExitFocus={input.onExitFocus}
        />
      }
      onEnterFocus={input.conversationMode === "normal" ? input.onEnterFocus : undefined}
      onRenameConversation={input.props.onRenameConversation}
      onToggleConversationPinned={input.props.onToggleConversationPinned}
      onDeleteConversation={input.props.onDeleteConversation}
    />;
  }
  if (input.view === "brain") {
    return <BrainPage
      selectedId={input.brainSelectedId}
      onSelect={input.onBrainSelect}
    />;
  }
  if (input.view === "memory") {
    return <MemoryPage />;
  }
  if (input.view === "search") {
    return <SearchPage
      onNavigate={input.navigate}
      onOpenInSpace={input.onOpenInSpace}
      onOpenInKnowledge={(id) => {
        input.onBrainSelect(id);
        input.navigate("brain");
      }}
      // Search opens the same Conversation projection used by the Synech host.
      onOpenConversation={input.onOpenConversationInSurface}
      spaces={input.props.spaces ?? []}
      conversations={input.props.conversations}
    />;
  }
  return null;
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set();

function ConversationSurface(props: {
  readonly props: PersonalWorkbenchProps;
  readonly conversation?: Conversation;
  readonly projection: ConversationSurfaceProjection;
  readonly state: LiveConversationState;
  readonly input: ChatInputProps;
  readonly focus?: boolean;
  readonly onExitFocus?: () => void;
}) {
  const active = props.projection;
  const composerInput = confirmationGuidanceInput(
    props.input,
    active.pending,
    props.props.confirmationBusy,
    props.props.onDecision,
  );
  const content = active.hasVisibleContent ? (
    <SurfaceErrorBoundary resetKey={props.props.currentRun.run?.runId ?? props.conversation?.conversationId ?? "transcript"} label="对话内容暂时无法显示">
        <ConversationTranscript
      conversationId={props.conversation?.conversationId}
      projectedTurns={active.workline.turns}
      turns={props.conversation?.turns ?? []}
      currentRunId={active.currentRunId}
      currentRunNodes={active.currentRunProjection.nodes}
      currentRunToolResults={props.props.currentRun.detail?.toolResults ?? []}
      run={props.props.currentRun.run}
      live={props.props.currentRun.live}
      workView={props.props.currentRun.workView}
      pending={active.pending}
      showModelUsage={props.props.showModelUsage}
      developerModeEnabled={props.props.developerModeEnabled}
      standaloneRun={active.workline.standaloneRun !== true ? undefined : {
        currentRunId: active.currentRunId,
        runStatus: props.props.currentRun.run?.status,
        answer: active.answer,
        failure: props.props.currentRun.detail?.error,
        deliverable: active.deliverable,
        runProjection: active.currentRunProjection,
        pending: active.pending,
      }}
      models={props.input.models}
      selectedModelId={props.input.selectedModelId}
      onDecision={props.props.onDecision}
      confirmationBusy={props.props.confirmationBusy}
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

type ConversationSurfaceProjection = ReturnType<typeof projectConversationSurface>;

function projectLiveConversationState(
  active: ConversationSurfaceProjection,
  props: PersonalWorkbenchProps,
): LiveConversationState {
  if (active.pending !== undefined) return "attention";
  if (active.running) return "working";
  if (props.error !== undefined || isFailedRun(props.currentRun.run?.status)) return "failed";
  return active.hasVisibleContent ? "completed" : "initial";
}

function isKnowledgeView(view: View): boolean {
  return view === "space" || view === "brain" || view === "search";
}

function WorkbenchStatusNotice(props: {
  readonly message: string;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
  readonly onDismiss?: () => void;
}) {
  return (
    <div
      className="fixed bottom-5 right-5 z-50 flex max-w-sm items-start gap-2.5 rounded-md px-3 py-2.5 shadow-sm"
      style={{ background: "var(--ui-surface)", border: "1px solid var(--ui-border)", color: "var(--ui-text-2)" }}
      role="alert"
    >
      <AlertCircle className="mt-0.5 shrink-0" size={14} style={{ color: "var(--ui-status-error)" }} />
      <span className="min-w-0 flex-1 break-words text-xs leading-5">{props.message}</span>
      {props.onRetry !== undefined && (
        <button
          type="button"
          aria-label="重新加载工作台数据"
          onClick={props.onRetry}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--ui-hover-tint)] disabled:opacity-40"
          style={{ color: "var(--ui-text-3)" }}
          disabled={props.retrying}
        >
          <RotateCcw className={props.retrying ? "animate-spin" : undefined} size={12} />
        </button>
      )}
      {props.onDismiss !== undefined && (
        <button
          type="button"
          aria-label="关闭错误提示"
          onClick={props.onDismiss}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--ui-hover-tint)]"
          style={{ color: "var(--ui-text-3)" }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function confirmationGuidanceInput(
  input: ChatInputProps,
  pending: ConfirmationProjection | undefined,
  confirmationBusy: boolean,
  onDecision: PersonalWorkbenchProps["onDecision"],
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

/** The initial navigation target is Home; active run recovery is handled after mount. */
function initialView(): View {
  return "home";
}

function requiresImmediateConversationView(props: Pick<PersonalWorkbenchProps, "currentRun" | "pendingConfirmation">): boolean {
  return props.pendingConfirmation !== undefined
    || props.currentRun.run?.status === "running";
}

function isFailedRun(status: string | undefined): boolean {
  return status === "failed" || status === "blocked" || status === "cancelled";
}
