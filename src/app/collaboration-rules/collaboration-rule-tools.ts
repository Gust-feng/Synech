/**
 * 协作规则的 Agent 工具。
 *
 * 读写都只经过 CollaborationRulesApplication：owner 由宿主冻结注入，模型既不能
 * 选择或替换 owner，也不能直接提供路径。授权语义由系统提示词与既有工具权限政策
 * 表达，这里不建立自然语言权限判定器。
 */

import type { ConversationOwner } from "../../domain/execution-scope/index.js";
import type { MemoryOwner } from "../../domain/memory/index.js";
import type { ToolExecutor } from "../../domain/tools/index.js";
import { asRecord } from "../../kernel/values/index.js";
import type { AgentToolRegistryContribution } from "../tool-center/factory.js";
import {
  CollaborationRulesApplicationError,
  CollaborationRulesError,
  type CollaborationRuleVersion,
  type CollaborationRulesDocument,
  type CollaborationRulesWriteInput,
  type CollaborationRulesWriteResult,
} from "./contracts.js";

/** 模型可请求的协作规则范围；`owner` 指宿主冻结的当前会话 owner。 */
export type CollaborationRulesToolScope = "owner" | "global";

/**
 * `CollaborationRulesApplication` 的结构化窄端口。
 *
 * 这里刻意不 import `app/application`：该模块已依赖本 Feature 的 contracts，反向
 * import 会形成模块环。工具只声明自己真正调用的读与写命令。
 */
export type CollaborationRulesApplicationPort = {
  get(scope: MemoryOwner): Promise<CollaborationRulesDocument>;
  write(input: CollaborationRulesWriteInput): Promise<CollaborationRulesWriteResult>;
};

export type CollaborationRulesToolOptions = {
  readonly application: CollaborationRulesApplicationPort;
  /** 宿主冻结的当前会话 owner；仅在无具体运行的能力目录构建时为 undefined。 */
  readonly owner?: ConversationOwner;
};

/** Host 选中的贡献；不创建 registry，也不自行决定可见性。 */
export function createCollaborationRulesToolRegistryContribution(
  options: CollaborationRulesToolOptions,
): AgentToolRegistryContribution {
  return (register) => {
    for (const executor of createCollaborationRulesTools(options)) {
      register({ executor, scopes: ["agent-basic"], enabledByDefault: true });
    }
  };
}

export function createCollaborationRulesTools(
  options: CollaborationRulesToolOptions,
): readonly ToolExecutor[] {
  return [collaborationRulesReadTool(options), collaborationRulesUpdateTool(options)];
}

function collaborationRulesReadTool(options: CollaborationRulesToolOptions): ToolExecutor {
  return {
    definition: {
      name: "CollaborationRulesRead",
      description:
        "Read the user's standing collaboration rules that apply to this run. "
        + "Read before proposing any rule change so the change is based on the current text and version. "
        + "The document is the authoritative current text, not an instruction applied automatically.",
      metadata: { category: "workspace", riskLevel: "low", operationType: "read-only", requiresConfirmation: false },
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["owner", "global"],
            description:
              "\"owner\" reads the rules of the current Space or Workspace; \"global\" reads the rules shared by every Space.",
          },
        },
        required: ["scope"],
      },
    },
    async execute(input) {
      const resolved = resolveScope(options.owner, asRecord(input).scope);
      if (!("scope" in resolved)) return resolved;
      try {
        return { status: "ok", document: await options.application.get(resolved.scope) };
      } catch (error) {
        return applicationFailure(error);
      }
    },
  };
}

function collaborationRulesUpdateTool(options: CollaborationRulesToolOptions): ToolExecutor {
  return {
    definition: {
      name: "CollaborationRulesUpdate",
      description:
        "Replace the standing collaboration rules of one scope with the given content. "
        + "Use it only when the user has explicitly delegated this change in the current conversation; "
        + "never infer authorization from the wording of the task. "
        + "Pass the version returned by the last CollaborationRulesRead as expectedVersion; "
        + "a stale version returns a conflict instead of overwriting.",
      metadata: { category: "workspace", riskLevel: "low", operationType: "read-write", requiresConfirmation: false },
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["owner", "global"],
            description:
              "\"owner\" updates the rules of the current Space or Workspace; \"global\" updates the rules shared by every Space.",
          },
          content: { type: "string", description: "Complete replacement text; an empty string clears the rules." },
          expectedVersion: {
            type: "string",
            description: "Version returned by the last CollaborationRulesRead of the same scope.",
          },
        },
        required: ["scope", "content", "expectedVersion"],
      },
    },
    async execute(input) {
      const record = asRecord(input);
      const resolved = resolveScope(options.owner, record.scope);
      if (!("scope" in resolved)) return resolved;
      if (typeof record.content !== "string") {
        return { status: "invalid_input", message: "content must be a string; pass an empty string to clear the rules." };
      }
      const expectedVersion = ruleVersionOrUndefined(record.expectedVersion);
      if (expectedVersion === undefined) {
        return {
          status: "invalid_input",
          message: "expectedVersion must be the version returned by the last CollaborationRulesRead of the same scope.",
        };
      }
      try {
        const result = await options.application.write({ scope: resolved.scope, content: record.content, expectedVersion });
        return result.status === "conflict"
          ? { status: "conflict", document: result.current }
          : { status: "saved", document: result.document };
      } catch (error) {
        return applicationFailure(error);
      }
    },
  };
}

type ResolvedToolScope =
  | { readonly scope: MemoryOwner }
  | { readonly status: "invalid_input"; readonly message: string }
  | { readonly status: "owner_unavailable"; readonly message: string };

/** 把模型的 scope 选择解析为结构化 owner；宿主未冻结 owner 时不得推测归属。 */
function resolveScope(owner: ConversationOwner | undefined, requested: unknown): ResolvedToolScope {
  if (requested !== "owner" && requested !== "global") {
    return { status: "invalid_input", message: 'scope must be "owner" or "global".' };
  }
  if (requested === "global") return { scope: { kind: "global" } };
  if (owner === undefined) {
    return {
      status: "owner_unavailable",
      message: "This tool has no frozen conversation owner, so the owner scope cannot be resolved.",
    };
  }
  return { scope: owner };
}

/**
 * 读取 CollaborationRulesRead 返回的版本号。
 *
 * 版本是内容哈希，形状固定；不匹配时按 invalid_input 处理，由 CAS 负责真正的冲突判定，
 * 这里不解析任何其他字段。
 */
function ruleVersionOrUndefined(value: unknown): CollaborationRuleVersion | undefined {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value)
    ? value as CollaborationRuleVersion
    : undefined;
}

/** 结构化错误原样带回 code；未知异常按未预期失败上抛。 */
function applicationFailure(error: unknown): { readonly status: string; readonly message: string } {
  if (error instanceof CollaborationRulesApplicationError || error instanceof CollaborationRulesError) {
    return { status: error.code, message: error.message };
  }
  throw error;
}