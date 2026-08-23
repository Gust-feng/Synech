import { createConnection } from "node:net";

export type LocalPortHost = "127.0.0.1" | "localhost";
export type LocalPortProbeStatus = "ready" | "not_ready" | "timeout" | "cancelled" | "error";
export type LocalPortWaitStatus = Exclude<LocalPortProbeStatus, "not_ready">;
export type PortOccupantProbeSource = "netstat" | "lsof" | "ss" | "platform_probe";
export type LocalPortOccupancySource = PortOccupantProbeSource | "connect_probe";
export type LocalPortOccupancyOwner = "synech" | "unknown";

export type ExternalPortOccupantFact = {
  readonly pid?: number;
  readonly observedBy: PortOccupantProbeSource;
  readonly ownedByUs: false;
};

export type LocalPortOccupancyFact = {
  readonly kind: "pre_start_port_occupancy";
  readonly port: number;
  readonly host: LocalPortHost;
  readonly occupied: true;
  readonly pid?: number;
  readonly pidKnown: boolean;
  readonly owner: LocalPortOccupancyOwner;
  readonly ownedByUs?: true;
  readonly ownerUnknown?: true;
  readonly source: LocalPortOccupancySource;
  readonly ownershipSource?: "process_registry";
  readonly registryProcessId?: string;
  readonly checkedAt: string;
};

export type PortOccupantProbeInput = {
  readonly port: number;
  readonly host: LocalPortHost;
  readonly observedAt: string;
  readonly abortSignal?: AbortSignal;
};

export type PortOccupantProbeResult = {
  readonly pid?: number;
  readonly observedBy: PortOccupantProbeSource;
};

export type PortOccupantProbe = (
  input: PortOccupantProbeInput
) => PortOccupantProbeResult | undefined | Promise<PortOccupantProbeResult | undefined>;

export type LocalPortErrorFact = {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
};

export type LocalPortProbeFact = {
  readonly kind: "probe";
  readonly port: number;
  readonly host: LocalPortHost;
  readonly status: LocalPortProbeStatus;
  readonly ready: boolean;
  readonly requestedAt: string;
  readonly checkedAt: string;
  readonly durationMs: number;
  readonly timeoutMs: number;
  readonly timedOut?: true;
  readonly cancelled?: true;
  readonly error?: LocalPortErrorFact;
  readonly externalOccupant?: ExternalPortOccupantFact;
};

export type LocalPortWaitFact = {
  readonly kind: "wait";
  readonly port: number;
  readonly host: LocalPortHost;
  readonly status: LocalPortWaitStatus;
  readonly ready: boolean;
  readonly requestedAt: string;
  readonly checkedAt: string;
  readonly durationMs: number;
  readonly timeoutMs: number;
  readonly probeTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly attempts: number;
  readonly timedOut?: true;
  readonly cancelled?: true;
  readonly error?: LocalPortErrorFact;
  readonly externalOccupant?: ExternalPortOccupantFact;
};

export type ProbeLocalPortOptions = {
  readonly port: number;
  readonly host?: LocalPortHost;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly portOccupantProbe?: PortOccupantProbe;
};

export type WaitForLocalPortOptions = {
  readonly port: number;
  readonly host?: LocalPortHost;
  readonly timeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly portOccupantProbe?: PortOccupantProbe;
};

