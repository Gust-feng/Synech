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

export type SpaceDataPaths = {
  readonly root: string;
  readonly files: string;
  readonly webMetadata: string;
};

export type KnowledgeDataPaths = {
  readonly root: string;
  readonly assets: string;
};

export type MemoryDataPaths = {
  readonly root: string;
  readonly agentNotes: string;
  readonly collaborationRules: string;
  readonly methods: string;
};

export type ProductDataPaths = {
  readonly root: string;
  readonly database: string;
  readonly agent: AgentDataPaths;
  readonly spaces: SpaceDataPaths;
  readonly knowledge: KnowledgeDataPaths;
  readonly memory: MemoryDataPaths;
};

export type ProductStatePaths = {
  readonly root: string;
  readonly journals: string;
  readonly locks: string;
  readonly diagnostics: {
    readonly root: string;
    readonly webReferenceMetadata: string;
  };
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
  readonly commandLogs: string;
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
  const spacesRoot = path.join(dataRoot, "spaces");
  const knowledgeRoot = path.join(dataRoot, "knowledge");
  const memoryRoot = path.join(dataRoot, "memory");
  const stateRoot = path.join(productHome, "state");
  const diagnosticsRoot = path.join(stateRoot, "diagnostics");
  const runtimeToolsRoot = path.join(stateRoot, "runtime-tools");
  const mcpRuntimeRoot = path.join(runtimeToolsRoot, "mcp");
  const cacheRoot = path.join(productHome, "cache");
  const commandLogs = path.join(cacheRoot, "command-logs");
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
      spaces: {
        root: spacesRoot,
        files: path.join(spacesRoot, "files"),
        webMetadata: path.join(spacesRoot, "web-metadata"),
      },
      knowledge: {
        root: knowledgeRoot,
        assets: path.join(knowledgeRoot, "assets"),
      },
      memory: {
        root: memoryRoot,
        agentNotes: path.join(memoryRoot, "agent-notes"),
        collaborationRules: path.join(memoryRoot, "collaboration-rules"),
        methods: path.join(memoryRoot, "methods"),
      },
    },
    state: {
      root: stateRoot,
      journals: path.join(stateRoot, "journals"),
      locks: path.join(stateRoot, "locks"),
      diagnostics: {
        root: diagnosticsRoot,
        webReferenceMetadata: path.join(diagnosticsRoot, "web-reference-metadata.jsonl"),
      },
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
      commandLogs,
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
    paths.data.spaces.root,
    paths.data.spaces.files,
    paths.data.spaces.webMetadata,
    paths.data.knowledge.root,
    paths.data.knowledge.assets,
    paths.data.memory.root,
    paths.data.memory.agentNotes,
    paths.data.memory.collaborationRules,
    paths.data.memory.methods,
    paths.state.root,
    paths.state.journals,
    paths.state.locks,
    paths.state.diagnostics.root,
    paths.state.restoreMarkers,
    paths.state.runtimeTools.root,
    paths.state.runtimeTools.mcp.root,
    paths.state.runtimeTools.mcp.bin,
    paths.state.electron,
    paths.cache.root,
    paths.cache.electron,
    paths.cache.commandLogs,
    paths.backups,
  ];
}
