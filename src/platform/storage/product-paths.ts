import path from "node:path";
import { resolveProductHome, type ResolveProductHomeOptions } from "./product-home.js";

export type AgentDataPaths = {
  readonly root: string;
  readonly runs: string;
  readonly conversations: string;
  readonly sessions: string;
  readonly attachments: string;
  readonly evidence: string;
  readonly memoryFacts: string;
};

export type WorkbenchDataPaths = {
  readonly root: string;
  readonly spaceFiles: string;
  readonly knowledgeAssets: string;
  readonly notes: string;
  readonly methodMemory: string;
};

export type ProductDataPaths = {
  readonly root: string;
  readonly database: string;
  readonly agent: AgentDataPaths;
  readonly workbench: WorkbenchDataPaths;
};

export type ProductStatePaths = {
  readonly root: string;
  readonly journals: string;
  readonly locks: string;
  readonly restoreMarkers: string;
  readonly runtimeTools: {
    readonly root: string;
    readonly mcp: {
      readonly root: string;
      readonly bin: string;
    };
  };
  readonly electron: string;
};

export type ProductCachePaths = {
  readonly root: string;
  readonly electron: string;
};

export type ProductPaths = {
  readonly productHome: string;
  readonly configDirectory: string;
  readonly data: ProductDataPaths;
  readonly state: ProductStatePaths;
  readonly cache: ProductCachePaths;
  readonly backups: string;
};

export function resolveProductPaths(options: ResolveProductHomeOptions = {}): ProductPaths {
  const productHome = resolveProductHome(options);
  const dataRoot = path.join(productHome, "data");
  const agentRoot = path.join(dataRoot, "agent");
  const workbenchRoot = path.join(dataRoot, "workbench");
  const stateRoot = path.join(productHome, "state");
  const runtimeToolsRoot = path.join(stateRoot, "runtime-tools");
  const mcpRuntimeRoot = path.join(runtimeToolsRoot, "mcp");
  const cacheRoot = path.join(productHome, "cache");
  return {
    productHome,
    configDirectory: path.join(productHome, "config"),
    data: {
      root: dataRoot,
      database: path.join(dataRoot, "synech.sqlite3"),
      agent: {
        root: agentRoot,
        runs: path.join(agentRoot, "runs"),
        conversations: path.join(agentRoot, "conversations"),
        sessions: path.join(agentRoot, "sessions"),
        attachments: path.join(agentRoot, "attachments"),
        evidence: path.join(agentRoot, "evidence"),
        memoryFacts: path.join(agentRoot, "memory-facts"),
      },
      workbench: {
        root: workbenchRoot,
        spaceFiles: path.join(workbenchRoot, "space-files"),
        knowledgeAssets: path.join(workbenchRoot, "knowledge-assets"),
        notes: path.join(workbenchRoot, "notes"),
        methodMemory: path.join(workbenchRoot, "method-memory"),
      },
    },
    state: {
      root: stateRoot,
      journals: path.join(stateRoot, "journals"),
      locks: path.join(stateRoot, "locks"),
      restoreMarkers: path.join(stateRoot, "restore-markers"),
      runtimeTools: {
        root: runtimeToolsRoot,
        mcp: {
          root: mcpRuntimeRoot,
          bin: path.join(mcpRuntimeRoot, "bin"),
        },
      },
      electron: path.join(stateRoot, "electron"),
    },
    cache: {
      root: cacheRoot,
      electron: path.join(cacheRoot, "electron"),
    },
    backups: path.join(productHome, "backups"),
  };
}

export function productStorageDirectories(paths: ProductPaths): readonly string[] {
  return [
    paths.configDirectory,
    paths.data.root,
    paths.data.agent.root,
    paths.data.agent.runs,
    paths.data.agent.conversations,
    paths.data.agent.sessions,
    paths.data.agent.attachments,
    paths.data.agent.evidence,
    paths.data.agent.memoryFacts,
    paths.data.workbench.root,
    paths.data.workbench.spaceFiles,
    paths.data.workbench.knowledgeAssets,
    paths.data.workbench.notes,
    paths.data.workbench.methodMemory,
    paths.state.root,
    paths.state.journals,
    paths.state.locks,
    paths.state.restoreMarkers,
    paths.state.runtimeTools.root,
    paths.state.runtimeTools.mcp.root,
    paths.state.runtimeTools.mcp.bin,
    paths.state.electron,
    paths.cache.root,
    paths.cache.electron,
    paths.backups,
  ];
}
