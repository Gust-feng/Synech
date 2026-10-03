import { z } from "zod";
import type { MemoryEntryMutation, MemoryEntryRevisionView, MemoryTopic } from "../entry-contracts.js";
import type { MaintenanceEvidenceItem } from "./maintenance-prompt.js";
import { MAINTENANCE_MAX_NEW_TOPICS, MAINTENANCE_MAX_TOPIC_ALIASES, MAINTENANCE_MAX_ENTRY_MUTATIONS, MAINTENANCE_MAX_READ_REQUESTS_PER_ROUND, MAINTENANCE_MEMORY_MAX_TOKENS, MAINTENANCE_OUTPUT_RESERVE_TOKENS, MAINTENANCE_SUMMARY_MAX_TOKENS } from "../policy/maintenance-limits.js";

const ids = z.array(z.string().min(1));
const mutationSchema = z.object({
  operation: z.enum(["create", "revise"]), entryId: z.string().min(1), expectedRevisionId: z.string().min(1).nullable(),
  kind: z.enum(["initial", "supplement", "change", "correction", "withdrawal"]), markdown: z.string(),
  applicability: z.string().nullable(), occurredAt: z.string().nullable(), reportedAt: z.string().min(1),
  reason: z.object({ text: z.string().min(1), sourceIds: ids.min(1) }).strict().nullable(),
  topicIds: ids.max(4), related: z.array(z.object({ entryId: z.string().min(1), sourceIds: ids.min(1) }).strict()).max(3),
  sourceIds: ids.min(1), retractsRevisionIds: ids,
}).strict();
export const maintenanceReadRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("search_entries"), query: z.string().min(1).max(512), topicId: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal("read_entry"), entryId: z.string().min(1), revisionId: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal("read_evidence"), sourceId: z.string().min(1) }).strict(),
]);
export const maintenanceOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("needs_read"), requests: z.array(maintenanceReadRequestSchema).min(1).max(MAINTENANCE_MAX_READ_REQUESTS_PER_ROUND) }).strict(),
  z.object({ status: z.literal("ready"), conversationSummary: z.object({ markdown: z.string().min(1), sourceRefs: ids.min(1) }).strict(),
    mutations: z.array(mutationSchema).max(MAINTENANCE_MAX_ENTRY_MUTATIONS),
    topics: z.array(z.object({ topicId: z.string().min(1), name: z.string().trim().min(1).max(128),
      aliases: z.array(z.string().trim().min(1).max(128)).max(MAINTENANCE_MAX_TOPIC_ALIASES) }).strict()).max(MAINTENANCE_MAX_NEW_TOPICS),
    overview: z.object({ markdown: z.string(), entryIds: ids }).strict().nullable(),
  }).strict(),
]);
export type MaintenanceModelOutput = Extract<z.infer<typeof maintenanceOutputSchema>, { status: "ready" }>;
export type ValidatedMaintenanceOutput = { readonly summaryMarkdown: string; readonly mutations: readonly MemoryEntryMutation[];
  readonly topics: MaintenanceModelOutput["topics"]; readonly overview: MaintenanceModelOutput["overview"] };
