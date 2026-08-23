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

export type ProcessCleanupReason =
  | "run_release"
  | "cancel"
  | "shutdown"
  | "reference_revoked"
  | "space_deleted"
  | "conversation_deleted";

export type ProcessCleanupScope = "run" | "registry" | "reference" | "space" | "conversation";

export type ProcessCleanupFact = {
  readonly kind: "process_cleanup";
  readonly observedAt: string;
  readonly scope: ProcessCleanupScope;
  readonly reason: ProcessCleanupReason;
  readonly runId?: string;
  readonly conversationId?: string;
  readonly spaceId?: string;
  readonly referenceId?: string;
  readonly attempted: readonly ProcessCleanupAttempt[];
  readonly skipped: readonly ProcessCleanupSkip[];
};

export type ProcessCleanupResult = {
  readonly runId: string;
  readonly attempted: readonly ProcessCleanupAttempt[];
  readonly skipped: readonly ProcessCleanupSkip[];
  readonly summary: ProcessRunResidueSummary;
  readonly fact: ProcessCleanupFact;
};

export type ProcessCleanupOptions = {
  readonly includeUnowned?: boolean;
  readonly statuses?: readonly ProcessStatus[];
  readonly lifetimes?: readonly ProcessLifetime[];
  readonly reason?: ProcessCleanupReason;
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

export type ProcessRegistryCleanupResult = {
  readonly kind: "process_registry_cleanup";
  readonly reason: ProcessCleanupReason;
  readonly observedAt: string;
  readonly attempted: readonly ProcessCleanupAttempt[];
  readonly skipped: readonly ProcessCleanupSkip[];
  readonly fact: ProcessCleanupFact;
};

export function processCleanupHasUnresolvedStops(result: ProcessRegistryCleanupResult): boolean {
  return result.attempted.some((attempt) => attempt.outcome === "unknown" || attempt.outcome === "error") ||
    result.skipped.some((skip) => skip.reason !== "inactive_status");
}

export type ProcessStatusCounts = Readonly<Record<ProcessStatus, number>>;

export type ProcessRunProcessSummary = {
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
  readonly factCount: number;
  readonly latestFact?: ProcessFact;
};

export type ProcessRunResidueSummary = {
  readonly kind: "process_run_residue_summary";
  readonly runId: string;
  readonly observedAt: string;
  readonly totalCount: number;
  readonly ownedCount: number;
  readonly unownedCount: number;
  readonly residualCount: number;
  readonly statuses: ProcessStatusCounts;
  readonly processes: readonly ProcessRunProcessSummary[];
  readonly residualProcesses: readonly ProcessRunProcessSummary[];
};

export type ProcessRegistryClock = () => string;

export type ProcessTerminator = {
  readonly killTree: (pid: number, record: ProcessRecord) => Promise<ProcessKillTreeResult> | ProcessKillTreeResult;
};

const ACTIVE_PROCESS_STATUSES: readonly ProcessStatus[] = ["starting", "running", "killing"];
const UNRESOLVED_PROCESS_STATUSES: readonly ProcessStatus[] = ["starting", "running", "killing", "unknown"];
const PROCESS_STATUSES: readonly ProcessStatus[] = ["starting", "running", "exited", "killing", "killed", "unknown"];

export class InMemoryProcessRegistry {
  private readonly records = new Map<string, ProcessRecord>();
  private readonly cleanupFacts: ProcessCleanupFact[] = [];
  private readonly residueSummaries: ProcessRunResidueSummary[] = [];
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

  listCleanupFacts(): readonly ProcessCleanupFact[] {
    return this.cleanupFacts.map(cloneCleanupFact);
  }

  listRunResidueSummaries(runId?: string): readonly ProcessRunResidueSummary[] {
    const summaries = runId === undefined
      ? this.residueSummaries
      : this.residueSummaries.filter((summary) => summary.runId === runId);
    return summaries.map(cloneRunResidueSummary);
  }

  listByRun(runId: string): readonly ProcessRecord[] {
    return this.listAll().filter((record) => record.runId === runId);
  }

  listActiveByRun(runId: string): readonly ProcessRecord[] {
    return this.listByRun(runId).filter((record) => isActiveStatus(record.status));
  }

  listUnresolvedByRun(runId: string): readonly ProcessRecord[] {
    return this.listByRun(runId).filter((record) => isUnresolvedStatus(record.status));
  }

  summarizeRun(runId: string): ProcessRunResidueSummary {
    return processRunResidueSummary(runId, this.listByRun(runId), this.now());
  }

  recordRunResidueSummary(runId: string): ProcessRunResidueSummary {
    const summary = this.summarizeRun(runId);
    this.residueSummaries.push(cloneRunResidueSummary(summary));
    return cloneRunResidueSummary(summary);
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
    options: ProcessCleanupOptions = {}
  ): Promise<ProcessCleanupResult> {
    const cleanup = await this.cleanupMatchingRecords({
      scope: "run",
      runId,
      reason: options.reason ?? "run_release",
      records: Array.from(this.records.values()).filter((record) => record.runId === runId),
      terminator,
      includeUnowned: options.includeUnowned ?? false,
      statuses: options.statuses ?? UNRESOLVED_PROCESS_STATUSES,
      lifetimes: options.lifetimes ?? ["run"],
    });

    return {
      runId,
      attempted: cleanup.attempted,
      skipped: cleanup.skipped,
      summary: this.summarizeRun(runId),
      fact: cleanup.fact,
    };
  }

  /** Revokes a removed reference before the first asynchronous stop attempt. */
  async revokeByReference(
    referenceId: string,
    terminator: ProcessTerminator,
  ): Promise<ProcessRegistryCleanupResult> {
    return await this.cleanupResourceRecords({
      scope: "reference",
      reason: "reference_revoked",
      referenceId,
      records: Array.from(this.records.values()).filter((record) => record.referenceId === referenceId),
      terminator,
    });
  }

  async cleanupBySpace(
    spaceId: string,
    terminator: ProcessTerminator,
  ): Promise<ProcessRegistryCleanupResult> {
    return await this.cleanupResourceRecords({
      scope: "space",
      reason: "space_deleted",
      spaceId,
      records: Array.from(this.records.values()).filter((record) => record.spaceId === spaceId),
      terminator,
    });
  }

  async cleanupByConversation(
    conversationId: string,
    terminator: ProcessTerminator,
  ): Promise<ProcessRegistryCleanupResult> {
    return await this.cleanupResourceRecords({
      scope: "conversation",
      reason: "conversation_deleted",
      conversationId,
      records: Array.from(this.records.values()).filter((record) => record.conversationId === conversationId),
      terminator,
    });
  }

  async cleanupOwnedBackgroundProcesses(
    terminator: ProcessTerminator,
    options: Omit<ProcessCleanupOptions, "includeUnowned"> = {}
  ): Promise<ProcessRegistryCleanupResult> {
    const cleanup = await this.cleanupMatchingRecords({
      scope: "registry",
      reason: options.reason ?? "shutdown",
      records: Array.from(this.records.values()).filter((record) => record.kind === "background"),
      terminator,
      includeUnowned: false,
      statuses: options.statuses ?? UNRESOLVED_PROCESS_STATUSES,
      lifetimes: options.lifetimes,
    });
    return {
      kind: "process_registry_cleanup",
      reason: cleanup.fact.reason,
      observedAt: cleanup.fact.observedAt,
      attempted: cleanup.attempted,
      skipped: cleanup.skipped,
      fact: cleanup.fact,
    };
  }

  async cleanupOwnedProcesses(
    terminator: ProcessTerminator,
    options: Omit<ProcessCleanupOptions, "includeUnowned"> = {}
  ): Promise<ProcessRegistryCleanupResult> {
    // Closing admission before the first await prevents a new owned process
    // from escaping after the shutdown snapshot has been taken.
    this.acceptingRegistrations = false;
    const cleanup = await this.cleanupMatchingRecords({
      scope: "registry",
      reason: options.reason ?? "shutdown",
      records: Array.from(this.records.values()),
      terminator,
      includeUnowned: false,
      statuses: options.statuses ?? UNRESOLVED_PROCESS_STATUSES,
      lifetimes: options.lifetimes,
    });
    return {
      kind: "process_registry_cleanup",
      reason: cleanup.fact.reason,
      observedAt: cleanup.fact.observedAt,
      attempted: cleanup.attempted,
      skipped: cleanup.skipped,
      fact: cleanup.fact,
    };
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
    readonly scope: "reference" | "space" | "conversation";
    readonly reason: "reference_revoked" | "space_deleted" | "conversation_deleted";
    readonly conversationId?: string;
    readonly spaceId?: string;
    readonly referenceId?: string;
    readonly records: readonly ProcessRecord[];
    readonly terminator: ProcessTerminator;
  }): Promise<ProcessRegistryCleanupResult> {
    // This loop intentionally runs before the first await. Once the owning
    // resource is removed, managed process records must stop advertising an
    // active permission even while OS termination is still in progress.
    for (const record of input.records) {
      this.update(record.processId, {
        permissionState: isTerminalStatus(record.status) ? "stopped" : "revoked",
      });
    }

    const cleanup = await this.cleanupMatchingRecords({
      scope: input.scope,
      reason: input.reason,
      conversationId: input.conversationId,
      spaceId: input.spaceId,
      referenceId: input.referenceId,
      records: input.records,
      terminator: input.terminator,
      includeUnowned: false,
      statuses: UNRESOLVED_PROCESS_STATUSES,
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

    return {
      kind: "process_registry_cleanup",
      reason: cleanup.fact.reason,
      observedAt: cleanup.fact.observedAt,
      attempted: cleanup.attempted,
      skipped: cleanup.skipped,
      fact: cleanup.fact,
    };
  }

  private async cleanupMatchingRecords(input: {
    readonly scope: ProcessCleanupScope;
    readonly runId?: string;
    readonly conversationId?: string;
    readonly spaceId?: string;
    readonly referenceId?: string;
    readonly reason: ProcessCleanupReason;
    readonly records: readonly ProcessRecord[];
    readonly terminator: ProcessTerminator;
    readonly includeUnowned: boolean;
    readonly statuses: readonly ProcessStatus[];
    readonly lifetimes?: readonly ProcessLifetime[];
  }): Promise<{
    readonly attempted: readonly ProcessCleanupAttempt[];
    readonly skipped: readonly ProcessCleanupSkip[];
    readonly fact: ProcessCleanupFact;
  }> {
    const attempted: ProcessCleanupAttempt[] = [];
    const skipped: ProcessCleanupSkip[] = [];

    for (const record of input.records) {
      if (!input.includeUnowned && !record.owned) {
        skipped.push(cleanupSkip(record, "unowned"));
        continue;
      }

      if (!input.statuses.includes(record.status)) {
        skipped.push(cleanupSkip(record, "inactive_status"));
        continue;
      }
      if (input.lifetimes !== undefined && !input.lifetimes.includes(record.lifetime)) {
        skipped.push(cleanupSkip(record, "lifetime_mismatch"));
        continue;
      }
      attempted.push(await this.terminateRecord(record, input.terminator));
    }

    const cleanupBase: ProcessCleanupFact = {
      kind: "process_cleanup",
      observedAt: this.now(),
      scope: input.scope,
      reason: input.reason,
      attempted: attempted.map(cloneCleanupAttempt),
      skipped: skipped.map(cloneCleanupSkip),
    };
    const cleanupFact = withDefinedOptionals(cleanupBase, {
      runId: input.runId,
      conversationId: input.conversationId,
      spaceId: input.spaceId,
      referenceId: input.referenceId,
    });
    this.cleanupFacts.push(cloneCleanupFact(cleanupFact));
    return {
      attempted: attempted.map(cloneCleanupAttempt),
      skipped: skipped.map(cloneCleanupSkip),
      fact: cloneCleanupFact(cleanupFact),
    };
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

function isActiveStatus(status: ProcessStatus): boolean {
  return ACTIVE_PROCESS_STATUSES.includes(status);
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

function cloneCleanupAttempt(attempt: ProcessCleanupAttempt): ProcessCleanupAttempt {
  return {
    ...attempt,
    killTree: cloneKillTreeResult(attempt.killTree),
  };
}

function cloneCleanupSkip(skip: ProcessCleanupSkip): ProcessCleanupSkip {
  return { ...skip };
}

function cloneCleanupFact(fact: ProcessCleanupFact): ProcessCleanupFact {
  const clone: ProcessCleanupFact = {
    kind: fact.kind,
    observedAt: fact.observedAt,
    scope: fact.scope,
    reason: fact.reason,
    attempted: fact.attempted.map(cloneCleanupAttempt),
    skipped: fact.skipped.map(cloneCleanupSkip),
  };
  return withDefinedOptionals(clone, {
    runId: fact.runId,
    conversationId: fact.conversationId,
    spaceId: fact.spaceId,
    referenceId: fact.referenceId,
  });
}

function cloneKillTreeResult(result: ProcessKillTreeResult): ProcessKillTreeResult {
  return { ...result };
}

function cloneRunResidueSummary(summary: ProcessRunResidueSummary): ProcessRunResidueSummary {
  return {
    ...summary,
    statuses: { ...summary.statuses },
    processes: summary.processes.map(cloneRunProcessSummary),
    residualProcesses: summary.residualProcesses.map(cloneRunProcessSummary),
  };
}

function cloneRunProcessSummary(summary: ProcessRunProcessSummary): ProcessRunProcessSummary {
  const clone: ProcessRunProcessSummary = {
    processId: summary.processId,
    kind: summary.kind,
    lifetime: summary.lifetime,
    owned: summary.owned,
    commandLine: summary.commandLine,
    cwd: summary.cwd,
    startedAt: summary.startedAt,
    status: summary.status,
    ports: clonePortFacts(summary.ports),
    factCount: summary.factCount,
  };
  return withDefinedOptionals(clone, {
    conversationId: summary.conversationId,
    spaceId: summary.spaceId,
    referenceId: summary.referenceId,
    runId: summary.runId,
    toolCallId: summary.toolCallId,
    authorizationMode: summary.authorizationMode,
    permissionState: summary.permissionState,
    pid: summary.pid,
    endedAt: summary.endedAt,
    exitCode: summary.exitCode,
    signal: summary.signal,
    logRef: summary.logRef,
    logPath: summary.logPath,
    stopCommand: summary.stopCommand,
    latestFact: summary.latestFact === undefined ? undefined : { ...summary.latestFact },
  });
}

function processRunResidueSummary(
  runId: string,
  records: readonly ProcessRecord[],
  observedAt: string
): ProcessRunResidueSummary {
  const processes = records.map(processRunProcessSummary);
  return {
    kind: "process_run_residue_summary",
    runId,
    observedAt,
    totalCount: processes.length,
    ownedCount: processes.filter((process) => process.owned).length,
    unownedCount: processes.filter((process) => !process.owned).length,
    residualCount: processes.filter((process) => isUnresolvedStatus(process.status)).length,
    statuses: processStatusCounts(records),
    processes,
    residualProcesses: processes.filter((process) => isUnresolvedStatus(process.status)),
  };
}

function processRunProcessSummary(record: ProcessRecord): ProcessRunProcessSummary {
  const latestFact = record.facts.at(-1);
  const summary: ProcessRunProcessSummary = {
    processId: record.processId,
    conversationId: record.conversationId,
    spaceId: record.spaceId,
    referenceId: record.referenceId,
    runId: record.runId,
    toolCallId: record.toolCallId,
    authorizationMode: record.authorizationMode,
    permissionState: record.permissionState,
    pid: record.pid,
    kind: record.kind,
    lifetime: record.lifetime,
    owned: record.owned,
    commandLine: record.commandLine,
    cwd: record.cwd,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    status: record.status,
    exitCode: record.exitCode,
    signal: record.signal,
    logRef: record.logRef,
    logPath: record.logPath,
    stopCommand: record.stopCommand,
    ports: clonePortFacts(record.ports),
    factCount: record.facts.length,
    latestFact: latestFact === undefined ? undefined : { ...latestFact },
  };
  return withDefinedOptionals(summary, {
    runId: summary.runId,
    toolCallId: summary.toolCallId,
    pid: summary.pid,
    endedAt: summary.endedAt,
    exitCode: summary.exitCode,
    signal: summary.signal,
    logRef: summary.logRef,
    logPath: summary.logPath,
    stopCommand: summary.stopCommand,
    latestFact: summary.latestFact,
  });
}

function processStatusCounts(records: readonly ProcessRecord[]): ProcessStatusCounts {
  const counts: Record<ProcessStatus, number> = {
    starting: 0,
    running: 0,
    exited: 0,
    killing: 0,
    killed: 0,
    unknown: 0,
  };
  for (const record of records) {
    counts[record.status] += 1;
  }
  for (const status of PROCESS_STATUSES) {
    counts[status] = counts[status] ?? 0;
  }
  return counts;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}