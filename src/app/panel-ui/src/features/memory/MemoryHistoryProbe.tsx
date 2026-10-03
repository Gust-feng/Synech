import { useEffect, useRef, useState } from "react";
import { searchMemoryDiagnostics, type HistorySearchResult } from "@panel-api/memory-admin";
import type { MemorySettingsOwner } from "./MemorySettingsPanel";

const COVERAGE_LABEL = { available: "可用", partial: "部分覆盖", disabled: "已关闭", unavailable: "不可用" };

export function MemoryHistoryProbe(props: {
  readonly owner: MemorySettingsOwner;
  readonly conversationId?: string;
  readonly onOpenConversation?: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"all" | "summary" | "transcript">("all");
  const [result, setResult] = useState<HistorySearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => { request.current?.abort(); setResult(null); setError(null); setBusy(false); setElapsed(null);
    return () => request.current?.abort(); }, [props.owner.kind, props.owner.id, props.conversationId]);

  async function search() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(null); setResult(null);
    const started = performance.now();
    try {
      const value = await searchMemoryDiagnostics({ owner: props.owner, conversationId: props.conversationId,
        query: query.trim(), source }, controller.signal);
      if (!controller.signal.aborted) { setResult(value); setElapsed(Math.round(performance.now() - started)); }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "搜索失败");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <section className="memory-debug-section">
    <h4>历史搜索试验</h4>
    <p className="memory-hint">使用与模型工具相同的检索入口，查看命中内容和覆盖范围。不会调用模型或写入记忆。</p>
    <form className="memory-debug-search" onSubmit={event => { event.preventDefault(); void search(); }}>
      <input aria-label="历史搜索词" placeholder="输入名称、决定或讨论过的关键词" maxLength={2048}
        value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label="历史搜索来源" value={source} onChange={event => setSource(event.target.value as typeof source)}>
        <option value="all">摘要与原文</option><option value="summary">会话摘要</option><option value="transcript">对话原文</option>
      </select>
      <button type="submit" disabled={busy || !query.trim()}>{busy ? "搜索中…" : "测试搜索"}</button>
    </form>
    {error && <p className="memory-error" role="alert">{error}</p>}
    {result && <>
      <p className="memory-debug-meta">{result.items.length} 个片段 · {elapsed} ms · 摘要：{COVERAGE_LABEL[result.coverage.summary]} · 原文：{COVERAGE_LABEL[result.coverage.transcript]}</p>
      {result.items.length === 0 && <p className="memory-hint">{result.coverage.summary === "disabled" && result.coverage.transcript === "disabled" ? "记忆查询已关闭；这不表示没有已保存内容。" : result.outcome === "degraded" ? "部分来源不可用，当前没有可返回的命中。" : "当前可检索范围内没有命中，可更换关键词或来源。"}</p>}
      <ol className="memory-debug-results">
        {result.items.map((item, index) => <li key={`${item.sourceRef}-${index}`}>
          <div className="memory-debug-row-title"><span>{item.type === "conversation_summary" ? "模型生成摘要" : "原始对话片段"}{item.truncated ? " · 节选" : ""}</span>
            {props.onOpenConversation && <button type="button" onClick={() => props.onOpenConversation?.(item.conversationId)}>打开会话</button>}</div>
          <pre>{item.text}</pre>
          <details><summary>来源标识</summary><code>{item.sourceRef}</code></details>
        </li>)}
      </ol>
    </>}
  </section>;
}