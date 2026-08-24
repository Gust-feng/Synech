import type {
  ExternalPortOccupantFact,
  LocalPortErrorFact,
  LocalPortHost,
  LocalPortProbeFact,
  LocalPortProbeStatus,
  LocalPortWaitFact,
} from "./port-probe.js";

export type ProcessStatus = "starting" | "running" | "exited" | "killing" | "killed" | "unknown";

export type ProcessKind = "background" | "foreground";

export type ProcessLifetime = "run" | "workspace_session";

export type ProcessAuthorizationMode = "confirm_each" | "full_access";

export type ProcessPermissionState = "active" | "revoked" | "stop_pending" | "stopped";

export type ProcessPortFact = {
  readonly port: number;
  readonly host: LocalPortHost;
  readonly requestedAt: string;
  readonly status?: LocalPortProbeStatus;
  readonly ready?: boolean;
  readonly checkedAt?: string;
  readonly durationMs?: number;
  readonly timeoutMs?: number;
  readonly timedOut?: true;
  readonly cancelled?: true;
  readonly error?: LocalPortErrorFact;
  readonly externalOccupant?: ExternalPortOccupantFact;
};

export type ProcessKillTreeStatus = "killed" | "exited" | "unknown" | "failed";

export type ProcessKillTreeResult = {
  readonly status: ProcessKillTreeStatus;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly message?: string;
  readonly errorMessage?: string;
};

export type ProcessKillTreeFact = {
  readonly kind: "kill_tree";
  readonly observedAt: string;
  readonly pid?: number;
  readonly beforeStatus: ProcessStatus;
  readonly resultStatus: ProcessKillTreeStatus;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly message?: string;
  readonly errorMessage?: string;
};

export type ProcessCommandLogLimitFact = {
  readonly kind: "command_log_limit";
  readonly observedAt: string;
  readonly limitBytes: number;
  readonly observedBytes: number;
  readonly action: "terminate_process";
};

export type ProcessFact = ProcessKillTreeFact | ProcessCommandLogLimitFact;

export type ProcessRecord = {
  readonly processId: string;
  readonly conversationId?: string;
  readonly spaceId?: string;
  readonly referenceId?: string;
  readonly runId?: string;
  readonly toolCallId?: string;
  readonly authorizationMode?: ProcessAuthorizationMode;
  readonly permissionState?: ProcessPermissionState;
  readonly pid?: number;
  readonly kind: ProcessKind;
  readonly lifetime: ProcessLifetime;
  readonly owned: boolean;
  readonly commandLine: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: ProcessStatus;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly logRef?: string;
  readonly logPath?: string;
  readonly stopCommand?: string;
  readonly ports: readonly ProcessPortFact[];
  readonly facts: readonly ProcessFact[];
};

export type ProcessRegistration = Omit<ProcessRecord, "lifetime" | "ports" | "facts"> & {
  readonly lifetime?: ProcessLifetime;
  readonly ports?: readonly ProcessPortFact[];
  readonly facts?: readonly ProcessFact[];
};

export type ProcessRecordUpdate = Partial<Omit<ProcessRecord, "processId">>;

export type MarkProcessExitedInput = {
  readonly exitCode?: number;
  readonly signal?: string;
  readonly exitedAt?: string;
};

export type ProcessCleanupSkipReason = "unowned" | "inactive_status" | "lifetime_mismatch";

export type ProcessCleanupSkip = {
  readonly processId: string;
  readonly pid?: number;
  readonly status: ProcessStatus;
  readonly reason: ProcessCleanupSkipReason;
};

export type ProcessCleanupAttemptOutcome = "killed" | "already-exited" | "unknown" | "error";

export type ProcessCleanupAttempt = {
  readonly processId: string;
  readonly pid?: number;
  readonly beforeStatus: ProcessStatus;
  readonly afterStatus: ProcessStatus;
  readonly outcome: ProcessCleanupAttemptOutcome;
  readonly killTree: ProcessKillTreeResult;
};

export type ProcessCleanupResult = {
  readonly attempted: readonly ProcessCleanupAttempt[];
  readonly skipped: readonly ProcessCleanupSkip[];
};

export type ProcessStopResult =
  | {
      readonly status: "not_found";
      readonly processId: string;
    }
  | {
      readonly status: "not_owned" | "already_stopped";
      readonly process: ProcessRecord;
    }
  | {
      readonly status: "stopped" | "unknown" | "failed";
      readonly process: ProcessRecord;
      readonly killTree: ProcessKillTreeResult;
    };