const DEFAULT_HOST: LocalPortHost = "127.0.0.1";
const DEFAULT_PROBE_TIMEOUT_MS = 250;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export async function probeLocalPort(options: ProbeLocalPortOptions): Promise<LocalPortProbeFact> {
  const requestedAtTime = Date.now();
  const requestedAt = new Date(requestedAtTime).toISOString();
  const host = options.host ?? DEFAULT_HOST;
  const timeoutMs = normalizeNonNegativeInteger(options.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
  const invalidPortError = validateTcpPort(options.port);
  if (invalidPortError !== undefined) {
    return probeFact({
      port: options.port,
      host,
      status: "error",
      ready: false,
      requestedAt,
      requestedAtTime,
      timeoutMs,
      error: invalidPortError,
    });
  }
  if (options.abortSignal?.aborted === true) {
    return probeFact({
      port: options.port,
      host,
      status: "cancelled",
      ready: false,
      requestedAt,
      requestedAtTime,
      timeoutMs,
      cancelled: true,
      error: cancelledPortErrorFact(),
    });
  }

  const connection = await connectToLocalPort({
    port: options.port,
    host,
    timeoutMs,
    abortSignal: options.abortSignal,
  });

  if (connection.status !== "ready") {
    return probeFact({
      port: options.port,
      host,
      status: connection.status,
      ready: false,
      requestedAt,
      requestedAtTime,
      timeoutMs,
      timedOut: connection.status === "timeout" ? true : undefined,
      cancelled: connection.status === "cancelled" ? true : undefined,
      error: connection.error ??
        (connection.status === "cancelled"
          ? cancelledPortErrorFact()
          : connection.status === "timeout"
            ? probeTimeoutErrorFact(timeoutMs)
            : undefined),
    });
  }

  const observedAt = new Date().toISOString();
  const externalOccupant = await observeExternalOccupant({
    port: options.port,
    host,
    observedAt,
    abortSignal: options.abortSignal,
    portOccupantProbe: options.portOccupantProbe,
  });
  return probeFact({
    port: options.port,
    host,
    status: "ready",
    ready: true,
    requestedAt,
    requestedAtTime,
    timeoutMs,
    externalOccupant,
  });
}

export async function waitForLocalPort(options: WaitForLocalPortOptions): Promise<LocalPortWaitFact> {
  const requestedAtTime = Date.now();
  const requestedAt = new Date(requestedAtTime).toISOString();
  const host = options.host ?? DEFAULT_HOST;
  const timeoutMs = normalizeNonNegativeInteger(options.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
  const probeTimeoutMs = normalizeNonNegativeInteger(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
  const pollIntervalMs = normalizeNonNegativeInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const invalidPortError = validateTcpPort(options.port);
  if (invalidPortError !== undefined) {
    return waitFact({
      port: options.port,
      host,
      status: "error",
      ready: false,
      requestedAt,
      requestedAtTime,
      timeoutMs,
      probeTimeoutMs,
      pollIntervalMs,
      attempts: 0,
      error: invalidPortError,
    });
  }
  if (options.abortSignal?.aborted === true) {
    return waitFact({
      port: options.port,
      host,
      status: "cancelled",
      ready: false,
      requestedAt,
      requestedAtTime,
      timeoutMs,
      probeTimeoutMs,
      pollIntervalMs,
      attempts: 0,
      cancelled: true,
      error: cancelledPortErrorFact(),
    });
  }

  const deadline = requestedAtTime + timeoutMs;
  let attempts = 0;
  let lastProbeError: LocalPortErrorFact | undefined;
  for (;;) {
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs <= 0) {
      return waitFact({
        port: options.port,
        host,
        status: "timeout",
        ready: false,
        requestedAt,
        requestedAtTime,
        timeoutMs,
        probeTimeoutMs,
        pollIntervalMs,
        attempts,
        timedOut: true,
        error: lastProbeError ?? waitTimeoutErrorFact(timeoutMs),
      });
    }

    attempts += 1;
    const probe = await probeLocalPort({
      port: options.port,
      host,
      timeoutMs: Math.min(probeTimeoutMs, remainingMs),
      abortSignal: options.abortSignal,
      portOccupantProbe: options.portOccupantProbe,
    });
    if (probe.error !== undefined) {
      lastProbeError = probe.error;
    }
    if (probe.status === "ready" || probe.status === "cancelled" || probe.status === "error") {
      return waitFact({
        port: probe.port,
        host: probe.host,
        status: probe.status,
        ready: probe.ready,
        requestedAt,
        requestedAtTime,
        timeoutMs,
        probeTimeoutMs,
        pollIntervalMs,
        attempts,
        cancelled: probe.cancelled,
        error: probe.error ?? (probe.cancelled === true ? cancelledPortErrorFact() : undefined),
        externalOccupant: probe.externalOccupant,
      });
    }

    const delayMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    const delayResult = await delay(delayMs, options.abortSignal);
    if (delayResult === "cancelled") {
      return waitFact({
        port: options.port,
        host,
        status: "cancelled",
        ready: false,
        requestedAt,
        requestedAtTime,
        timeoutMs,
        probeTimeoutMs,
        pollIntervalMs,
        attempts,
        cancelled: true,
        error: cancelledPortErrorFact(),
      });
    }
  }
}

type ConnectionFact = {
  readonly status: LocalPortProbeStatus;
  readonly error?: LocalPortErrorFact;
};

function connectToLocalPort(input: {
  readonly port: number;
  readonly host: LocalPortHost;
  readonly timeoutMs: number;
  readonly abortSignal: AbortSignal | undefined;
}): Promise<ConnectionFact> {
  return new Promise((resolve) => {
    let socket: ReturnType<typeof createConnection>;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fact: ConnectionFact) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      input.abortSignal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(fact);
    };
    const onAbort = () => settle({ status: "cancelled" });
    try {
      socket = createConnection({ host: input.host, port: input.port });
    } catch (error) {
      resolve({ status: "error", error: errorFact(error) });
      return;
    }
    timer = setTimeout(() => settle({ status: "timeout" }), input.timeoutMs);
    socket.once("connect", () => settle({ status: "ready" }));
    socket.once("timeout", () => settle({ status: "timeout" }));
    socket.once("error", (error) => {
      settle(connectionErrorStatus(error) !== "error"
        ? { status: connectionErrorStatus(error), error: errorFact(error) }
        : { status: "error", error: errorFact(error) });
    });
    socket.setTimeout(input.timeoutMs);
    input.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (input.abortSignal?.aborted === true) {
      onAbort();
    }
  });
}

