import type { ChatInputProps } from "../../../../contracts/composer";
import type { ConversationSummary } from "../../../../contracts/conversation";
import type { PersonalSpaceActions, PersonalSpaceProjection } from "../../../space";
import type { WorkspaceProjectionState } from "../../../../features/spaces/workspace-state";
import { BrainPage } from "./BrainPage";
import { HomePage } from "./HomePage";
import { SearchPage } from "./SearchPage";
import { SpacePage } from "./SpacePage";
import { WorkspacePage } from "./WorkspacePage";
import type {
  ConversationOwnerSelection,
  WorkbenchView,
} from "../../../../workbench/navigation-state";
import type { SettingsGroup } from "../../../../features/settings/components/types";

export type WorkbenchViewRendererProps = {
  readonly view: WorkbenchView;
  readonly spaces: readonly PersonalSpaceProjection[];
  readonly conversations: readonly ConversationSummary[];
  readonly spaceActions?: PersonalSpaceActions;
  readonly onOpenSpaceItem?: (spaceId: string, itemId: string) => void | Promise<void>;
  readonly onOpenConversation: (conversationId: string) => boolean | Promise<boolean>;
  readonly explorerCollapsed: boolean;
  readonly onActivateReading: () => void;
  readonly onOpenPreview: () => void;
  readonly homeInput: ChatInputProps;
  readonly homeFocusRequest: number;
  readonly workspaceProjection: WorkspaceProjectionState;
  readonly homeOwnerSelection: ConversationOwnerSelection | null;
  readonly onHomeOwnerChange: (owner: ConversationOwnerSelection | null) => void;
  readonly brainSelectedId: string | null;
  readonly spaceTargetId: string | null;
  readonly activeSpaceId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly onBrainSelect: (id: string | null) => void;
  readonly navigate: (view: WorkbenchView) => void;
  readonly onOpenInSpace: (spaceId: string, id: string) => void;
  readonly onOpenSettings?: (group?: SettingsGroup) => void;
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
      explorerCollapsed={input.explorerCollapsed}
      onActivateReading={input.onActivateReading}
      onOpenPreview={input.onOpenPreview}
    />;
  }
  if (input.view === "workspace") {
    const activeWorkspace = input.workspaceProjection.workspaces.find(
      (workspace) => workspace.workspaceId === input.activeWorkspaceId,
    );
    return <WorkspacePage
      workspace={activeWorkspace}
      explorerCollapsed={input.explorerCollapsed}
      onReconnectWorkspace={input.workspaceProjection.reconnectWorkspace}
    />;
  }
  if (input.view === "brain") {
    return <BrainPage
      selectedId={input.brainSelectedId}
      onSelect={input.onBrainSelect}
      explorerCollapsed={input.explorerCollapsed}
      onActivateReading={input.onActivateReading}
    />;
  }
  if (input.view === "search") {
    return <SearchPage
      onOpenInSpace={input.onOpenInSpace}
      onOpenInKnowledge={(id) => {
        input.onBrainSelect(id);
        input.navigate("brain");
      }}
      onOpenConversation={input.onOpenConversation}
      spaces={input.spaces}
      conversations={input.conversations}
    />;
  }
  return null;
}