export function processCleanupHasUnresolvedStops(result: ProcessCleanupResult): boolean {
  return result.attempted.some((attempt) => attempt.outcome === "unknown" || attempt.outcome === "error") ||
    result.skipped.some((skip) => skip.reason !== "inactive_status");
}

type ProcessRegistryClock = () => string;

export type ProcessTerminator = {
  readonly killTree: (pid: number, record: ProcessRecord) => Promise<ProcessKillTreeResult> | ProcessKillTreeResult;
};

const UNRESOLVED_PROCESS_STATUSES: readonly ProcessStatus[] = ["starting", "running", "killing", "unknown"];

export class InMemoryProcessRegistry {
  private readonly records = new Map<string, ProcessRecord>();
  private readonly now: ProcessRegistryClock;
  private acceptingRegistrations = true;

  constructor(options: { readonly now?: ProcessRegistryClock } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  register(input: ProcessRegistration): ProcessRecord {
    if (!this.acceptingRegistrations) {
      throw new Error("Process registry is shutting down and no longer accepts registrations.");
    }
    if (this.records.has(input.processId)) {
      throw new Error(`Process already registered: ${input.processId}`);
    }

    const record: ProcessRecord = {
      ...input,
      lifetime: input.lifetime ?? "run",
      ports: clonePortFacts(input.ports ?? []),
      facts: cloneFacts(input.facts ?? []),
    };

    this.records.set(record.processId, cloneRecord(record));
    return cloneRecord(record);
  }

  get(processId: string): ProcessRecord | undefined {
    const record = this.records.get(processId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  listAll(): readonly ProcessRecord[] {
    return Array.from(this.records.values(), cloneRecord);
  }

  update(processId: string, patch: ProcessRecordUpdate): ProcessRecord | undefined {
    const current = this.records.get(processId);
    if (current === undefined) {
      return undefined;
    }

    const next: ProcessRecord = {
      ...current,
      ...patch,
      processId: current.processId,
      ports: patch.ports === undefined ? current.ports : clonePortFacts(patch.ports),
      facts: patch.facts === undefined ? current.facts : cloneFacts(patch.facts),
    };

    this.records.set(processId, cloneRecord(next));
    return cloneRecord(next);
  }

  markExited(processId: string, input: MarkProcessExitedInput = {}): ProcessRecord | undefined {
    return this.update(processId, {
      status: "exited",
      permissionState: "stopped",
      endedAt: input.exitedAt ?? this.now(),
      exitCode: input.exitCode,
      signal: input.signal,
    });
  }

  appendPortFact(processId: string, fact: ProcessPortFact): ProcessRecord | undefined {
    const current = this.records.get(processId);
    if (current === undefined) {
      return undefined;
    }

    const next: ProcessRecord = {
      ...current,
      ports: [...current.ports, clonePortFact(fact)],
    };

    this.records.set(processId, cloneRecord(next));
    return cloneRecord(next);
  }

  appendFact(processId: string, fact: ProcessFact): ProcessRecord | undefined {
    const current = this.records.get(processId);
    if (current === undefined) {
      return undefined;
    }
    const next: ProcessRecord = {
      ...current,
      facts: [...current.facts, { ...fact }],
    };
    this.records.set(processId, cloneRecord(next));
    return cloneRecord(next);
  }

  async cleanupByRun(
    runId: string,
    terminator: ProcessTerminator,
  ): Promise<ProcessCleanupResult> {
    return await this.cleanupMatchingRecords({
      records: Array.from(this.records.values()).filter((record) => record.runId === runId),
      terminator,
      lifetimes: ["run"],
    });
  }

  /** Revokes a removed reference before the first asynchronous stop attempt. */
  async revokeByReference(
    referenceId: string,
    terminator: ProcessTerminator,
  ): Promise<ProcessCleanupResult> {
    return await this.cleanupResourceRecords({
      records: Array.from(this.records.values()).filter((record) => record.referenceId === referenceId),
      terminator,
    });
  }

  async cleanupBySpace(
    spaceId: string,
    terminator: ProcessTerminator,
  ): Promise<ProcessCleanupResult> {
    return await this.cleanupResourceRecords({
      records: Array.from(this.records.values()).filter((record) => record.spaceId === spaceId),
      terminator,
    });
  }

  async cleanupByConversation(
    conversationId: string,
    terminator: ProcessTerminator,
  ): Promise<ProcessCleanupResult> {
    return await this.cleanupResourceRecords({
      records: Array.from(this.records.values()).filter((record) => record.conversationId === conversationId),
      terminator,
    });
  }

  async cleanupOwnedProcesses(
    terminator: ProcessTerminator,
  ): Promise<ProcessCleanupResult> {
    // Closing admission before the first await prevents a new owned process
    // from escaping after the shutdown snapshot has been taken.
    this.acceptingRegistrations = false;
    return await this.cleanupMatchingRecords({
      records: Array.from(this.records.values()),
      terminator,
    });
  }

  async stopOwned(processId: string, terminator: ProcessTerminator): Promise<ProcessStopResult> {
    const record = this.records.get(processId);
    if (record === undefined) {
      return { status: "not_found", processId };
    }
    if (!record.owned) {
      return { status: "not_owned", process: cloneRecord(record) };
    }
    if (!isUnresolvedStatus(record.status)) {
      return { status: "already_stopped", process: cloneRecord(record) };
    }

    const attempt = await this.terminateRecord(record, terminator);
    const process = cloneRecord(this.records.get(processId) ?? record);
    if (attempt.outcome === "killed" || attempt.outcome === "already-exited") {
      return { status: "stopped", process, killTree: attempt.killTree };
    }
    return {
      status: attempt.outcome === "error" ? "failed" : "unknown",
      process,
      killTree: attempt.killTree,
    };
  }

  private async cleanupResourceRecords(input: {
    readonly records: readonly ProcessRecord[];
    readonly terminator: ProcessTerminator;
  }): Promise<ProcessCleanupResult> {
    // This loop intentionally runs before the first await. Once the owning
    // resource is removed, managed process records must stop advertising an
    // active permission even while OS termination is still in progress.
    for (const record of input.records) {
      this.update(record.processId, {
        permissionState: isTerminalStatus(record.status) ? "stopped" : "revoked",
      });
    }

    const cleanup = await this.cleanupMatchingRecords({
      records: input.records,
      terminator: input.terminator,
    });
    for (const attempt of cleanup.attempted) {
      this.update(attempt.processId, {
        permissionState: attempt.outcome === "killed" || attempt.outcome === "already-exited"
          ? "stopped"
          : "stop_pending",
      });
    }
    for (const skipped of cleanup.skipped) {
      this.update(skipped.processId, {
        permissionState: skipped.reason === "inactive_status" ? "stopped" : "stop_pending",
      });
    }

    return cleanup;
  }

  private async cleanupMatchingRecords(input: {
    readonly records: readonly ProcessRecord[];
    readonly terminator: ProcessTerminator;
    readonly lifetimes?: readonly ProcessLifetime[];
  }): Promise<ProcessCleanupResult> {
    const attempted: ProcessCleanupAttempt[] = [];
    const skipped: ProcessCleanupSkip[] = [];

    for (const record of input.records) {
      if (!record.owned) {
        skipped.push(cleanupSkip(record, "unowned"));
        continue;
      }

      if (!isUnresolvedStatus(record.status)) {
        skipped.push(cleanupSkip(record, "inactive_status"));
        continue;
      }
      if (input.lifetimes !== undefined && !input.lifetimes.includes(record.lifetime)) {
        skipped.push(cleanupSkip(record, "lifetime_mismatch"));
        continue;
      }
      attempted.push(await this.terminateRecord(record, input.terminator));
    }

    return { attempted, skipped };
  }

  private async terminateRecord(
    record: ProcessRecord,
    terminator: ProcessTerminator,
  ): Promise<ProcessCleanupAttempt> {
    const before = this.records.get(record.processId) ?? record;
    this.records.set(record.processId, cloneRecord({ ...before, status: "killing" }));

    const killTree = await this.killTree(before, terminator);
    const observedAt = this.now();
    const latest = this.records.get(record.processId) ?? before;
    const nextStatus = latest.status === "exited" ? "exited" : processStatusFromKillTree(killTree);
    const fact: ProcessKillTreeFact = {
      kind: "kill_tree",
      observedAt,
      pid: before.pid,
      beforeStatus: before.status,
      resultStatus: killTree.status,
      exitCode: killTree.exitCode,
      signal: killTree.signal,
      message: killTree.message,
      errorMessage: killTree.errorMessage,
    };
    const next: ProcessRecord = {
      ...latest,
      status: nextStatus,
      permissionState: isTerminalStatus(nextStatus)
        ? "stopped"
        : latest.permissionState === "revoked" || latest.permissionState === "stop_pending"
          ? "stop_pending"
          : latest.permissionState,
      endedAt: isTerminalStatus(nextStatus) ? latest.endedAt ?? observedAt : latest.endedAt,
      exitCode: killTree.exitCode ?? latest.exitCode,
      signal: killTree.signal ?? latest.signal,
      facts: [...latest.facts, fact],
    };

    this.records.set(record.processId, cloneRecord(next));
    return {
      processId: record.processId,
      pid: before.pid,
      beforeStatus: before.status,
      afterStatus: next.status,
      outcome: cleanupOutcomeFromKillTree(killTree),
      killTree: cloneKillTreeResult(killTree),
    };
  }

  private async killTree(record: ProcessRecord, terminator: ProcessTerminator): Promise<ProcessKillTreeResult> {
    if (record.pid === undefined) {
      return {
        status: "unknown",
        message: "Cannot terminate process without a pid.",
      };
    }

    try {
      return await terminator.killTree(record.pid, cloneRecord(record));
    } catch (error) {
      return {
        status: "failed",
        errorMessage: errorMessage(error),
      };
    }
  }
}

export function processPortFactFromLocalPortFact(fact: LocalPortProbeFact | LocalPortWaitFact): ProcessPortFact {
  const portFact: ProcessPortFact = {
    port: fact.port,
    host: fact.host,
    requestedAt: fact.requestedAt,
    checkedAt: fact.checkedAt,
  };
  return withDefinedOptionals(portFact, {
    status: fact.status,
    ready: fact.ready,
    durationMs: fact.durationMs,
    timeoutMs: fact.timeoutMs,
    timedOut: fact.timedOut,
    cancelled: fact.cancelled,
    error: fact.error,
    externalOccupant: fact.externalOccupant,
  });
}

function withDefinedOptionals<T extends object>(base: T, optionals: Partial<T>): T {
  const output: Record<string, unknown> = {};
  Object.assign(output, base);
  for (const [key, value] of Object.entries(optionals)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output as T;
}

function isUnresolvedStatus(status: ProcessStatus): boolean {
  return UNRESOLVED_PROCESS_STATUSES.includes(status);
}

function isTerminalStatus(status: ProcessStatus): boolean {
  return status === "exited" || status === "killed";
}

function processStatusFromKillTree(result: ProcessKillTreeResult): ProcessStatus {
  if (result.status === "killed") {
    return "killed";
  }

  if (result.status === "exited") {
    return "exited";
  }

  return "unknown";
}

function cleanupOutcomeFromKillTree(result: ProcessKillTreeResult): ProcessCleanupAttemptOutcome {
  if (result.status === "killed") {
    return "killed";
  }
  if (result.status === "exited") {
    return "already-exited";
  }
  if (result.status === "failed") {
    return "error";
  }
  return "unknown";
}

function cleanupSkip(record: ProcessRecord, reason: ProcessCleanupSkipReason): ProcessCleanupSkip {
  return {
    processId: record.processId,
    pid: record.pid,
    status: record.status,
    reason,
  };
}

function cloneRecord(record: ProcessRecord): ProcessRecord {
  return {
    ...record,
    ports: clonePortFacts(record.ports),
    facts: cloneFacts(record.facts),
  };
}

function clonePortFacts(facts: readonly ProcessPortFact[]): readonly ProcessPortFact[] {
  return facts.map(clonePortFact);
}

function clonePortFact(fact: ProcessPortFact): ProcessPortFact {
  return {
    ...fact,
    ...(fact.error === undefined ? {} : { error: { ...fact.error } }),
    ...(fact.externalOccupant === undefined ? {} : { externalOccupant: { ...fact.externalOccupant } }),
  };
}

function cloneFacts(facts: readonly ProcessFact[]): readonly ProcessFact[] {
  return facts.map((fact) => ({ ...fact }));
}

function cloneKillTreeResult(result: ProcessKillTreeResult): ProcessKillTreeResult {
  return { ...result };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
