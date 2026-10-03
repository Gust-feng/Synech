import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CurrentRunProjection } from "../../features/conversations/run/projection";
import { projectChatActiveView } from "../../features/conversations/transcript/live-view";
import type { ChatInputProps } from "../../contracts/composer";
import { WorkbenchSettingsDialog, type WorkbenchSettingsDialogProps } from "../../features/settings/components/workbench-dialog";
import { WorkbenchBootstrapLoading } from "../../components/workbench-bootstrap-loading";
import type { Conversation, ConversationSummary } from "../../contracts/conversation";
import type { PendingConfirmation } from "../../contracts/run";
import type { PersonalSpaceActions, PersonalSpaceProjection } from "../space";
import type { SettingsGroup } from "../../features/settings/components/types";

import { SurfaceErrorBoundary } from "./app/components/SurfaceErrorBoundary";



import { Sidebar } from "./app/components/Sidebar";

import { TopBar } from "./app/components/TopBar";
import { ConversationSurface } from "./app/components/ConversationSurface";
import { WorkbenchConversationPane } from "./app/components/WorkbenchConversationPane";
import { WorkbenchPanes } from "./app/components/WorkbenchPanes";
import { WorkbenchViewRenderer } from "./app/components/WorkbenchViewRenderer";
import { WorkbenchViewTransition } from "./app/components/WorkbenchViewTransition";
import { WorkbenchStatusCenter, type WorkbenchStatusNotice } from "./app/components/WorkbenchStatusCenter";
import { projectLiveConversationState } from "./app/components/conversation-surface-state";
import {
  sameConversationOwner,
  selectedConversationOwner,
  type ConversationOwnerSelection,
  type WorkbenchView,
} from "../../workbench/navigation-state";
import { useWorkbenchNavigation } from "../../workbench/use-workbench-navigation";
import { useConversationMode } from "../../workbench/use-conversation-mode";
import { useWorkbenchEnvironment } from "../../workbench/use-workbench-environment";
import { useWorkbenchLayout, type WorkbenchLayoutMode } from "../../workbench/use-workbench-layout";
import { PreviewLayoutContext } from "../../workbench/preview-layout";

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
  readonly developerModeEnabled: boolean;
  readonly error?: string;
  readonly onDismissError?: () => void;
  readonly pendingConfirmation?: PendingConfirmation | NonNullable<CurrentRunProjection["workView"]>["pendingConfirmation"];
  readonly confirmationBusy: boolean;
  readonly onDecision: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
  readonly onSelectBranch: (runId: string) => Promise<void>;
  readonly onEditTurn: (runId: string, content: string) => Promise<boolean>;
  readonly onStartNewConversation: (owner?: ConversationOwnerSelection) => Promise<boolean>;
  readonly onResetConversation: () => void;
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
  readonly onOpenSettings?: (group?: SettingsGroup) => void;
  readonly settingsDialogProps?: WorkbenchSettingsDialogProps;
};

