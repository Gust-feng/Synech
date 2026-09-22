import type { ToolExecutor } from "../../../domain/tools/index.js";
import type { ResearchFeature, ResearchScopeStartInput } from "../../research/index.js";
import { ResearchScopeGateError } from "../../research/scope-gate.js";
import type { ResearchApplication } from "../../application/research-application.js";
import type { AgentToolRegistryContribution } from "../../tool-center/factory.js";

/**
 * 深度研究的 Agent 工具：Pi 在对话里发起研究与读取进度。
 *
 * 与其它 Host 工具一致：工具只调用应用命令，业务规则不在工具里。
 * 发起研究是长任务且有额度副作用，且必须携带用户在范围卡上批准的结构化载荷
 * （ADR 0001 §2.2）：工具自己不编排、不补全字段、不提供免确认路径，
 * 结构缺口由范围门拒绝并把缺失字段清单带回对话侧。
 */

export type ResearchToolOptions = {
  readonly application: Pick<ResearchApplication, "start" | "readiness">;
  readonly feature: Pick<ResearchFeature, "queries">;
  /** 入队后唤醒执行 worker；工具本身不执行研究。 */
  readonly noteQueued: () => void;
};

export function createResearchToolRegistryContribution(
  options: ResearchToolOptions,
): AgentToolRegistryContribution {
  return (register) => {
    register({ executor: createResearchStartTool(options), scopes: ["agent-basic", "research"], enabledByDefault: true });
    register({ executor: createResearchStatusTool(options), scopes: ["agent-basic", "research"], enabledByDefault: true });
  };
}

export function createResearchStartTool(options: {
  readonly application: Pick<ResearchApplication, "start" | "readiness">;
  readonly noteQueued: () => void;
}): ToolExecutor {
  const startSchema = {
    type: "object",
    properties: {
      brief: {
        type: "object",
        description: "用户在范围卡上批准的研究范围（自然语言，不要替用户补齐）。",
        properties: {
          objective: { type: "string", minLength: 1, description: "研究目标：这次研究要回答什么。" },
          inclusions: { type: "array", items: { type: "string" }, description: "纳入范围。" },
          exclusions: { type: "array", items: { type: "string" }, description: "排除范围：明确不研究什么，至少一项。" },
          audience: { type: "string", minLength: 1, description: "受众与输出期待。" },
          answerCriteria: { type: "string", minLength: 1, description: "什么算答够了（自然语言，不拆清单）。" },
        },
        required: ["objective", "inclusions", "exclusions", "audience", "answerCriteria"],
        additionalProperties: false,
      },
      questions: {
        type: "array",
        description: "初始问题树：每个问题都要说明边界（查到哪里算查完）。",
        items: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, description: "子问题正文。" },
            priority: { type: "string", enum: ["critical", "normal", "optional"], description: "优先级。" },
            boundaryNote: { type: "string", minLength: 1, description: "这个问题的边界：查到哪里算查完。" },
          },
          required: ["text", "priority", "boundaryNote"],
          additionalProperties: false,
        },
      },
      approval: {
        type: "object",
        description: "用户批准事实：范围卡点击产生，不可由模型自行构造。",
        properties: {
          payloadHash: { type: "string", minLength: 1, description: "批准载荷的 sha256 摘要；省略时由框架计算。" },
          approvedAt: { type: "number", description: "批准时间（毫秒时间戳）。" },
          conversationRef: { type: "string", minLength: 1, description: "批准发生的会话引用。" },
        },
        required: ["approvedAt", "conversationRef"],
        additionalProperties: false,
      },
      scopeSearchDisclosure: {
        type: "object",
        description: "澄清期摘要级检索披露（可选）：次数必须在策略上限内。",
        properties: { snippetSearches: { type: "number", description: "澄清期执行的摘要级检索次数。" } },
        required: ["snippetSearches"],
        additionalProperties: false,
      },
    },
    required: ["brief", "questions", "approval"],
    additionalProperties: false,
  } as const;

  return {
    definition: {
      name: "ResearchStart",
      description:
        "开始一次深度研究：按用户在范围卡上批准的范围拆解问题、多轮联网检索与正文取证，最终生成带来源引用的研究报告。研究在后台进行，立即返回研究任务标识；用 ResearchStatus 查看进度与结果。入参必须是用户在范围卡上批准的结构化范围载荷；字段不齐时不要自行补齐，按返回的缺失字段清单向用户追问。",
      metadata: {
        category: "research",
        riskLevel: "medium",
        operationType: "execute",
        requiresConfirmation: true,
      },
      inputSchema: startSchema,
    },
    execute: async (input, context) => {
      if (context.abortSignal?.aborted === true) {
        return { status: "cancelled", message: "研究请求已取消。" };
      }
      const readiness = await options.application.readiness();
      if (!readiness.search.available) {
        return {
          status: "unavailable",
          message: "尚未配置联网搜索服务，无法开始研究。",
        };
      }
      let started: { readonly taskId: string };
      try {
        // 工具边界只有 unknown：真实结构校验由范围门在命令内完成（同一规则函数，
        // 与 HTTP 侧 zod 预检是同一条规则的两个边界，不在这里复制第二份）。
        started = await options.application.start(input as ResearchScopeStartInput);
      } catch (error) {
        if (error instanceof ResearchScopeGateError) {
          return {
            status: "invalid_input",
            code: error.code,
            missing: error.failures.map((failure) => ({
              field: failure.field,
              code: failure.code,
              message: failure.message,
            })),
            message: error.message,
          };
        }
        throw error;
      }
      options.noteQueued();
      return {
        status: "started",
        taskId: started.taskId,
        message: "研究已开始，可用 ResearchStatus 查看进度。",
      };
    },
  };
}

