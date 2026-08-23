/** Stable locator for one durable agent transcript. */
export type AgentSessionRef = {
  readonly sessionId: string;
  readonly storageKey: string;
  readonly sessionCwd: string;
  readonly createdAt: string;
};

/** Entry ids are only unique inside one session and must always stay qualified. */
export type AgentSessionEntryRef = {
  readonly sessionId: string;
  readonly entryId: string;
};

/** Qualified Session entries written or observed by one model-tool-model execution chain. */
export type AgentSessionExecutionRefs = {
  readonly sessionId: string;
  readonly startLeafRef: AgentSessionEntryRef | null;
  readonly inputEntryRef?: AgentSessionEntryRef;
  /** Latest branch position whose model protocol group was durably accepted. */
  readonly safeLeafRef: AgentSessionEntryRef | null;
  readonly latestLeafRef: AgentSessionEntryRef | null;
  readonly compactionEntryRefs: readonly AgentSessionEntryRef[];
};

/** Ordered user-visible assistant entry read from one durable Session branch. */
export type AgentSessionAssistantEntry = {
  readonly entryRef: AgentSessionEntryRef;
  readonly text: string;
};

/** Awaited durable checkpoints emitted in agent Session write order. */
export type AgentSessionWriteCheckpoint = { readonly sessionId: string } & (
  | { readonly kind: "start_leaf_captured"; readonly startLeafRef: AgentSessionEntryRef | null }
  | { readonly kind: "input_entry_committed"; readonly inputEntryRef: AgentSessionEntryRef }
  | {
      readonly kind: "assistant_tool_call_entry_committed";
      readonly assistantEntryRef: AgentSessionEntryRef;
      readonly toolCallIds: readonly string[];
    }
  | {
      /** Final assistant output is durable, but becomes a rollback target only after the run snapshot commits. */
      readonly kind: "assistant_response_entry_committed";
      readonly assistantEntryRef: AgentSessionEntryRef;
    }
  | {
      readonly kind: "tool_result_entries_committed";
      readonly toolRoundLeafRef: AgentSessionEntryRef;
      readonly toolCallIds: readonly string[];
    }
  | {
      readonly kind: "compaction_entry_committed";
      readonly compactionEntryRef: AgentSessionEntryRef;
      readonly tokensBefore: number;
    }
);

/** Persistence and active-branch operations used by an owning feature. */
export interface AgentSessionRepository {
  create(input: { readonly sessionId: string; readonly sessionCwd: string }): Promise<AgentSessionRef>;
  getActiveLeaf(ref: AgentSessionRef): Promise<AgentSessionEntryRef | null>;
  moveActiveLeaf(ref: AgentSessionRef, target: AgentSessionEntryRef | null): Promise<AgentSessionEntryRef | null>;
  getActiveBranchEntryRefs(ref: AgentSessionRef): Promise<readonly AgentSessionEntryRef[]>;
  /** Reads exact assistant entries without transferring transcript ownership. */
  readAssistantEntries(input: {
    readonly sessionRef: AgentSessionRef;
    readonly entryRefs: readonly AgentSessionEntryRef[];
  }): Promise<readonly AgentSessionAssistantEntry[]>;
  readToolCalls(input: {
    readonly sessionRef: AgentSessionRef;
    readonly assistantEntryRef: AgentSessionEntryRef;
  }): Promise<readonly ToolCallRequest[]>;
  reconcileToolResultEntries(input: {
    readonly sessionRef: AgentSessionRef;
    readonly assistantEntryRef: AgentSessionEntryRef;
    /**
     * Safe leaf to restore when a terminal cleanup moved the active Session
     * branch away from the pending assistant tool-call entry.
     */
    readonly recoveryLeafRef?: AgentSessionEntryRef | null;
    readonly orderedResults: readonly ToolCallResult[];
  }): Promise<AgentSessionEntryRef>;
  delete(ref: AgentSessionRef): Promise<void>;
}
import type { ToolCallRequest, ToolCallResult } from "../../domain/tools/index.js";