const SENSITIVE_CONTENT_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b|(?:api[_-]?key|access[_-]?token|secret|password|bearer)\s*[:=]\s*\S+/giu;
export function redactSensitiveContent(text: string): string { return text.replace(SENSITIVE_CONTENT_PATTERN, "[redacted]"); }
function containsSensitiveContent(text: string): boolean { SENSITIVE_CONTENT_PATTERN.lastIndex = 0; return SENSITIVE_CONTENT_PATTERN.test(text); }
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim(); const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  try { return JSON.parse(fenced?.[1] ?? trimmed); } catch { return undefined; }
}
export function validateMaintenanceOutput(input: {
  readonly output: MaintenanceModelOutput;
  readonly allowedSummaryRefs: readonly string[];
  readonly allowedSourceIds: readonly string[];
  readonly newEvidence: readonly MaintenanceEvidenceItem[];
  readonly entries: readonly MemoryEntryRevisionView[];
  readonly availableNewEntryIds: readonly string[];
  readonly existingTopics: readonly MemoryTopic[];
  readonly availableNewTopicIds: readonly string[];
  readonly countTokens: (text: string) => number;
}): { readonly ok: true; readonly value: ValidatedMaintenanceOutput } | { readonly ok: false; readonly reason: string } {
  const fail = (reason: string) => ({ ok: false, reason } as const);
  const out = input.output;
  if (!out.conversationSummary.markdown.trim()) return fail("summary_empty");
  if (input.countTokens(out.conversationSummary.markdown) > MAINTENANCE_SUMMARY_MAX_TOKENS) return fail("summary_over_budget");
  if (!out.conversationSummary.sourceRefs.every((id) => input.allowedSummaryRefs.includes(id))) return fail("summary_source_ref_invalid");
  if (containsSensitiveContent(JSON.stringify(out))) return fail("sensitive_content_rejected");
  if (input.countTokens(JSON.stringify(out)) > MAINTENANCE_OUTPUT_RESERVE_TOKENS) return fail("output_over_budget");
  const allSources = new Set(input.allowedSourceIds);
  const topicIds = new Set(input.existingTopics.map((topic) => topic.topicId));
  const normalizeTopic = (name: string) => name.normalize("NFKC").trim().toLocaleLowerCase();
  const topicNames = new Set(input.existingTopics.flatMap((topic) => [topic.name, ...topic.aliases]).map(normalizeTopic));
  for (const topic of out.topics) {
    if (!input.availableNewTopicIds.includes(topic.topicId) || topicIds.has(topic.topicId)) return fail("topic_identity_invalid");
    const labels = [topic.name, ...topic.aliases].map(normalizeTopic);
    if (new Set(labels).size !== labels.length || labels.some((label) => topicNames.has(label))) return fail("topic_reuse_required");
    const using = out.mutations.filter((mutation) => mutation.topicIds.includes(topic.topicId));
    if (!using.length) return fail("topic_unused");
    const supportingText = input.newEvidence.filter((evidence) => using.some((mutation) => mutation.sourceIds.includes(evidence.sourceId)))
      .map((evidence) => normalizeTopic(evidence.text)).join("\n");
    if (!labels.every((label) => supportingText.includes(label))) return fail("topic_evidence_required");
    topicIds.add(topic.topicId);
    for (const label of labels) topicNames.add(label);
  }
  const changed = new Set<string>();
  for (const m of out.mutations) {
    if (changed.has(m.entryId)) return fail("duplicate_entry_mutation"); changed.add(m.entryId);
    const old = input.entries.find((v) => v.entry.entryId === m.entryId && v.revision.revisionId === m.expectedRevisionId);
    if (m.operation === "create") {
      if (m.kind !== "initial" || m.expectedRevisionId !== null || !input.availableNewEntryIds.includes(m.entryId)) return fail("invalid_initial");
    } else if (!old || old.entry.headRevisionId !== m.expectedRevisionId || m.kind === "initial") return fail("entry_head_invalid");
    const retracting = m.kind === "correction" || m.kind === "withdrawal";
    if (retracting !== (m.retractsRevisionIds.length > 0)) return fail("retraction_kind_invalid");
    if (!m.retractsRevisionIds.every((id) => input.entries.some((v) => v.entry.entryId === m.entryId && v.revision.revisionId === id))) return fail("retraction_entry_invalid");
    if (m.kind === "withdrawal" ? m.markdown !== "" : !m.markdown.trim()) return fail("entry_body_invalid");
    if (!m.sourceIds.every((id) => allSources.has(id))) return fail("entry_source_invalid");
    const newSupport = input.newEvidence.filter((e) => m.sourceIds.includes(e.sourceId));
    if (newSupport.length === 0 || !newSupport.some((e) => e.reportedAt === m.reportedAt)) return fail("new_evidence_required");
    if (old && (m.kind === "supplement" || m.kind === "change") && !old.revision.sourceIds.every((id) => m.sourceIds.includes(id))) return fail("prior_provenance_required");
    if (m.reason && !m.reason.sourceIds.every((id) => m.sourceIds.includes(id))) return fail("reason_source_invalid");
    if (new Set(m.topicIds).size !== m.topicIds.length || !m.topicIds.every((id) => topicIds.has(id))) return fail("topic_invalid");
    if (!m.related.every((r) => r.entryId !== m.entryId && input.entries.some((v) => v.entry.entryId === r.entryId) && r.sourceIds.every((id) => m.sourceIds.includes(id)))) return fail("related_invalid");
  }
  if (input.countTokens(JSON.stringify(out.mutations)) > MAINTENANCE_MEMORY_MAX_TOKENS) return fail("entries_over_budget");
  if (out.mutations.length > 0 && out.overview === null) return fail("overview_required");
  if (out.overview) {
    const withdrawn = new Set(out.mutations.filter((m) => m.kind === "withdrawal").map((m) => m.entryId));
    if (new Set(out.overview.entryIds).size !== out.overview.entryIds.length || !out.overview.entryIds.every((id) => !withdrawn.has(id) && (changed.has(id) || input.entries.some((v) => v.entry.entryId === id && v.role === "current" && v.revision.revisionId === v.entry.headRevisionId)))) return fail("overview_dependency_invalid");
    if (out.overview.markdown.trim() && out.overview.entryIds.length === 0) return fail("overview_unsubstantiated");
    if (!out.mutations.every((m) => m.kind === "withdrawal" || out.overview!.entryIds.includes(m.entryId))) return fail("overview_mutation_missing");
    if (input.countTokens(out.overview.markdown) > MAINTENANCE_MEMORY_MAX_TOKENS) return fail("overview_over_budget");
  }
  return { ok: true, value: { summaryMarkdown: out.conversationSummary.markdown, mutations: out.mutations as MemoryEntryMutation[], topics: out.topics, overview: out.overview } };
}
