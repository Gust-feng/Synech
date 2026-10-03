import { ArrowUpRight, PencilLine, X } from "lucide-react";
import { useState } from "react";
import { MessageEditor } from "./MessageEditor";
import type { QueuedChatMessage } from "@ui/contracts/composer";

export type QueuedMessageListProps = {
  readonly messages: readonly QueuedChatMessage[];
  readonly onRemove: (id: string) => void;
  readonly onUpdate: (id: string, content: string) => void;
  readonly onGuide: (id: string) => Promise<boolean> | void;
};

/** Shows messages waiting behind the current run without changing composer flow. */
export function QueuedMessageList({ messages, onRemove, onUpdate, onGuide }: QueuedMessageListProps) {
  const [editingId, setEditingId] = useState<string | undefined>();
  const [editingContent, setEditingContent] = useState("");

  if (messages.length === 0) return null;

  const beginEditing = (message: QueuedChatMessage): void => {
    setEditingId(message.id);
    setEditingContent(message.content);
  };

  const cancelEditing = (): void => {
    setEditingId(undefined);
    setEditingContent("");
  };

  const commitEditing = (messageId: string): void => {
    const content = editingContent.trim();
    if (content.length === 0) {
      onRemove(messageId);
    } else {
      onUpdate(messageId, content);
    }
    cancelEditing();
  };

  return (
    <div
      className="border-b px-3 pb-2.5 pt-3"
      style={{ borderColor: "var(--ui-border)" }}
      role="list"
      aria-label="待发送消息队列"
    >
      <div className="mb-1.5 flex items-center justify-between px-0.5 text-[11px]" style={{ color: "var(--ui-text-3)" }}>
        <span>待发送</span>
        <span aria-label={`${messages.length} 条待发送消息`}>{messages.length}</span>
      </div>
      <div className="ui-queued-messages">
        {messages.map((message) => {
          const editing = editingId === message.id;
          return (
            <div
              key={message.id}
              role="listitem"
              className="ui-queued-message"
              data-editing={editing}
            >
              {editing ? (
                <MessageEditor compact allowEmpty value={editingContent} onChange={setEditingContent} onCancel={cancelEditing}
                  onSubmit={() => commitEditing(message.id)} submitLabel="保存" ariaLabel="编辑待发送消息" />
              ) : (
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-5">{message.content}</span>
              )}
              {!editing && <div className="ui-queued-message__actions">
                    <button
                      type="button"
                      onClick={() => void onGuide(message.id)}
                      className="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-medium transition-colors hover:bg-[var(--ui-hover-tint)]"
                      style={{ color: "var(--ui-accent)" }}
                      aria-label={`引导待发送消息：${message.content}`}
                    >
                      <ArrowUpRight size={11} />
                      引导
                    </button>
                    <button
                      type="button"
                      onClick={() => beginEditing(message)}
                      className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--ui-hover-tint)]"
                      style={{ color: "var(--ui-text-3)" }}
                      aria-label="编辑待发送消息"
                    >
                      <PencilLine size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(message.id)}
                      className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--ui-hover-tint)]"
                      style={{ color: "var(--ui-text-3)" }}
                      aria-label="撤回待发送消息"
                    >
                      <X size={12} />
                    </button>
              </div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
