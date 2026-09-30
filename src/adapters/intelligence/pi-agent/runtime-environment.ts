import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

/**
 * Product-safe local execution capability.
 *
 * Synech only needs "an addressable local root plus a release lifecycle". The
 * pi FileSystem/Shell shape never enters a product contract: the bridge from a
 * handle back to the pi object is held privately in this module, so replacing
 * the runtime provider does not touch product types.
 */
export interface AgentRuntimeEnvironment {
  /** Absolute local root this environment addresses. */
  readonly root: string;
  cleanup(): Promise<void>;
}

/** Per-root shared execution environments reused across session storage and runs. */
export interface AgentRuntimeEnvironmentFactory {
  acquire(root: string): AgentRuntimeEnvironment;
  releaseAll(): Promise<void>;
}

/**
 * Opaque handle for one durable Agent Session. Adapter-owned so the pi Session
 * identity is not named by product code.
 */
export type AgentSessionHandle<
  TMetadata extends import("@earendil-works/pi-agent-core").SessionMetadata = import("@earendil-works/pi-agent-core").SessionMetadata,
> = import("@earendil-works/pi-agent-core").Session<TMetadata>;

class NodeAgentRuntimeEnvironment implements AgentRuntimeEnvironment {
  constructor(private readonly env: ExecutionEnv) {}

  get root(): string {
    return this.env.cwd;
  }

  cleanup(): Promise<void> {
    return this.env.cleanup(TODO_CONTEXT);
  }
}

const environmentsByHandle = new WeakMap<AgentRuntimeEnvironment, ExecutionEnv>();

function register(env: ExecutionEnv): AgentRuntimeEnvironment {
  const handle = new NodeAgentRuntimeEnvironment(env);
  environmentsByHandle.set(handle, env);
  return handle;
}

/**
 * Adapter-only bridge. Product code must never call this: it recovers the
 * provider object behind a product handle and is the single place where the
 * pi environment shape is mapped into adapter internals.
 */
export function agentRuntimeExecutionEnv(environment: AgentRuntimeEnvironment): ExecutionEnv {
  const env = environmentsByHandle.get(environment);
  if (env === undefined) {
    throw new Error("This Agent Runtime environment was not created by the pi adapter.");
  }
  return env;
}

export function createAgentRuntimeEnvironment(root: string): AgentRuntimeEnvironment {
  return register(new NodeExecutionEnv({ cwd: root }));
}

export function createAgentRuntimeEnvironmentFactory(): AgentRuntimeEnvironmentFactory {
  const environments = new Map<string, AgentRuntimeEnvironment>();
  return {
    acquire(root: string): AgentRuntimeEnvironment {
      const existing = environments.get(root);
      if (existing !== undefined) return existing;
      const created = createAgentRuntimeEnvironment(root);
      environments.set(root, created);
      return created;
    },
    async releaseAll(): Promise<void> {
      await Promise.all([...environments.values()].map((environment) => environment.cleanup()));
      environments.clear();
    },
  };
}
