import { Maximize2, PanelRightClose } from "lucide-react";
import type { ReactNode } from "react";
import { ConversationPicker, type ConversationPickerProps } from "./ConversationPicker";

export function WorkbenchConversationPane(props: ConversationPickerProps & {
  readonly newConversationDisabled: boolean;
  readonly onNewConversation: () => void;
  readonly children: ReactNode;
  readonly onClose?: () => void;
  readonly onEnterFocus: () => void;
}) {
  return (
    <section className="ui-workbench-conversation" aria-label="协作">
      <header className="ui-workbench-conversation-header">
        <div className="ui-workbench-conversation-heading">
          <ConversationPicker {...props} />
        </div>
        <div className="ui-workbench-conversation-actions">
          {props.conversation?.owner !== undefined && <button type="button" className="ui-workbench-text-button" disabled={props.newConversationDisabled} onClick={props.onNewConversation}>新对话</button>}
          {props.conversation?.owner !== undefined && <button type="button" className="ui-workbench-pane-button" onClick={props.onEnterFocus} title="专注对话" aria-label="专注对话">
            <Maximize2 size={14} aria-hidden="true" />
          </button>}
          {props.onClose !== undefined && <button type="button" className="ui-workbench-pane-button" onClick={props.onClose} title="结束协作，继续阅读" aria-label="结束协作">
            <PanelRightClose size={15} aria-hidden="true" />
          </button>}
        </div>
      </header>
      {props.children}
    </section>
  );
}