export function createResearchStatusTool(options: {
  readonly feature: Pick<ResearchFeature, "queries">;
}): ToolExecutor {
  return {
    definition: {
      name: "ResearchStatus",
      description:
        "读取研究任务的进度与结果：状态、阶段、研究计划、各子问题的取证状态、已收集来源与最终报告。不传 taskId 时列出最近的研究任务。",
      metadata: {
        category: "research",
        riskLevel: "low",
        operationType: "read-only",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: "ResearchStart 返回的研究任务标识；省略时列出最近的研究任务。",
          },
        },
        additionalProperties: false,
      },
    },
    execute: async (input) => {
      const taskId = readTaskId(input);
      if (taskId === undefined) {
        const tasks = await options.feature.queries.summaryList({ limit: 10 });
        return {
          status: "listed",
          tasks: tasks.map((task) => ({
            taskId: task.id,
            question: task.question,
            status: task.status,
            sourceCount: task.sourceCount,
            createdAt: new Date(task.createdAt).toISOString(),
          })),
        };
      }
      const detail = await options.feature.queries.detail(taskId);
      if (detail === undefined) {
        return { status: "not_found", message: `研究任务 ${taskId} 不存在。` };
      }
      const task = detail.task;
      const latestCoverage = task.coverage.at(-1);
      return {
        status: task.status,
        stage: task.stage,
        taskId: task.id,
        question: task.question,
        plan: task.plan === null
          ? null
          : {
              objective: task.plan.objective,
              questions: task.plan.questions.map((question) => ({
                id: question.id,
                text: question.text,
                priority: question.priority,
                coverage: latestCoverage?.answers.find((answer) => answer.questionId === question.id)?.coverage ?? null,
              })),
            },
        sources: detail.sources.map((source) => ({
          number: source.ordinal,
          title: source.title,
          url: source.url,
          hasContent: source.contentText !== null,
        })),
        reportTitle: task.reportTitle,
        reportMarkdown: task.reportMarkdown,
        errorCode: task.errorCode,
        errorMessage: task.errorMessage,
      };
    },
  };
}

function readTaskId(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>).taskId;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
