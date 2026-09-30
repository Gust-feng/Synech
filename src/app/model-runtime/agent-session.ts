/** Stable locator for one durable agent transcript. */
export type AgentSessionRef = {
  readonly sessionId: string;
  readonly storageKey: string;
  readonly sessionCwd: string;
  readonly createdAt: string;
};

export type AgentSessionRepositoryErrorCode =
  | "agent_session_duplicate"
  | "agent_session_legacy_requires_reset"
  | "agent_session_ref_invalid"
  | "agent_session_metadata_mismatch"
  | "agent_session_attachment_mismatch"
  | "agent_session_not_found"
  | "agent_session_checkpoint_unknown"
  | "agent_session_checkpoint_conflict"
  | "agent_session_revoke_failed"
  | "agent_session_writer_active";

/** Structured failure of the agent Session repository. Codes drive program branching; never a display string. */
export class AgentSessionRepositoryError extends Error {
  readonly name = "AgentSessionRepositoryError";

  constructor(readonly code: AgentSessionRepositoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Structural reason a durable transcript checkpoint exists. Drives program
 * branching; never a display string.
 */
export type AgentSessionCheckpointKind =
  | "run_started"
  | "input_committed"
  | "assistant_tool_calls_committed"
  | "tool_results_committed"
  | "compaction_committed"
  | "assistant_response_committed";

/**
 * Product-visible identity for one durable transcript checkpoint.
 *
 * This is the identity the product owns and persists. The provider entry behind
 * it is resolved by the adapter and is deliberately not part of this shape, so
 * a provider-side change of entry ids cannot invalidate durable product state.
 */
export type AgentSessionCheckpointRef = {
  readonly sessionId: string;
  readonly checkpointId: string;
  readonly kind: AgentSessionCheckpointKind;
};

/** One product checkpoint located on the live provider transcript. */
export type AgentSessionCheckpointPosition = {
  readonly checkpoint: AgentSessionCheckpointRef;
  /** Zero-based position on the durable branch; larger means further along. */
  readonly position: number;
};

/** Checkpoints written or observed by one model-tool-model execution chain. */
export type AgentSessionExecutionRefs = {
  readonly sessionId: string;
  readonly startCheckpoint: AgentSessionCheckpointRef | null;
  /** Latest branch position whose model protocol group was durably accepted. */
  readonly safeCheckpoint: AgentSessionCheckpointRef | null;
  readonly latestCheckpoint: AgentSessionCheckpointRef | null;
  readonly compactionCheckpoints: readonly AgentSessionCheckpointRef[];
};

/** One user-visible assistant turn read from a durable Session branch. */
export type AgentSessionAssistantEntry = {
  readonly checkpoint: AgentSessionCheckpointRef;
  readonly text: string;
};

/** Awaited durable checkpoints emitted in agent Session write order. */
export type AgentSessionWriteCheckpoint = { readonly sessionId: string } & (
  | {
      readonly kind: "start_leaf_captured";
      /**
       * Null when the Session had no leaf before this run: there is then
       * nothing durable before it to roll back to, and no mapping to resolve.
       */
      readonly checkpoint: AgentSessionCheckpointRef | null;
    }
  | {
      readonly kind: "input_entry_committed";
      readonly checkpoint: AgentSessionCheckpointRef;
    }
  | {
      readonly kind: "assistant_tool_call_entry_committed";
      readonly checkpoint: AgentSessionCheckpointRef;
      /**
       * Display text of the assistant output this checkpoint names.
       *
       * The provider commits the entry in the write that follows the event, so
       * the entry is not readable yet when this fires: the live run takes the
       * text from the event instead of reading its own Session back.
       */
      readonly assistantText: string;
      /** Provider call ids in the order they appear in the committed assistant entry. */
      readonly providerCallIds: readonly string[];
      /** Synech invocation ids in matching provider order. */
      readonly invocationIds: readonly string[];
    }
  | {
      /** Final assistant output is durable, but becomes a rollback target only after the run snapshot commits. */
      readonly kind: "assistant_response_entry_committed";
      readonly checkpoint: AgentSessionCheckpointRef;
      /** Display text of the assistant output this checkpoint names; see the tool-call variant. */
      readonly assistantText: string;
    }
  | {
      readonly kind: "tool_result_entries_committed";
      readonly checkpoint: AgentSessionCheckpointRef;
      /** Provider call ids in provider order; the matching invocation ids are accepted from the same checkpoint. */
      readonly providerCallIds: readonly string[];
      readonly invocationIds: readonly string[];
    }
  | {
      readonly kind: "compaction_entry_committed";
      readonly checkpoint: AgentSessionCheckpointRef;
      readonly tokensBefore: number;
    }
);

/** Persistence and active-branch operations used by an owning feature. */
export interface AgentSessionRepository {
  create(input: { readonly sessionId: string; readonly sessionCwd: string }): Promise<AgentSessionRef>;
  /** Reads exact assistant entries without transferring transcript ownership. */
  readAssistantEntriesByCheckpoint(input: {
    readonly sessionRef: AgentSessionRef;
    readonly checkpoints: readonly AgentSessionCheckpointRef[];
  }): Promise<readonly AgentSessionAssistantEntry[]>;
  /**
   * Reports where each supplied checkpoint sits on the durable transcript.
   *
   * The provider owns branch structure and order. The product supplies only the
   * checkpoints it has durably recorded and never interprets transcript order
   * itself, so a provider change to branch layout cannot change product
   * behaviour. Checkpoints that are not on the live branch are omitted rather
   * than reported as a position, which lets the caller treat them as foreign
   * without knowing why.
   */
  locateSessionCheckpoints(input: {
    readonly sessionRef: AgentSessionRef;
    readonly checkpoints: readonly AgentSessionCheckpointRef[];
  }): Promise<readonly AgentSessionCheckpointPosition[]>;
  /** Reads the provider-ordered tool calls of one assistant turn named by checkpoint. */
  readToolCallsByCheckpoint(input: {
    readonly sessionRef: AgentSessionRef;
    readonly checkpoint: AgentSessionCheckpointRef;
  }): Promise<readonly ProviderToolCall[]>;
  /**
   * Writes the durable tool results of one assistant turn and returns the
   * checkpoint of the resulting tool-round leaf.
   *
   * A missing or conflicting checkpoint mapping is an explicit failure: the
   * caller must not guess an entry, silently rebuild the mapping, or fall back
   * to the current branch tip.
   */
  reconcileToolResultEntries(input: {
    readonly sessionRef: AgentSessionRef;
    /** Product identity of the assistant turn whose tool calls are being reconciled. */
    readonly assistantCheckpoint: AgentSessionCheckpointRef;
    /**
     * Safe checkpoint to restore when a terminal cleanup moved the active
     * Session branch away from the pending assistant tool-call entry.
     */
    readonly recoveryCheckpoint?: AgentSessionCheckpointRef | null;
    readonly orderedResults: readonly ToolCallResult[];
  }): Promise<AgentSessionCheckpointRef>;
  /** Restores the live branch tip to the entry behind one product checkpoint. */
  moveActiveCheckpoint(
    ref: AgentSessionRef,
    target: AgentSessionCheckpointRef | null,
  ): Promise<AgentSessionCheckpointRef | null>;
  delete(ref: AgentSessionRef): Promise<void>;
}
import type { ToolCallResult, ProviderToolCall } from "../../domain/tools/index.js";
