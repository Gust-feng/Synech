import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Pencil } from "lucide-react";
import type { ConversationTurn } from "@ui/contracts/conversation";
import { RichText } from "@ui/components/rich-text";
import { CopyActionButton } from "@ui/components/copy-action-button";
import { MessageEditor } from "./MessageEditor";

export function ConversationUserMessage(props: {
  readonly turn: ConversationTurn;
  readonly onEdit?: (content: string) => Promise<boolean>;
  readonly onSelectBranch?: (runId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.turn.content);
  const [saving, setSaving] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const versions = props.turn.branchVersions;
  const attachments = props.turn.attachments?.filter((item) => item.attachmentId.trim().length > 0) ?? [];
  const cancel = () => { setEditing(false); requestAnimationFrame(() => editButton.current?.focus()); };
  const save = async () => {
    if (saving || draft.trim().length === 0 || props.onEdit === undefined) return;
    setSaving(true);
    try { if (await props.onEdit(draft)) setEditing(false); }
    finally { setSaving(false); }
  };

  return (
    <div className="ui-conversation-turn ui-conversation-turn--user" data-editing={editing}>
      <div className="ui-user-message">
        {attachments.length > 0 && <div className="ui-message-attachments">
          {attachments.map((attachment) => <span className="ui-message-attachment" key={attachment.attachmentId} title={attachment.title}>
            <FileText size={13} aria-hidden="true" /><span>{attachment.title}</span>
          </span>)}
        </div>}
        {editing ? <MessageEditor value={draft} onChange={setDraft} onCancel={cancel} onSubmit={() => void save()} submitting={saving} ariaLabel="编辑历史消息" />
          : props.turn.content.trim().length > 0 && <div className="ui-user-message__body user-message-content"><RichText text={props.turn.content} /></div>}
        {!editing && <div className="ui-message-actions ui-message-actions--user">
          {versions !== undefined && <div className="ui-message-versions" role="group" aria-label="消息版本">
            <button type="button" className="ui-message-action" title="上一版本" aria-label="上一版本"
              disabled={props.onSelectBranch === undefined || versions.selectedIndex <= 0}
              onClick={() => void props.onSelectBranch?.(versions.runIds[versions.selectedIndex - 1]!)}><ChevronLeft size={14} aria-hidden="true" /></button>
            <span aria-live="polite">{versions.selectedIndex + 1}<span className="ui-message-versions__separator">/</span>{versions.runIds.length}</span>
            <button type="button" className="ui-message-action" title="下一版本" aria-label="下一版本"
              disabled={props.onSelectBranch === undefined || versions.selectedIndex >= versions.runIds.length - 1}
              onClick={() => void props.onSelectBranch?.(versions.runIds[versions.selectedIndex + 1]!)}><ChevronRight size={14} aria-hidden="true" /></button>
          </div>}
          <div className="ui-message-actions__tools">
            <CopyActionButton value={props.turn.content} label="复制消息" className="ui-message-action" />
            {props.onEdit !== undefined && <button ref={editButton} type="button" className="ui-message-action" title="编辑消息" aria-label="编辑消息"
              onClick={() => { setDraft(props.turn.content); setEditing(true); }}><Pencil size={14} aria-hidden="true" /></button>}
          </div>
        </div>}
      </div>
    </div>
  );
}
