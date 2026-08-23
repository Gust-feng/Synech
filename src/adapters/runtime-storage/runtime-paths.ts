import path from "node:path";

export type OrdinaryRuntimePaths = {
  readonly root: string;
  readonly runs: string;
  readonly conversations: string;
  readonly sessions: string;
  readonly attachments: string;
  readonly evidence: string;
  readonly memoryFacts: string;
};

export type SynechRuntimePaths = {
  readonly root: string;
  readonly spaceFiles: string;
  readonly knowledgeAssets: string;
  readonly notes: string;
  readonly methodMemory: string;
};

export type SystemRuntimePaths = {
  readonly root: string;
  readonly journals: string;
  readonly locks: string;
  readonly backups: string;
  readonly restoreMarkers: string;
};

/** All durable paths below one product runtime namespace. */
export type RuntimePaths = {
  readonly runtimeHome: string;
  readonly synechDatabase: string;
  readonly ordinary: OrdinaryRuntimePaths;
  readonly synech: SynechRuntimePaths;
  readonly system: SystemRuntimePaths;
};

/** Product identity plus its already-resolved runtime paths. */
export type ProductPaths = RuntimePaths & {
  readonly appHome: string;
  readonly configDirectory: string;
};

export function resolveProductAppHomeFromConfigDirectory(configDirectory: string): string {
  const resolved = path.resolve(configDirectory);
  return path.basename(resolved).toLowerCase() === "config" ? path.dirname(resolved) : resolved;
}

export function resolveProductPaths(configDirectory: string): ProductPaths {
  const appHome = resolveProductAppHomeFromConfigDirectory(configDirectory);
  const runtimeHome = path.join(appHome, "runtime");
  const ordinaryRoot = path.join(runtimeHome, "ordinary");
  const synechRoot = path.join(runtimeHome, "synech");
  const systemRoot = path.join(runtimeHome, "system");
  return {
    appHome,
    configDirectory: path.resolve(configDirectory),
    runtimeHome,
    synechDatabase: path.join(runtimeHome, "synech.sqlite3"),
    ordinary: {
      root: ordinaryRoot,
      runs: path.join(ordinaryRoot, "runs"),
      conversations: path.join(ordinaryRoot, "conversations"),
      sessions: path.join(ordinaryRoot, "sessions"),
      attachments: path.join(ordinaryRoot, "attachments"),
      evidence: path.join(ordinaryRoot, "evidence"),
      memoryFacts: path.join(ordinaryRoot, "memory-facts"),
    },
    synech: {
      root: synechRoot,
      spaceFiles: path.join(synechRoot, "space-files"),
      knowledgeAssets: path.join(synechRoot, "knowledge-assets"),
      notes: path.join(synechRoot, "notes"),
      methodMemory: path.join(synechRoot, "method-memory"),
    },
    system: {
      root: systemRoot,
      journals: path.join(systemRoot, "journals"),
      locks: path.join(systemRoot, "locks"),
      backups: path.join(systemRoot, "backups"),
      restoreMarkers: path.join(systemRoot, "restore-markers"),
    },
  };
}
