import { ArrowUpRight, Check, PencilLine, X } from "lucide-react";
import { useState } from "react";
import type { QueuedChatMessage } from "../../../../contracts/composer";

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
      style={{ borderColor: "var(--aa-border)" }}
      role="list"
      aria-label="待发送消息队列"
    >
      <div className="mb-1.5 flex items-center justify-between px-0.5 text-[11px]" style={{ color: "var(--aa-text-3)" }}>
        <span>待发送</span>
        <span aria-label={`${messages.length} 条待发送消息`}>{messages.length}</span>
      </div>
      <div className="flex max-h-32 flex-col gap-1.5 overflow-y-auto">
        {messages.map((message) => {
          const editing = editingId === message.id;
          return (
            <div
              key={message.id}
              role="listitem"
              className="flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs"
              style={{
                borderColor: "var(--aa-border)",
                background: "var(--aa-surface-hover)",
                color: "var(--aa-text-2)",
              }}
            >
              {editing ? (
                <textarea
                  value={editingContent}
                  onChange={(event) => setEditingContent(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      commitEditing(message.id);
                    }
                    if (event.key === "Escape") cancelEditing();
                  }}
                  autoFocus
                  rows={2}
                  spellCheck={false}
                  className="min-h-8 min-w-0 flex-1 resize-none bg-transparent leading-5 outline-none"
                  aria-label="编辑待发送消息"
                />
              ) : (
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-5">{message.content}</span>
              )}
              <div className="flex shrink-0 items-center gap-0.5">
                {editing ? (
                  <>
                    <button
                      type="button"
                      onClick={() => commitEditing(message.id)}
                      className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--aa-hover-tint)]"
                      style={{ color: "var(--aa-accent)" }}
                      aria-label="保存待发送消息"
                    >
                      <Check size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={cancelEditing}
                      className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--aa-hover-tint)]"
                      style={{ color: "var(--aa-text-3)" }}
                      aria-label="取消编辑待发送消息"
                    >
                      <X size={12} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void onGuide(message.id)}
                      className="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-medium transition-colors hover:bg-[var(--aa-hover-tint)]"
                      style={{ color: "var(--aa-accent)" }}
                      aria-label={`引导待发送消息：${message.content}`}
                    >
                      <ArrowUpRight size={11} />
                      引导
                    </button>
                    <button
                      type="button"
                      onClick={() => beginEditing(message)}
                      className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--aa-hover-tint)]"
                      style={{ color: "var(--aa-text-3)" }}
                      aria-label="编辑待发送消息"
                    >
                      <PencilLine size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(message.id)}
                      className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--aa-hover-tint)]"
                      style={{ color: "var(--aa-text-3)" }}
                      aria-label="撤回待发送消息"
                    >
                      <X size={12} />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