/** Reading navigation and the canonical conversation share one stable workbench layout. */
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
  } = navigationState;
  const navigationIntentRef = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  // 异步提交/打开会话的 .then 可能晚于本次 render 执行，这里始终镜像最新事实，
  // 避免闭包读到旧的 conversation / spaces / activeSpaceId。
  const conversationRef = useRef(props.conversation);
  conversationRef.current = props.conversation;
  const activeConversation = props.conversation;
  const displayedOwner = useMemo(() => selectedConversationOwner(navigationState), [view, activeSpaceId]);
  // The runtime has one active Conversation, while this surface represents one owner.
  // Never render a previous Space's transcript inside the newly selected Space.
  const foreignConversationActive = activeConversation !== undefined
    && displayedOwner !== null
    && !sameConversationOwner(activeConversation.owner, displayedOwner);
  const visibleConversation = foreignConversationActive ? undefined : activeConversation;
  const conversationProjection = projectConversationSurface(props, visibleConversation);
  const conversationState = projectLiveConversationState({
    projection: conversationProjection,
    error: visibleConversation === undefined ? undefined : props.error,
    runStatus: visibleConversation === undefined ? undefined : props.currentRun.run?.status,
  });
  const { knowledgeLoadState, knowledgeError, retryKnowledge, refreshKnowledge, dismissKnowledgeError } = useWorkbenchEnvironment({
    rootRef,
    personalKnowledgePersistenceEnabled: props.personalKnowledgePersistenceEnabled === true,
    spaceLoadStateLoading: props.spaceLoadState?.loading === true,
    spaces: props.spaces ?? [],
    view,
    syncContextSelection,
  });
  const surfaceTitle = view === "space"
    ? props.spaces?.find((space) => space.spaceId === activeSpaceId)?.title ?? "空间"
    : undefined;
  const layout = useWorkbenchLayout();
  const layoutMode = view === "home" ? "reading" : layout.mode;
  const conversationScope = displayedOwner ?? visibleConversation?.owner ?? homeOwnerSelection;
  const conversationItems = useMemo(() => {
    if (displayedOwner === null) return [];
    const items = props.conversations.filter((item) => sameConversationOwner(item.owner, displayedOwner));
    if (visibleConversation !== undefined && !items.some((item) => item.conversationId === visibleConversation.conversationId)) {
      items.unshift(visibleConversation);
    }
    return items;
  }, [displayedOwner?.kind, displayedOwner?.id, props.conversations, visibleConversation]);
  const { mode: conversationMode, setMode: setConversationMode } = useConversationMode(rootRef);

  const revealConversation = useCallback((owner?: ConversationOwnerSelection): void => {
    // Single-surface navigation follows the conversation owner; an explicit split keeps its reader.
    if (!layout.splitEnabled || viewRef.current === "home") {
      const effectiveOwner = owner ?? conversationRef.current?.owner ?? homeOwnerSelection;
      if (effectiveOwner === undefined || effectiveOwner === null) return;
      setActiveSpace(effectiveOwner.id);
      viewRef.current = "space";
      reduceNavigation("space");
    }
    layout.showConversation();
  }, [homeOwnerSelection, layout.splitEnabled, layout.showConversation, reduceNavigation, setActiveSpace]);

  const activateReading = useCallback(() => {
    navigationIntentRef.current += 1;
    layout.showReading();
  }, [layout.showReading]);

  const openReadingPreview = useCallback(() => {
    activateReading();
  }, [activateReading]);

  const selectKnowledge = useCallback((id: string | null) => {
    setBrainSelection(id);
    if (id === null) activateReading();
    else openReadingPreview();
  }, [activateReading, openReadingPreview, setBrainSelection]);

  // Startup recovery runs once after mount; when no surface is ready, Synech remains on Home.
  const startupRecoveryAttemptedRef = useRef(false);
  useEffect(() => {
    if (startupRecoveryAttemptedRef.current) return;
    startupRecoveryAttemptedRef.current = true;
    if (!requiresImmediateConversationView(props)) return;
    revealConversation(props.conversation?.owner);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 启动恢复只执行一次，闭包读取挂载时事实
  }, []);

  const navigate = (target: WorkbenchView): void => {
    // Record explicit intent synchronously so an already-resolving home
    // submission cannot navigate back after the user chose another surface.
    navigationIntentRef.current += 1;
    viewRef.current = target;
    const updateNavigation = (): void => {
      reduceNavigation(target);
      if (target === "home") layout.setMode("reading");
      else if (target === "space") layout.setMode("reading");
      else layout.showReading();
    };
    if (conversationMode === "focus") {
      setConversationMode("normal", updateNavigation);
      return;
    }
    updateNavigation();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
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
    autoFocus: view === "home",
    placeholder: "想从哪里开始？",
    onSubmit: () => {
      if (props.inputProps.value.trim().length === 0) return;
      const intent = navigationIntentRef.current;
      void props.onStartNewConversation(homeOwnerSelection ?? undefined).then((started) => {
        if (navigationIntentRef.current !== intent) return;
        if (started) revealConversation(homeOwnerSelection ?? undefined);
        else if (viewRef.current === "home") focusHomeInput();
      });
    },
  }), [view, homeOwnerSelection, props.inputProps, props.onStartNewConversation, revealConversation, focusHomeInput]);

  /** Open an existing Conversation and let the host select its presentation surface. */
  const openConversationInSurface = useCallback(async (conversationId: string): Promise<boolean> => {
    const intent = navigationIntentRef.current;
    const opened = await props.onOpenConversation(conversationId);
    if (opened === false) return false;
    const summary = props.conversations.find((item) => item.conversationId === conversationId);
    if (navigationIntentRef.current === intent) revealConversation(summary?.owner);
    return true;
  }, [props.onOpenConversation, props.conversations, revealConversation]);

  const conversationInput = useMemo<ChatInputProps>(() => ({
    ...props.inputProps,
    // Browsing and layout changes never take focus away from the reader.
    autoFocus: false,
    busy: props.inputProps.busy || (visibleConversation === undefined && conversationScope === null),
    allowInputWhileBusy: visibleConversation === undefined && conversationScope === null ? false : props.inputProps.allowInputWhileBusy,
    placeholder: visibleConversation !== undefined ? "继续对话..." : conversationScope === null ? "先从左侧选择一个空间" : "从一个想法开始",
    onSubmit: visibleConversation !== undefined ? props.inputProps.onSubmit : () => {
      if (conversationScope === null || props.inputProps.value.trim().length === 0) return;
      const intent = navigationIntentRef.current;
      const owner = conversationScope;
      void props.onStartNewConversation(owner).then((started) => {
        if (started && navigationIntentRef.current === intent) revealConversation(owner);
      });
    },
  }), [visibleConversation, conversationScope?.kind, conversationScope?.id, props.inputProps, props.onStartNewConversation, revealConversation]);
  const newConversation = () => {
    if (props.inputProps.busy || props.inputProps.running === true || conversationScope === null) return;
    navigationIntentRef.current += 1;
    if (conversationScope.kind !== "space") return;
    setHomeOwner({ kind: "space", id: conversationScope.id });
    props.onResetConversation();
    layout.showConversation();
  };

  const conversationSurface = (
    <ConversationSurface
      conversation={visibleConversation}
      projection={conversationProjection}
      state={conversationState}
      input={conversationInput}
      currentRun={props.currentRun}
      developerModeEnabled={props.developerModeEnabled}
      confirmationBusy={props.confirmationBusy}
      onDecision={props.onDecision}
      onEditTurn={props.onEditTurn}
      onSelectBranch={props.onSelectBranch}
      focus={conversationMode === "focus"}
      onExitFocus={() => setConversationMode("normal")}
    />
  );
  const changeLayout = (mode: WorkbenchLayoutMode): void => {
    if (mode === "split" && layout.compact) return;
    if (mode === (layout.splitEnabled ? "split" : layoutMode)) return;
    navigationIntentRef.current += 1;
    if (mode === "reading" && rootRef.current?.querySelector(".ui-workbench-conversation")?.contains(document.activeElement)) {
      const trigger = rootRef.current.querySelector<HTMLButtonElement>('[data-split-toggle]')
        ?? rootRef.current.querySelector<HTMLButtonElement>('[data-explorer-toggle]')
        ?? rootRef.current.querySelector<HTMLButtonElement>('.topbar-nav-button');
      trigger?.focus({ preventScroll: true });
    }
    layout.setMode(mode);
  };
  const toggleCollaboration = (): void => {
    const opening = !layout.splitEnabled;
    if (opening && !props.sidebarCollapsed) props.onToggleSidebar();
    changeLayout(opening ? "split" : "reading");
  };
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
    if (props.error !== undefined && props.bootstrapState.status === "ready" && knowledgeError === undefined && !foreignConversationActive) {
      notices.push({ id: "conversation-error", message: props.error, onDismiss: props.onDismissError });
    }
    return notices;
  }, [
    dismissKnowledgeError,
    foreignConversationActive,
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
        spaces={props.spaces ?? []}
        spaceLoadState={props.spaceLoadState}
        activeSpaceId={activeSpaceId}
        onNavigate={navigate}
        onOpenSpace={props.onOpenSpace}
        onActiveSpaceChange={(id) => setActiveSpace(id)}
        onCreateSpace={props.onCreateSpace}
        onRenameSpace={props.spaceActions?.rename === undefined
          ? undefined
          : (spaceId, title) => props.spaceActions?.rename?.({ kind: "space", id: spaceId }, title)}
        onDeleteSpace={props.spaceActions?.deleteSpace}
        onOpenSettings={props.onOpenSettings ? () => props.onOpenSettings?.() : () => undefined}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          view={view}
          onNavigate={navigate}
          onSearch={() => navigate("search")}
          sidebarCollapsed={props.sidebarCollapsed}
          onToggleSidebar={props.onToggleSidebar}
          surfaceTitle={surfaceTitle}
          conversationState={layoutMode === "reading" ? conversationState : undefined}
          onResumeConversation={() => {
            navigationIntentRef.current += 1;
            revealConversation();
          }}
          explorerCollapsed={layout.explorerCollapsed}
          onToggleExplorer={view === "space" || view === "brain" ? layout.toggleExplorer : undefined}
          onBrainRoot={() => selectKnowledge(null)}
        />

        <main
          aria-label={viewLabel(view)}
          className="ui-workbench-main flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <WorkbenchPanes
            mode={layoutMode}
            onActivePaneChange={layout.setActivePane}
            onContentResize={layout.onContentResize}
            reading={<PreviewLayoutContext.Provider value={{
              splitEnabled: layout.splitEnabled,
              canSplit: !layout.compact,
              onToggleSplit: toggleCollaboration,
            }}><WorkbenchViewTransition view={view}>
            {showLoadingFallback ? <WorkbenchBootstrapLoading /> : (
              <SurfaceErrorBoundary resetKey={view} label="这个视图暂时无法打开">
                  <WorkbenchViewRenderer
                    view={view}
                    spaces={props.spaces ?? []}
                    conversations={props.conversations}
                    spaceActions={props.spaceActions}
                    onOpenSpaceItem={props.onOpenSpaceItem}
                    onOpenConversation={openConversationInSurface}
                    explorerCollapsed={layout.explorerCollapsed}
                    onActivateReading={activateReading}
                    onOpenPreview={openReadingPreview}
                    homeInput={homeInput}
                    homeFocusRequest={homeFocusRequest}
                    homeOwnerSelection={homeOwnerSelection}
                    onHomeOwnerChange={setHomeOwner}
                    brainSelectedId={brainSelectedId}
                    spaceTargetId={spaceTargetId}
                    activeSpaceId={activeSpaceId}
                    onBrainSelect={selectKnowledge}
                    navigate={navigate}
                    onOpenInSpace={(spaceId, id) => {
                      // Navigation clears stale targets; apply the explicit
                      // search target after entering the Space surface so it
                      // remains available to SpacePage for this transition.
                      navigate("space");
                      setActiveSpace(spaceId);
                      setSpaceTarget(id);
                      openReadingPreview();
                    }}
                    onOpenSettings={props.onOpenSettings}
                  />
              </SurfaceErrorBoundary>
            )}
          </WorkbenchViewTransition></PreviewLayoutContext.Provider>}
            conversation={<WorkbenchConversationPane
              conversation={visibleConversation}
              conversations={conversationItems}
              scope={conversationScope}
              visible={layoutMode !== "reading"}
              pendingIds={props.pendingConversationIds ?? EMPTY_ID_SET}
              onOpen={openConversationInSurface}
              onRename={props.onRenameConversation}
              onTogglePinned={props.onToggleConversationPinned}
              onDelete={props.onDeleteConversation}
              newConversationDisabled={props.inputProps.busy || props.inputProps.running === true || conversationScope === null}
              onNewConversation={newConversation}
              onClose={layout.splitEnabled ? () => changeLayout("reading") : undefined}
              onEnterFocus={() => setConversationMode("focus")}
            >
              {conversationSurface}
            </WorkbenchConversationPane>}
          />
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
    run: conversation === undefined ? undefined : props.currentRun.run,
    workView: conversation === undefined ? undefined : props.currentRun.workView,
    transcriptNodes: conversation === undefined ? [] : props.currentRun.transcriptNodes,
    detail: conversation === undefined ? undefined : props.currentRun.detail,
    live: conversation === undefined ? undefined : props.currentRun.live,
    error: conversation === undefined ? undefined : props.error,
    pendingConfirmation: conversation === undefined ? undefined : props.pendingConfirmation,
  });
}

function isKnowledgeView(view: WorkbenchView): boolean {
  return view === "space" || view === "brain" || view === "search";
}

function requiresImmediateConversationView(props: Pick<PersonalWorkbenchProps, "currentRun" | "pendingConfirmation">): boolean {
  return props.pendingConfirmation !== undefined
    || props.currentRun.run?.status === "running";
}
