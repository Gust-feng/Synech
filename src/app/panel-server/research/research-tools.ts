import type { ToolExecutor } from "../../../domain/tools/index.js";
import type { ResearchFeature } from "../../research/index.js";
import type { ResearchApplication } from "../../application/research-application.js";
import type { AgentToolRegistryContribution } from "../../tool-center/factory.js";

/**
 * 深度研究的 Agent 工具：Pi 在对话里发起研究与读取进度。
 *
 * 与其它 Host 工具一致：工具只调用应用命令，业务规则不在工具里。
 * 发起研究是长任务且有额度副作用，因此需要用户确认（medium / execute）；
 * 读取进度是只读操作，不需要确认。
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
}): ToolExecutor {  return {
    definition: {
      name: "ResearchStart",
      description:
        "开始一次深度研究：拆解研究问题、多轮联网检索与正文取证，最终生成带来源引用的研究报告。研究在后台进行，立即返回研究任务标识；用 ResearchStatus 查看进度与结果。",
      metadata: {
        category: "research",
        riskLevel: "medium",
        operationType: "execute",
        requiresConfirmation: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            minLength: 1,
            maxLength: 2_000,
            description: "要研究的问题，写清范围与关注点。",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      const question = readQuestion(input);
      if (question === undefined) {
        return { status: "invalid_input", message: "研究问题需要 1 至 2000 字。" };
      }
      const readiness = await options.application.readiness();
      if (!readiness.search.available) {
        return {
          status: "unavailable",
          message: "尚未配置联网搜索服务，无法开始研究。",
        };
      }
      if (context.abortSignal?.aborted === true) {
        return { status: "cancelled", message: "研究请求已取消。" };
      }
      const started = await options.application.start({ question });
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

function readQuestion(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>).question;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2_000) return undefined;
  return trimmed;
}

function readTaskId(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>).taskId;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
