import type { AgentSessionCheckpointKind, AgentSessionCheckpointRef } from "../../../app/model-runtime/agent-session.js";
import type { AgentSessionHandle } from "../pi-agent/runtime-environment.js";
import { transcriptEntryRef } from "../agent-transcript.js";
import type { TranscriptEntryRef } from "../agent-transcript.js";

/** Adapter-only bridge from observed Pi positions to durable product checkpoints. */
export type AgentSessionCheckpointPort = {
  record(
    kind: AgentSessionCheckpointKind,
    providerEntryId: string,
  ): Promise<AgentSessionCheckpointRef>;
};

/** Minimal writer capability needed to mint checkpoints on its mutation line. */
export type AgentSessionCheckpointLease = {
  readonly session: AgentSessionHandle;
  recordCheckpoint(
    kind: AgentSessionCheckpointKind,
    entryRef: TranscriptEntryRef,
  ): Promise<AgentSessionCheckpointRef>;
};

/** Keeps provider identity construction and mapping out of application composition. */
export function createAgentSessionCheckpointPort(
  lease: AgentSessionCheckpointLease,
): AgentSessionCheckpointPort {
  const sessionId = lease.session.metadata.id;
  return {
    record: (kind, providerEntryId) =>
      lease.recordCheckpoint(kind, transcriptEntryRef(sessionId, providerEntryId)),
  };
}
