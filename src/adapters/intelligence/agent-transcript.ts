/**
 * A position on the provider transcript.
 *
 * Entry ids are provider implementation facts: they are only unique inside one
 * Session, and the provider may recast them when re-importing an old
 * transcript. They therefore stay inside the adapter as diagnostics and are
 * never persisted, compared, or interpreted by the product layer, which uses
 * `AgentSessionCheckpointRef` instead.
 */
export type TranscriptEntryRef = {
  readonly sessionId: string;
  readonly entryId: string;
};

/** Creates an adapter-owned reference to a provider transcript position. */
export function transcriptEntryRef(sessionId: string, entryId: string): TranscriptEntryRef {
  return { sessionId, entryId };
}

/** Stable key for one transcript position. */
export function transcriptEntryKey(ref: TranscriptEntryRef): string {
  return `${ref.sessionId}\u0000${ref.entryId}`;
}