async function observeExternalOccupant(input: {
  readonly port: number;
  readonly host: LocalPortHost;
  readonly observedAt: string;
  readonly abortSignal: AbortSignal | undefined;
  readonly portOccupantProbe: PortOccupantProbe | undefined;
}): Promise<ExternalPortOccupantFact | undefined> {
  let observed: PortOccupantProbeResult | undefined;
  try {
    observed = await input.portOccupantProbe?.({
      port: input.port,
      host: input.host,
      observedAt: input.observedAt,
      abortSignal: input.abortSignal,
    });
  } catch {
    return undefined;
  }
  if (observed === undefined) {
    return undefined;
  }
  const pid = observed.pid;
  return {
    pid: pid !== undefined && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined,
    observedBy: observed.observedBy,
    ownedByUs: false,
  };
}

function probeFact(input: {
  readonly port: number;
  readonly host: LocalPortHost;
  readonly status: LocalPortProbeStatus;
  readonly ready: boolean;
  readonly requestedAt: string;
  readonly requestedAtTime: number;
  readonly timeoutMs: number;
  readonly timedOut?: true;
  readonly cancelled?: true;
  readonly error?: LocalPortErrorFact;
  readonly externalOccupant?: ExternalPortOccupantFact;
}): LocalPortProbeFact {
  const checkedAtTime = Date.now();
  return {
    kind: "probe",
    port: input.port,
    host: input.host,
    status: input.status,
    ready: input.ready,
    requestedAt: input.requestedAt,
    checkedAt: new Date(checkedAtTime).toISOString(),
    durationMs: Math.max(0, checkedAtTime - input.requestedAtTime),
    timeoutMs: input.timeoutMs,
    timedOut: input.timedOut,
    cancelled: input.cancelled,
    error: input.error,
    externalOccupant: input.externalOccupant,
  };
}

function waitFact(input: {
  readonly port: number;
  readonly host: LocalPortHost;
  readonly status: LocalPortWaitStatus;
  readonly ready: boolean;
  readonly requestedAt: string;
  readonly requestedAtTime: number;
  readonly timeoutMs: number;
  readonly probeTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly attempts: number;
  readonly timedOut?: true;
  readonly cancelled?: true;
  readonly error?: LocalPortErrorFact;
  readonly externalOccupant?: ExternalPortOccupantFact;
}): LocalPortWaitFact {
  const checkedAtTime = Date.now();
  return {
    kind: "wait",
    port: input.port,
    host: input.host,
    status: input.status,
    ready: input.ready,
    requestedAt: input.requestedAt,
    checkedAt: new Date(checkedAtTime).toISOString(),
    durationMs: Math.max(0, checkedAtTime - input.requestedAtTime),
    timeoutMs: input.timeoutMs,
    probeTimeoutMs: input.probeTimeoutMs,
    pollIntervalMs: input.pollIntervalMs,
    attempts: input.attempts,
    timedOut: input.timedOut,
    cancelled: input.cancelled,
    error: input.error,
    externalOccupant: input.externalOccupant,
  };
}

function validateTcpPort(port: number): LocalPortErrorFact | undefined {
  if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
    return undefined;
  }
  return {
    name: "InvalidPort",
    message: "Local TCP port must be an integer between 1 and 65535.",
    code: "ERR_INVALID_TCP_PORT",
  };
}

function waitTimeoutErrorFact(timeoutMs: number): LocalPortErrorFact {
  return {
    name: "TimeoutError",
    message: `Local TCP port did not become ready within ${timeoutMs}ms.`,
    code: "WAIT_FOR_PORT_TIMEOUT",
  };
}

function probeTimeoutErrorFact(timeoutMs: number): LocalPortErrorFact {
  return {
    name: "TimeoutError",
    message: `Local TCP port probe did not finish within ${timeoutMs}ms.`,
    code: "PORT_PROBE_TIMEOUT",
  };
}

function cancelledPortErrorFact(): LocalPortErrorFact {
  return {
    name: "AbortError",
    message: "Local TCP port wait was cancelled.",
    code: "ABORT_ERR",
  };
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function delay(ms: number, abortSignal: AbortSignal | undefined): Promise<"elapsed" | "cancelled"> {
  if (ms <= 0) {
    return Promise.resolve(abortSignal?.aborted === true ? "cancelled" : "elapsed");
  }
  if (abortSignal?.aborted === true) {
    return Promise.resolve("cancelled");
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      abortSignal?.removeEventListener("abort", onAbort);
      resolve("elapsed");
    }, ms);
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve("cancelled");
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function connectionErrorStatus(error: NodeJS.ErrnoException): Exclude<LocalPortProbeStatus, "ready" | "cancelled"> {
  if (error.code === "ETIMEDOUT") {
    return "timeout";
  }

  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(error.code ?? "")) {
    return "not_ready";
  }

  return "error";
}

function errorFact(error: unknown): LocalPortErrorFact {
  if (error instanceof Error) {
    const code = typeof (error as NodeJS.ErrnoException).code === "string"
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    return {
      name: error.name,
      message: error.message,
      code,
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}
