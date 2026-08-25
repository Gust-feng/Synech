import type { ChatInputProps } from "../../../../contracts/composer";
import type { Conversation, ConversationSummary } from "../../../../contracts/conversation";
import type { CurrentRunProjection } from "../../../../features/conversations/run/projection";
import type { PersonalSpaceActions, PersonalSpaceProjection } from "../../../space";
import type { WorkspaceProjectionState } from "../../../../features/spaces/workspace-state";
import { BrainPage } from "./BrainPage";
import { HomePage } from "./HomePage";
import { MemoryPage } from "./MemoryPage";
import { SearchPage } from "./SearchPage";
import { SpacePage } from "./SpacePage";
import { ConversationSurface } from "./ConversationSurface";
import type { ConversationSurfaceProjection, LiveConversationState } from "./conversation-surface-state";
import type {
  ConversationOwnerSelection,
  ConversationSurfaceRequest,
  WorkbenchView,
} from "../../../../workbench/navigation-state";

type ConversationMode = "normal" | "focus";

export type WorkbenchViewRendererProps = {
  readonly view: WorkbenchView;
  readonly spaces: readonly PersonalSpaceProjection[];
  readonly conversations: readonly ConversationSummary[];
  readonly spaceActions?: PersonalSpaceActions;
  readonly onOpenSpaceItem?: (spaceId: string, itemId: string) => void | Promise<void>;
  readonly onOpenConversation: (conversationId: string) => boolean | Promise<boolean>;
  readonly onRenameConversation: (conversationId: string, title: string) => void | Promise<void>;
  readonly onToggleConversationPinned: (conversationId: string, pinned: boolean) => void | Promise<void>;
  readonly onDeleteConversation: (conversationId: string) => void | Promise<void>;
  readonly activeConversation?: Conversation;
  readonly conversationProjection: ConversationSurfaceProjection;
  readonly conversationState: LiveConversationState;
  readonly currentRun: CurrentRunProjection;
  readonly showModelUsage: boolean;
  readonly developerModeEnabled: boolean;
  readonly confirmationBusy: boolean;
  readonly onDecision: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
  readonly homeInput: ChatInputProps;
  readonly homeFocusRequest: number;
  readonly workspaceProjection: WorkspaceProjectionState;
  readonly homeOwnerSelection: ConversationOwnerSelection | null;
  readonly onHomeOwnerChange: (owner: ConversationOwnerSelection | null) => void;
  readonly conversationInput: ChatInputProps;
  readonly brainSelectedId: string | null;
  readonly spaceTargetId: string | null;
  readonly activeSpaceId: string | null;
  readonly onActiveSpaceChange: (spaceId: string | null) => void;
  readonly conversationMode: ConversationMode;
  readonly conversationSurfaceRequest: ConversationSurfaceRequest | null;
  readonly onBrainSelect: (id: string | null) => void;
  readonly navigate: (view: WorkbenchView) => void;
  readonly onEnterFocus: () => void;
  readonly onExitFocus: () => void;
  readonly onOpenConversationInSurface: (conversationId: string) => boolean | Promise<boolean>;
  readonly onOpenInSpace: (spaceId: string, id: string) => void;
};

export function WorkbenchViewRenderer(input: WorkbenchViewRendererProps): React.ReactElement | null {
  if (input.view === "home") {
    return <HomePage
      spaces={input.spaces}
      workspaces={input.workspaceProjection.workspaces}
      ownerSelection={input.homeOwnerSelection}
      onOwnerChange={input.onHomeOwnerChange}
      input={input.homeInput}
      focusRequest={input.homeFocusRequest}
    />;
  }
  if (input.view === "space") {
    const activeSpace = input.spaces.find((space) => space.spaceId === input.activeSpaceId);
    return <SpacePage
      onNavigate={input.navigate}
      targetId={input.spaceTargetId}
      space={activeSpace}
      actions={input.spaceActions}
      onOpenItem={input.onOpenSpaceItem}
      onOpenConversation={input.onOpenConversation}
      activeConversationId={input.activeConversation?.conversationId}
      activeConversationOwner={input.activeConversation?.owner}
      activeConversationTitle={input.activeConversation?.title}
      conversationSurfaceRequest={input.conversationSurfaceRequest}
      conversationContent={
        <ConversationSurface
          conversation={input.activeConversation}
          projection={input.conversationProjection}
          state={input.conversationState}
          input={input.conversationInput}
          currentRun={input.currentRun}
          showModelUsage={input.showModelUsage}
          developerModeEnabled={input.developerModeEnabled}
          confirmationBusy={input.confirmationBusy}
          onDecision={input.onDecision}
          focus={input.conversationMode === "focus"}
          onExitFocus={input.onExitFocus}
        />
      }
      onEnterFocus={input.conversationMode === "normal" ? input.onEnterFocus : undefined}
      onRenameConversation={input.onRenameConversation}
      onToggleConversationPinned={input.onToggleConversationPinned}
      onDeleteConversation={input.onDeleteConversation}
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
      onOpenConversation={input.onOpenConversationInSurface}
      spaces={input.spaces}
      conversations={input.conversations}
    />;
  }
  return null;
}