import { createHash, createHmac, randomBytes } from "node:crypto";
import { memoryOwnerKey } from "../../../domain/memory/index.js";
import type { ConversationOwner } from "../../../domain/execution-scope/contracts.js";
import { MemoryError, type EffectiveMemoryAdmission } from "../contracts.js";
import type {
  MemoryEntryQueryPort, MemoryEntryReadResult, MemoryEntryRevisionRef,
  MemoryEntryRevisionView, MemoryEntryQueryView, MemoryEntrySearchResult,
} from "../entry-contracts.js";
import type { MemoryDocumentRepository } from "../store/content-repository.js";

type Pending = MemoryEntryRevisionRef & { lane: "item" | "history" | "related"; offset: number; sourceOffset?: number };
type Cursor = {
  scope: string; pending: Pending[]; repositoryCursor: string | null;
  root?: MemoryEntryRevisionRef; historyNext?: string | null;
};
type AdmissionSnapshot = { admission: EffectiveMemoryAdmission; policyRevision: string };

/** Same history facade, published entry reads only; candidate refs never grant permission. */
export function createMemoryEntryQueries(
  repository: MemoryDocumentRepository,
  readAdmission: (owner: ConversationOwner) => Promise<AdmissionSnapshot>,
  countTokens: (text: string) => number,
): MemoryEntryQueryPort {
  // Stateless authenticated continuation: no unbounded map, and callers cannot forge related/history refs.
  const secret = randomBytes(32);
  const signature = (body: string) => createHmac("sha256", secret).update(body).digest("base64url");
  const encode = (cursor: Cursor) => {
    const body = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    return `${body}.${signature(body)}`;
  };
  const decode = (token: string | undefined, scope: string): Cursor | undefined => {
    if (token === undefined) return undefined;
    if (token.length > 65_536) throw new Error("memory_query_cursor_invalid");
    const [body, mac, extra] = token.split(".");
    if (!body || mac !== signature(body) || extra !== undefined) throw new Error("memory_query_cursor_invalid");
    const value: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || !("scope" in value) || value.scope !== scope ||
        !("pending" in value) || !Array.isArray(value.pending)) throw new Error("memory_query_cursor_stale");
    return value as Cursor; // Contents were issued and authenticated by this instance.
  };
  const scopeOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const resolve = (ownerKey: string, snapshot: AdmissionSnapshot, refs: readonly MemoryEntryRevisionRef[]) =>
    repository.resolveEntries({ ownerKey, expectedPolicyRevision: snapshot.policyRevision,
      expectedGeneration: snapshot.admission.generation, entries: refs });
  const cost = (value: unknown) => countTokens(JSON.stringify({ status: "ok", ...(value as object) }));
  const prefix = (text: string, fits: (text: string) => boolean): string => {
    let low = 0, high = text.length, best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (fits(text.slice(0, mid))) { best = mid; low = mid + 1; } else high = mid - 1;
    }
    // Never split a surrogate pair: cursor offsets and reassembled unicode remain exact.
    if (best > 0 && best < text.length && /[\uD800-\uDBFF]/u.test(text[best - 1]!)) best -= 1;
    return text.slice(0, best);
  };
  const contentOf = (view: MemoryEntryRevisionView) => view.revision.markdown + (view.revision.applicability ?? "") + (view.revision.reason?.text ?? "");
  const pageView = (view: MemoryEntryRevisionView, text: string, sourceOffset = 0, sourceLimit = 8, contentOffset = 0): MemoryEntryQueryView => {
    const lengths = [view.revision.markdown.length, view.revision.applicability?.length ?? 0, view.revision.reason?.text.length ?? 0];
    const total = lengths.reduce((sum, length) => sum + length, 0);
    const fieldSlice = (start: number, length: number) => text.slice(Math.max(0, start - contentOffset), Math.max(0, Math.min(text.length, start + length - contentOffset)));
    const sources = view.sources.slice(sourceOffset, sourceOffset + sourceLimit);
    const ids = new Set(sources.map(source => source.sourceId));
    const nextOffset = sourceOffset + sources.length < view.sources.length ? sourceOffset + sources.length : null;
    return { ...view, sources, revision: { ...view.revision, markdown: fieldSlice(0, lengths[0]!),
      applicability: view.revision.applicability === null ? null : fieldSlice(lengths[0]!, lengths[1]!),
      sourceIds: view.revision.sourceIds.filter(id => ids.has(id)),
      reason: view.revision.reason === null ? null : { text: fieldSlice(lengths[0]! + lengths[1]!, lengths[2]!), sourceIds: view.revision.reason.sourceIds.filter(id => ids.has(id)) },
      related: view.revision.related.map(relation => ({ ...relation, sourceIds: relation.sourceIds.filter(id => ids.has(id)) })),
    }, contentPage: { offset: contentOffset, total, nextOffset: contentOffset + text.length < total ? contentOffset + text.length : null,
      markdownChars: lengths[0]!, applicabilityChars: lengths[1]!, reasonChars: lengths[2]! },
      sourcePage: { offset: sourceOffset, total: view.sources.length, nextOffset },
      sourceSummary: { total: view.sources.length, deleted: view.sources.filter(source => source.lifecycle === "deleted").length,
        superseded: view.sources.filter(source => source.branch === "superseded").length } };
  };
  const advance = (ref: Pending, view: MemoryEntryRevisionView, consumed: number): Pending | undefined => {
    const offset = ref.offset + consumed;
    if (offset < contentOf(view).length) return { ...ref, offset };
    const sourceOffset = (ref.sourceOffset ?? 0) + Math.min(8, Math.max(0, view.sources.length - (ref.sourceOffset ?? 0)));
    return sourceOffset < view.sources.length ? { ...ref, offset, sourceOffset } : undefined;
  };

  return {
    async searchEntries(request) {
      const snapshot = await readAdmission(request.owner);
      if (snapshot.admission.effective !== "active") return { outcome: "disabled", items: [], nextCursor: null, truncated: false };
      const ownerKey = memoryOwnerKey(request.owner);
      const scope = scopeOf(["search", ownerKey, request.query, request.topicId ?? null,
        request.conversationId ?? null, request.includeHistory ?? false, snapshot.policyRevision, snapshot.admission.generation]);
      let cursor: Cursor;
      try { cursor = decode(request.cursor, scope) ?? { scope, pending: [], repositoryCursor: null }; }
      catch { return { outcome: "unavailable", items: [], nextCursor: null, truncated: false }; }
      const limit = Math.max(1, Math.min(8, Math.floor(request.limit) || 1));
      if (cursor.pending.length === 0) {
        let candidates: Awaited<ReturnType<MemoryDocumentRepository["searchEntryCandidates"]>>;
        try { candidates = await repository.searchEntryCandidates({ ownerKey,
          match: lexicalMatch(request.query), includeHistory: request.includeHistory ?? false, limit,
          ...(request.topicId === undefined ? {} : { topicId: request.topicId }),
          ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
          ...(cursor.repositoryCursor === null ? {} : { cursor: cursor.repositoryCursor }),
        }); } catch (error) {
          if (error instanceof MemoryError && error.code === "memory_revision_stale")
            return { outcome: "unavailable", items: [], nextCursor: null, truncated: false };
          throw error;
        }
        cursor = { scope, pending: candidates.candidates.map(ref => ({ ...ref, lane: "item", offset: 0 })),
          repositoryCursor: candidates.nextCursor };
      }
      const verified = await resolve(ownerKey, snapshot, cursor.pending);
      if (verified === undefined) return { outcome: "unavailable", items: [], nextCursor: null, truncated: false };
      const byRevision = new Map(verified.map(view => [view.revision.revisionId, view]));
      const pending = cursor.pending.filter(ref => {
        const view = byRevision.get(ref.revisionId);
        return view !== undefined && view.entry.entryId === ref.entryId &&
          (request.includeHistory || view.role === "current");
      });
      const items: MemoryEntryQueryView[] = [];
      const resultFor = (rest: Pending[]): MemoryEntrySearchResult => ({
        outcome: items.length ? "ok" : rest.length || cursor.repositoryCursor ? "unavailable" : "no_hit",
        items: [...items], nextCursor: rest.length || cursor.repositoryCursor ? encode({ ...cursor, pending: rest }) : null,
        truncated: rest.length > 0 || cursor.repositoryCursor !== null,
      });
      while (pending.length && items.length < limit) {
        const ref = pending[0]!;
        const view = byRevision.get(ref.revisionId)!;
        const text = contentOf(view).slice(ref.offset);
        const withText = (part: string) => {
          const next = advance(ref, view, part.length);
          const rest = next === undefined ? pending.slice(1) : [next, ...pending.slice(1)];
          items.push(pageView(view, part, ref.sourceOffset ?? 0, 8, ref.offset));
          const result = resultFor(rest);
          items.pop();
          return result;
        };
        if (cost(withText(text)) <= 4_000) {
          items.push(pageView(view, text, ref.sourceOffset ?? 0, 8, ref.offset));
          const next = advance(ref, view, text.length);
          if (next === undefined) pending.shift(); else { pending[0] = next; break; }
          continue;
        }
        if (items.length > 0) break;
        const part = prefix(text, candidate => cost(withText(candidate)) <= 4_000);
        if (part.length === 0) return { outcome: "unavailable", items: [], nextCursor: null, truncated: false };
        items.push(pageView(view, part, ref.sourceOffset ?? 0, 8, ref.offset)); pending[0] = { ...ref, offset: ref.offset + part.length }; break;
      }
      return resultFor(pending);
    },

    async readEntry(request) {
      const snapshot = await readAdmission(request.owner);
      if (snapshot.admission.effective !== "active") return { outcome: "disabled", reason: "memory_disabled" };
      const ownerKey = memoryOwnerKey(request.owner);
      const scope = scopeOf(["read", ownerKey, request.entryId, request.revisionId ?? null,
        request.includeHistory ?? false, request.includeRelated ?? false, snapshot.policyRevision, snapshot.admission.generation]);
      let cursor: Cursor | undefined;
      try { cursor = decode(request.cursor, scope); }
      catch { return { outcome: "unavailable", reason: "memory_query_cursor_stale" }; }
      if (cursor === undefined) {
        const entry = await repository.getEntry({ ownerKey, entryId: request.entryId });
        if (entry === undefined) return { outcome: "not_found", reason: "memory_entry_not_found" };
        const root = { entryId: entry.entryId, revisionId: request.revisionId ?? entry.headRevisionId };
        cursor = { scope, root, repositoryCursor: null, pending: [{ ...root, lane: "item", offset: 0 }] };
        const rootView = await repository.getEntryRevision({ ownerKey, ...root });
        if (rootView === undefined) return { outcome: "not_found", reason: "memory_entry_not_found" };
        cursor.historyNext = request.includeHistory ? rootView.revision.previousRevisionId : null;
        if (request.includeRelated) {
          for (const related of rootView.revision.related.slice(0, 8)) {
            const entry = await repository.getEntry({ ownerKey, entryId: related.entryId });
            if (entry !== undefined) cursor.pending.push({ entryId: entry.entryId, revisionId: entry.headRevisionId, lane: "related", offset: 0 });
          }
        }
      }
      const root = cursor.root!;
      // At most eight older revisions per discovery page; continuation retains the remaining chain.
      if (cursor.pending.length === 0 && cursor.historyNext) {
        for (let index = 0; index < 8 && cursor.historyNext; index += 1) {
          const view = await repository.getEntryRevision({ ownerKey, entryId: request.entryId, revisionId: cursor.historyNext });
          if (view === undefined) return { outcome: "unavailable", reason: "memory_revision_unavailable" };
          cursor.pending.push({ entryId: request.entryId, revisionId: view.revision.revisionId, lane: "history", offset: 0 });
          cursor.historyNext = view.revision.previousRevisionId;
        }
      }
      const verified = await resolve(ownerKey, snapshot, [root, ...cursor.pending]);
      if (verified === undefined) return { outcome: "unavailable", reason: "memory_admission_changed" };
      const byRevision = new Map(verified.map(view => [view.revision.revisionId, view]));
      const rootView = byRevision.get(root.revisionId);
      if (rootView === undefined || rootView.entry.entryId !== request.entryId ||
          (!request.includeHistory && rootView.role !== "current")) return { outcome: "unavailable", reason: "memory_revision_not_current" };
      const pending = cursor.pending.filter(ref => {
        const view = byRevision.get(ref.revisionId);
        return view !== undefined && view.entry.entryId === ref.entryId &&
          (ref.lane !== "related" || view.role === "current");
      });
      const budget = Math.min(6_000, Math.max(1, Math.floor(request.limitTokens) || 1));
      let item = pageView(rootView, "", 0, 0);
      const history: MemoryEntryQueryView[] = [], related: MemoryEntryQueryView[] = [];
      const resultFor = (rest: Pending[]): MemoryEntryReadResult => ({ outcome: "ok", item, history: [...history], related: [...related],
        nextCursor: rest.length || cursor!.historyNext ? encode({ ...cursor!, pending: rest }) : null,
        truncated: rest.length > 0 || !!cursor!.historyNext });
      let consumed = false;
      while (pending.length) {
        const ref = pending[0]!;
        const view = byRevision.get(ref.revisionId)!;
        const text = contentOf(view).slice(ref.offset);
        const add = (part: string) => {
          const projected = pageView(view, part, ref.sourceOffset ?? 0, 8, ref.offset);
          if (ref.lane === "item") item = projected;
          else (ref.lane === "history" ? history : related).push(projected);
        };
        const withText = (part: string) => {
          const oldItem = item;
          add(part);
          const next = advance(ref, view, part.length);
          const rest = next === undefined ? pending.slice(1) : [next, ...pending.slice(1)];
          const result = resultFor(rest);
          item = oldItem;
          if (ref.lane !== "item") (ref.lane === "history" ? history : related).pop();
          return result;
        };
        if (cost(withText(text)) <= budget) {
          add(text); consumed = true;
          const next = advance(ref, view, text.length);
          if (next === undefined) pending.shift(); else { pending[0] = next; break; }
          continue;
        }
        if (consumed) break;
        const part = prefix(text, candidate => cost(withText(candidate)) <= budget);
        if (part.length === 0) return { outcome: "unavailable", reason: "memory_response_budget_too_small" };
        add(part); pending[0] = { ...ref, offset: ref.offset + part.length }; consumed = true; break;
      }
      const result = resultFor(pending);
      return cost(result) <= budget ? result : { outcome: "unavailable", reason: "memory_response_budget_too_small" };
    },
  };
}

import { lexicalMatchExpression as lexicalMatch } from "../recall/lexical-projection.js";
