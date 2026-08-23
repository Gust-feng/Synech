import { asRecord } from "../../../kernel/values/index.js";
import path from "node:path";
import type { ToolExecutionContext, ToolExecutor } from "../../../domain/tools/index.js";
import type { ProcessTerminator, ProcessRecord } from "../../runtime-guard/index.js";
import {
  type LocalCommandProcessRegistry,
  type LocalWorkspaceCommandToolOptions,
} from "./local-workspace-command-tools.js";

export type LocalManagedProcessToolOptions = LocalWorkspaceCommandToolOptions & {
  readonly processTerminator?: ProcessTerminator;
};

export function createLocalManagedProcessTools(
  rootDirectory: string,
  options: LocalManagedProcessToolOptions = {},
): readonly ToolExecutor[] {
  return [
    createInspectProcessTool(rootDirectory, options.processRegistry),
    createStopProcessTool(rootDirectory, options.processRegistry, options.processTerminator),
  ];
}

function createInspectProcessTool(
  rootDirectory: string,
  processRegistry: LocalCommandProcessRegistry | undefined,
): ToolExecutor {
  return {
    definition: {
      name: "ProcessRead",
      description: "Inspect one managed workspace process by processId, or list managed processes in the current workspace.",
      metadata: {
        category: "terminal",
        riskLevel: "low",
        operationType: "read-only",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          processId: { type: "string", description: "Stable process identity returned by Shell with background=true." },
        },
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      if (processRegistry?.get === undefined || processRegistry.listAll === undefined) {
        throw new Error("process_inspect requires the Host process registry.");
      }
      const processId = stringValue(asRecord(input).processId);
      if (processId !== undefined) {
        const record = processRegistry.get(processId);
        if (record === undefined || !isVisibleProcess(rootDirectory, record, context)) {
          return { found: false, processId };
        }
        return { found: true, ...processFacts(record) };
      }
      const processes = processRegistry.listAll()
        .filter((record) => isVisibleProcess(rootDirectory, record, context))
        .map(processFacts);
      return { found: true, processes };
    },
  };
}

function createStopProcessTool(
  rootDirectory: string,
  processRegistry: LocalCommandProcessRegistry | undefined,
  processTerminator: ProcessTerminator | undefined,
): ToolExecutor {
  return {
    definition: {
      name: "ProcessStop",
      description: "Stop one owned managed workspace process by stable processId and return the observed termination result.",
      metadata: {
        category: "terminal",
        riskLevel: "medium",
        operationType: "execute",
        requiresConfirmation: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          processId: { type: "string", description: "Stable process identity returned by Shell with background=true." },
        },
        required: ["processId"],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      if (processRegistry?.get === undefined || processRegistry.stopOwned === undefined || processTerminator === undefined) {
        throw new Error("process_stop requires the Host process registry and process terminator.");
      }
      const processId = stringValue(asRecord(input).processId);
      if (processId === undefined) {
        throw new Error("process_stop processId must be a non-empty string.");
      }
      const record = processRegistry.get(processId);
      if (record === undefined || !isVisibleProcess(rootDirectory, record, context)) {
        return { processId, stopStatus: "not_found" };
      }
      const result = await processRegistry.stopOwned(processId, processTerminator);
      if (result.status === "not_found" || result.status === "not_owned") {
        return { processId, stopStatus: result.status };
      }
      if (result.status === "already_stopped") {
        return { processId, stopStatus: result.status, ...processFacts(result.process) };
      }
      if (result.status === "unknown" || result.status === "failed") {
        const error = new Error(`Could not confirm stopping managed process ${processId}.`);
        Object.assign(error, {
          code: result.status === "failed" ? "process_stop_failed" : "process_stop_unknown",
          facts: {
            processId,
            stopStatus: result.status,
            state: result.process.status,
            killTree: result.killTree,
          },
        });
        throw error;
      }
      return { processId, stopStatus: result.status, ...processFacts(result.process) };
    },
  };
}

function processFacts(record: ProcessRecord): Record<string, unknown> {
  return {
    processId: record.processId,
    state: record.status,
    lifetime: record.lifetime,
    ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
    ...(record.spaceId === undefined ? {} : { spaceId: record.spaceId }),
    ...(record.referenceId === undefined ? {} : { referenceId: record.referenceId }),
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.authorizationMode === undefined ? {} : { authorizationMode: record.authorizationMode }),
    ...(record.permissionState === undefined ? {} : { permissionState: record.permissionState }),
    ...(record.pid === undefined ? {} : { pid: record.pid }),
    commandLine: record.commandLine,
    cwd: record.cwd,
    startedAt: record.startedAt,
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.signal === undefined ? {} : { signal: record.signal }),
    ...(record.logRef === undefined ? {} : { logRef: record.logRef }),
    ...(record.logPath === undefined ? {} : { logPath: record.logPath }),
    ...(record.stopCommand === undefined ? {} : { stopCommand: record.stopCommand }),
    ports: record.ports,
    facts: record.facts,
  };
}

function isVisibleProcess(
  rootDirectory: string,
  record: ProcessRecord,
  context: ToolExecutionContext,
): boolean {
  if (context.conversationId !== undefined) {
    return record.conversationId === context.conversationId;
  }
  if (context.resourceScope?.ownerKind === "space") {
    return record.spaceId === context.resourceScope.ownerId;
  }
  return isInsideWorkspace(rootDirectory, record.cwd);
}

function isInsideWorkspace(rootDirectory: string, candidate: string): boolean {
  const root = path.resolve(rootDirectory);
  const relative = path.relative(root, path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}


function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}