import type { ModelMessage, ModelUsage } from "../../domain/intelligence/index.js";
import { createStableInvocationId } from "../../kernel/id.js";
import type {
  AgentLoop,
  AgentLoopToolBoundary,
  ModelContentBlockEvent,
} from "../model-runtime/agent-loop.js";
import {
  RESEARCH_EXTERNAL_ACTION_CEILING,
  RESEARCH_POLICY,
  type ResearchActionEvent,
  type ResearchCeilingKind,
  type ResearchFeature,
  type ResearchLedger,
  type ResearchModelContentPayload,
  type ResearchResourceState,
  type ResearchResourceStateChangePayload,
  type ResearchResourceStateChangeReason,
  type ResearchReportSpanDraft,
  type ResearchScopeStartInput,
  type ResearchUsage,
} from "../research/index.js";
import {
  parseResearchFetchAttemptPayload,
  parseResearchSearchAttemptPayload,
  parseResearchStopAssessmentPayload,
} from "../research/persistence-schema.js";
import {
  RESEARCH_INITIAL_QUESTION_SCOPE_BASIS,
  assertResearchScope,
} from "../research/scope-gate.js";
import { projectResearchContext, type ResearchContextProjection } from "./research-context-projector.js";

/**
 * 深度研究编排（Application）：范围闸门 → turn 驱动的研究循环 → 成稿。
 *
 * 循环形态（ADR 0001 §2.3 / D7）：研究执行由本层驱动中性 AgentLoop 逐步进行。
 * 一次 `loop.execute` 是一个 turn，turn 内模型可多次工具调用，**turn 边界由模型自定**
 * （停止调用工具即让出）。应用层只做机械判定：
 * - propose_stop 已落账 → 成稿（completion=normal）；
 * - ResourceState=finalization_required（天花板到线）→ 强制收尾（completion=forced）；
 * - signal.aborted / cancel_requested → 中止收敛 cancelled；
 * - 否则装配下一轮。
 * 应用层不数轮次、不规定步骤内容、不复用 Ordinary 的 execution port / session writer。
 *
 * 与 Feature 的分工保持不变：Feature 只保存事实（账本、终态、事件），端口负责外部
 * 世界（本层的 turn 端口内部持有模型/检索/抓取与工具边界）。
 */

// ---------------------------------------------------------------------------
// 端口类型
//
// 检索/抓取/单 shot 模型端口类型保留在本模块：panel-server 的检索抓取适配器与辅助
// 模型通道从这里 import（类型归属保持稳定）；turn 驱动后检索与抓取经研究工具层执行，
// 单 shot 模型通道只服务其他辅助调用方。
// ---------------------------------------------------------------------------

export type ResearchModelPort = {
  /**
   * 结构化调用：失败返回 unavailable，不抛异常，由编排降级。
   *
   * `timeoutMs` 是**单次尝试**的超时，由适配器施加（它自己会重试传输类失败，
   * 每次尝试都要有独立的超时预算）。编排不再另加一层超时——两层用同一个值时，
   * 外层会在内层重试之前就把请求掐断。
   */
  complete(input: {
    readonly system: string;
    readonly user: string;
    readonly format: "json_object" | "text";
    readonly maxOutputTokens: number;
    readonly timeoutMs: number;
    /** 外层取消（任务被停止）；不是超时。 */
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly status: "completed";
        readonly text: string;
        readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null };
      }
    | { readonly status: "unavailable"; readonly reason: string }
  >;
};

export type ResearchSearchPort = {
  /** 一次联网检索；失败返回 failed，不抛异常。 */
  search(input: {
    readonly query: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly status: "completed";
        readonly results: readonly {
          readonly title: string;
          readonly url: string;
          readonly snippet: string;
          readonly publishedAt?: string;
        }[];
      }
    | { readonly status: "failed"; readonly code: string }
  >;
};

export type ResearchContentPort = {
  /** 抓取网页正文；失败返回 failed，由编排退化为摘要证据。 */
  fetch(input: {
    readonly url: string;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly status: "completed"; readonly text: string }
    | { readonly status: "failed"; readonly code: string }
  >;
};

/**
 * 一个 turn 的执行回路打开结果。
 *
 * `ready`：新 Session（账本恢复语义，不重放 transcript）+ 研究 scope 工具边界
 * （resourceScope 绑定 taskId，模型入参无法指定任务）。loop 只承担一个 execute，
 * 调用方负责 release。
 * `unavailable`：模型配置类不可用——应用层立即如实收敛，不烧任何检索/抓取额度。
 */
export type ResearchTurnOpening =
  | {
      readonly status: "ready";
      readonly loop: AgentLoop;
      readonly tools: AgentLoopToolBoundary;
    }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * turn 执行端口（组合根装配）。研究复用中性 loop，不复用 Ordinary 执行端口
 * （ADR §2.3）：Session、provider binding 与工具中心都是研究自己的。
 */
export type ResearchTurnPort = {
  openTurn(input: {
    readonly taskId: string;
    readonly signal: AbortSignal;
  }): Promise<ResearchTurnOpening>;
};

/**
 * 成稿端口（窄 seam，S5w 接线点）。
 *
 * propose_stop 已落账或天花板到线后进入成稿：报告库（`src/app/research/report/**`）
 * 经此端口接入。本层不内联第二套报告实现——报告提示词、span 解析、确定性渲染与
 * 硬门都归报告库；未接线前组合根提供如实「不可用」的承接实现。
 */
export type ResearchFinalizationOutcome =
  | {
      readonly status: "completed";
      readonly title: string;
      readonly spans: readonly ResearchReportSpanDraft[];
    }
  /** 确定性硬门拒绝：不得发布（研究事实已全部落账，账本不丢）。 */
  | { readonly status: "rejected"; readonly reason: string }
  /** 模型/provider 不可用，无法保证成稿调用（ADR §11.2）。 */
  | { readonly status: "unavailable"; readonly reason: string };

export type ResearchFinalizationPort = {
  finalize(input: {
    readonly taskId: string;
    readonly completion: "normal" | "forced";
    readonly ceilingHit: ResearchCeilingKind | null;
    readonly signal: AbortSignal;
  }): Promise<ResearchFinalizationOutcome>;
};

export type ResearchReadiness = {
  readonly search: { readonly available: boolean; readonly reason?: string };
};

export type ResearchApplicationDependencies = {
  readonly feature: Pick<ResearchFeature, "commands" | "queries"> & {
    readonly cancel: ResearchFeature["cancel"];
  };
  readonly turns: ResearchTurnPort;
  readonly finalization: ResearchFinalizationPort;
  /** 检索可用性：未配置搜索服务时如实不可用，不用空结果冒充成功。 */
  readonly readiness: () => Promise<ResearchReadiness>;
  readonly now?: () => number;
  readonly onDiagnostic?: (topic: string, error: unknown) => void;
};

export type ResearchApplication = {
  /**
   * 启动一次深度研究：结构化 scope payload 进，`{taskId}` 出。
   *
   * 唯一入口（ADR 0001 §2.2）：用户经范围卡点击、Agent 工具、Panel HTTP 三个
   * 调用方都走这一个命令，入口唯一性与范围门不变量只在这里实现一次。
   * 内部顺序固定：结构校验门 → createTask → approveScope → appendQuestions。
   * 无 approval 不得创建任务，不存在免确认路径。
   */
  start(input: ResearchScopeStartInput): Promise<{ readonly taskId: string }>;
  /** 执行一项已领取的任务；signal 由 worker 提供，取消时中止在途调用。 */
  execute(taskId: string, signal: AbortSignal): Promise<void>;
  cancel(taskId: string): Promise<{ readonly cancelled: boolean; readonly reason?: string }>;
  readiness(): Promise<ResearchReadiness>;
};

export function createResearchApplication(input: ResearchApplicationDependencies): ResearchApplication {
  const now = input.now ?? Date.now;
  const onDiagnostic = input.onDiagnostic ?? ((topic, error) => console.error(`[research] ${topic}`, error));

  return {
    async start(request) {
      // ---- 结构校验门：字段不齐即拒绝入队，未过门前不创建任何任务 ----
      const scope = assertResearchScope(request);

      const task = await input.feature.commands.createTask({ question: scope.brief.objective });
      try {
        // brief 与 scopeApproval 同事务（范围已批准即不可变）；初始问题树随任务落库。
        await input.feature.commands.approveScope({
          taskId: task.id,
          approval: scope.approval,
          brief: scope.brief,
        });
        await input.feature.commands.appendQuestions({
          taskId: task.id,
          questions: scope.questions.map((question) => ({
            text: question.text,
            priority: question.priority,
            boundaryNote: question.boundaryNote,
            origin: { kind: "brief", scopeBasis: RESEARCH_INITIAL_QUESTION_SCOPE_BASIS },
          })),
        });
      } catch (error) {
        // createTask 之后落账失败：不留一个「排队中但没有批准范围」的任务。
        await input.feature.commands.finishTask({
          id: task.id,
          status: "failed",
          errorCode: "research_scope_approval_failed",
          errorMessage: "研究范围未能落账，任务未入队执行。",
          usage: emptyTaskUsage(),
        }).catch(() => undefined);
        throw error;
      }
      return { taskId: task.id };
    },

    readiness: input.readiness,

    async cancel(taskId) {
      const detail = await input.feature.queries.detail(taskId);
      if (detail === undefined) return { cancelled: false, reason: "task_not_found" };
      const status = detail.task.status;
      if (status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted") {
        return { cancelled: false, reason: "already_terminal" };
      }
      await input.feature.cancel(taskId);
      return { cancelled: true };
    },

    async execute(taskId, signal) {
      await runResearchTurns({
        taskId,
        signal,
        startedAt: now(),
        dependencies: input,
        now,
        onDiagnostic,
      });
    },
  };
}

type ResearchTurnRun = {
  readonly taskId: string;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  readonly dependencies: ResearchApplicationDependencies;
  readonly now: () => number;
  readonly onDiagnostic: (topic: string, error: unknown) => void;
};

type ResearchTurnResult =
  | { readonly status: "completed"; readonly usage: ModelUsage }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: string; readonly errorCode?: string };

/**
 * 可逆 seam（ADR 0001 §2.3 点名 / D7）：逐步驱动形态。
 *
 * 实体、工具与状态机在「逐步驱动」与「长 loop + compaction」两种形态下相同；
 * 若 Phase 4 实测不支持逐步驱动，只替换本函数。每个 turn 结束时的账本即恢复点：
 * 进程在 turn 之间死亡 = 任务留 running，下次启动只标记 interrupted、绝不自动重放。
 */
async function runResearchTurns(run: ResearchTurnRun): Promise<void> {
  const { dependencies, taskId, signal } = run;
  const feature = dependencies.feature;
  const elapsed = (): number => Math.max(0, run.now() - run.startedAt);

  let modelRequests = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  /** 用量快照：模型计数跨 turn 累计；检索/抓取计数从账本动作事件派生（执行事实的唯一来源）。 */
  const snapshotUsage = async (): Promise<ResearchUsage> => {
    const ledger = await feature.queries.ledger(taskId);
    const actions = ledger === undefined ? { search: 0, fetch: 0 } : externalActionCounts(ledger.actionEvents);
    return {
      searchRequests: actions.search,
      fetchRequests: actions.fetch,
      modelRequests,
      inputTokens,
      outputTokens,
      elapsedMs: elapsed(),
    };
  };

  const finishTask = async (
    settle: Omit<Parameters<ResearchFeature["commands"]["finishTask"]>[0], "usage">,
  ): Promise<void> => {
    await feature.commands.finishTask({ ...settle, usage: await snapshotUsage() })
      .catch(() => undefined);
  };

  const finishCancelled = async (): Promise<void> => {
    await finishTask({
      id: taskId,
      status: "cancelled",
      errorCode: "research_cancelled",
      errorMessage: "研究已停止。",
    });
  };

  /** 配置类失败：模型不是「这次没成」而是「根本没配好」。立即如实收敛，不烧额度。 */
  const finishModelUnavailable = async (reason: string): Promise<void> => {
    await finishTask({
      id: taskId,
      status: "failed",
      errorCode: "research_model_unavailable",
      errorMessage: describeModelFailure(reason),
    });
  };

  const isCancelled = async (): Promise<boolean> =>
    signal.aborted || await feature.queries.isCancelRequested(taskId);

  /** 强制收尾：天花板到线，禁止新的外部调查；completion=forced + 缺口随账本呈现。 */
  const finalizeForced = async (ceilingHit: ResearchCeilingKind): Promise<void> => {
    await runFinalization("forced", ceilingHit);
  };

  const runFinalization = async (
    completion: "normal" | "forced",
    ceilingHit: ResearchCeilingKind | null,
  ): Promise<void> => {
    const outcome = await dependencies.finalization.finalize({
      taskId,
      completion,
      ceilingHit,
      signal,
    });
    if (outcome.status === "completed") {
      await finishTask({
        id: taskId,
        status: "completed",
        completion,
        ...(ceilingHit === null ? {} : { ceilingHit }),
        report: { title: outcome.title, spans: outcome.spans },
      });
      return;
    }
    if (outcome.status === "rejected") {
      await finishTask({
        id: taskId,
        status: "failed",
        errorCode: "research_report_gate_rejected",
        errorMessage: `报告未通过确定性硬门：${outcome.reason}`,
        completion: "incomplete",
        reason: "report_gate_rejected",
      });
      return;
    }
    await finishTask({
      id: taskId,
      status: "failed",
      errorCode: "research_finalization_unavailable",
      errorMessage: finalizationUnavailableMessage(outcome.reason),
      completion: "incomplete",
      reason: outcome.reason,
    });
  };

  let resourceState: ResearchResourceState | null = null;
  let consecutiveNoProgress = 0;
  let signature = "";

  try {
    const initialLedger = await feature.queries.ledger(taskId);
    if (initialLedger === undefined) {
      await finishTask({
        id: taskId,
        status: "failed",
        errorCode: "research_task_not_found",
        errorMessage: "研究任务不存在，无法执行。",
      });
      return;
    }
    signature = progressSignature(initialLedger);

    // ---- turn 循环：投影器装配 → 一个 turn → 机械判定 → 继续/收敛 ----
    while (true) {
      // 1. 取消检查：turn 边界读取（用户取消 = 中止，不是转向）。
      if (await isCancelled()) {
        await finishCancelled();
        return;
      }

      // 2. 账本快照与资源派生（每 turn 现读；ResourceState 转换落事件）。
      const ledger = await feature.queries.ledger(taskId);
      if (ledger === undefined) {
        await finishTask({
          id: taskId,
          status: "failed",
          errorCode: "research_task_not_found",
          errorMessage: "研究任务不存在，无法执行。",
        });
        return;
      }
      const derived = deriveResourceState({
        elapsedMs: elapsed(),
        ...externalActionCounts(ledger.actionEvents),
        consecutiveNoProgress,
      });
      if (derived.resourceState !== resourceState) {
        await feature.commands.appendActionEvents({
          taskId,
          events: [{
            kind: "resource_state_change",
            payload: resourceStateChangePayload({
              from: resourceState,
              to: derived.resourceState,
              reason: derived.reason,
              elapsedMs: elapsed(),
              consecutiveNoProgressCycles: consecutiveNoProgress,
            }),
          }],
        });
        resourceState = derived.resourceState;
      }

      // 3. 天花板到线：禁止新外部调查，强制收尾（三分停止之一，不与 propose_stop 互替）。
      if (derived.resourceState === "finalization_required") {
        await finalizeForced(derived.ceiling ?? "wall_clock");
        return;
      }

      // 4. 投影器装配：模型可见内容的唯一 owner（确定性 + 可复现）。
      const projection = projectResearchContext({ ledger, resourceState: derived.resourceState });

      // 5. 一个 turn：新 Session + provider binding；配置类不可用立即收敛。
      const opening = await dependencies.turns.openTurn({ taskId, signal });
      if (opening.status === "unavailable") {
        await finishModelUnavailable(opening.reason);
        return;
      }
      const turnResult = await executeResearchTurn({
        run,
        opening,
        projection,
        onModelUsage: (usage) => {
          modelRequests += usage.requestCount ?? 0;
          inputTokens = addTokens(inputTokens, usage.inputTokens ?? null);
          outputTokens = addTokens(outputTokens, usage.outputTokens ?? null);
        },
      });
      await feature.commands.updateProgress({ id: taskId, usage: await snapshotUsage() });

      // 6. turn 结果机械判定。
      if (turnResult.status === "cancelled" || await isCancelled()) {
        await finishCancelled();
        return;
      }
      if (turnResult.status === "failed") {
        if (isProviderFailureCode(turnResult.errorCode)) {
          await finishTask({
            id: taskId,
            status: "failed",
            errorCode: "research_provider_unavailable",
            errorMessage: finalizationUnavailableMessage("provider_unavailable"),
            completion: "incomplete",
            reason: "provider_unavailable",
          });
          return;
        }
        await finishTask({
          id: taskId,
          status: "failed",
          errorCode: "research_turn_failed",
          errorMessage: `研究回合未能完成：${turnResult.errorCode ?? "agent_loop_failed"}：${turnResult.error}`,
        });
        return;
      }

      // 7. propose_stop 已落账 → 成稿（completion=normal；未到线就没有 forced）。
      const afterTurn = await feature.queries.ledger(taskId);
      if (afterTurn !== undefined && hasRecordedStopAssessment(afterTurn.actionEvents)) {
        await runFinalization("normal", null);
        return;
      }

      // 8. 无进展周期：从账本状态派生（不落库）；达到上限由下一轮顶部的天花板派生消费。
      const nextSignature = afterTurn === undefined ? signature : progressSignature(afterTurn);
      consecutiveNoProgress = nextSignature === signature ? consecutiveNoProgress + 1 : 0;
      signature = nextSignature;
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      await finishCancelled();
      return;
    }
    run.onDiagnostic(`research task ${taskId} failed`, error);
    await finishTask({
      id: taskId,
      status: "failed",
      errorCode: "research_failed",
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : "研究执行失败。",
    });
  }
}

/** 驱动一个 turn：新 Session 上的机械 model-tool-model 循环；usage 与内容块经回调交还。 */
async function executeResearchTurn(input: {
  readonly run: ResearchTurnRun;
  readonly opening: Extract<ResearchTurnOpening, { readonly status: "ready" }>;
  readonly projection: ResearchContextProjection;
  readonly onModelUsage: (usage: ModelUsage) => void;
}): Promise<ResearchTurnResult> {
  const { run, opening } = input;
  const blocks: { contentIndex: number; kind: "text" | "thinking"; content: string }[] = [];
  let reasoningAvailable = false;
  let result: Awaited<ReturnType<AgentLoop["execute"]>>;
  try {
    result = await opening.loop.execute({
      instructions: input.projection.instructions,
      messages: [{ role: "user", content: input.projection.stateMessage } satisfies ModelMessage],
      tools: opening.tools,
      abortSignal: run.signal,
      // 研究自己的调用身份绑定表：每 turn 新建，不持久化（Session 本就是每 turn 新的）。
      acceptToolInvocations: async (calls) => calls.map((call) => ({
        ...call,
        invocationId: createStableInvocationId({
          runId: `research:${run.taskId}`,
          roundId: call.roundId,
          providerCallId: call.providerCallId,
        }),
      })),
      acceptNestedToolInvocations: async (calls) => calls.map((call) => {
        const parentInvocationId = call.parentInvocationId;
        if (parentInvocationId === undefined) {
          throw new Error("研究 loop 收到没有父调用的嵌套工具批次。");
        }
        return {
          ...call,
          invocationId: createStableInvocationId({
            runId: `research:${run.taskId}`,
            roundId: call.roundId,
            parentInvocationId,
            providerCallId: call.providerCallId,
          }),
        };
      }),
      // 模型内容块落账（ADR §2.6）：只记 completed 块；推理内容仅在端点返回时捕获。
      onModelContent: (event: ModelContentBlockEvent) => {
        if (event.phase !== "completed") return;
        if (event.kind === "thinking") reasoningAvailable = true;
        blocks.push({ contentIndex: event.contentIndex, kind: event.kind, content: event.content });
      },
    });
  } finally {
    await opening.loop.release().catch((error) => {
      input.run.onDiagnostic(`research turn loop release failed for ${run.taskId}`, error);
    });
  }
  input.onModelUsage(result.usage);

  if (blocks.length > 0) {
    await run.dependencies.feature.commands.appendActionEvents({
      taskId: run.taskId,
      events: [{
        kind: "model_content",
        payload: {
          version: 1,
          blocks,
          reasoningAvailable,
        } satisfies ResearchModelContentPayload,
      }],
    }).catch((error) => {
      // 观察面落账失败不改变 turn 结果；诊断保留原因。
      run.onDiagnostic(`research model_content event failed for ${run.taskId}`, error);
    });
  }

  if (result.status === "cancelled" || run.signal.aborted) return { status: "cancelled" };
  if (result.status === "approval_required") {
    // 研究 loop 的工具全部免确认；出现确认请求说明装配越界，如实失败而不是挂起。
    return {
      status: "failed",
      error: "研究 loop 出现未预期的工具确认请求。",
      errorCode: "research_unexpected_approval",
    };
  }
  if (result.status === "failed") {
    return { status: "failed", error: result.error, ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }) };
  }
  return { status: "completed", usage: result.usage };
}

// ---------------------------------------------------------------------------
// 运行事实派生（全部从账本现读；不落库、不持有第二份状态）
// ---------------------------------------------------------------------------

/** ResourceState 与天花板派生（ADR §2.4）：墙钟 reserve、外部动作总数、连续无进展。 */
function deriveResourceState(input: {
  readonly elapsedMs: number;
  readonly search: number;
  readonly fetch: number;
  readonly consecutiveNoProgress: number;
}): {
  readonly resourceState: ResearchResourceState;
  readonly ceiling: ResearchCeilingKind | null;
  readonly reason: ResearchResourceStateChangeReason;
} {
  const budget = RESEARCH_POLICY.totalBudgetMs;
  const reserveMs = budget * RESEARCH_POLICY.finalizationReserveRatio;
  if (input.elapsedMs >= budget - reserveMs) {
    return { resourceState: "finalization_required", ceiling: "wall_clock", reason: "wall_clock_reserve" };
  }
  if (input.search + input.fetch >= RESEARCH_EXTERNAL_ACTION_CEILING) {
    return { resourceState: "finalization_required", ceiling: "external_actions", reason: "external_actions_ceiling" };
  }
  if (input.consecutiveNoProgress >= RESEARCH_POLICY.maxNoProgressCycles) {
    return { resourceState: "finalization_required", ceiling: "no_progress", reason: "no_progress_ceiling" };
  }
  if (input.elapsedMs >= budget * RESEARCH_POLICY.constrainedWallClockRatio) {
    return { resourceState: "constrained", ceiling: null, reason: "wall_clock_constrained" };
  }
  return { resourceState: "normal", ceiling: null, reason: "initial" };
}

function resourceStateChangePayload(input: {
  readonly from: ResearchResourceState | null;
  readonly to: ResearchResourceState;
  readonly reason: ResearchResourceStateChangeReason;
  readonly elapsedMs: number;
  readonly consecutiveNoProgressCycles: number;
}): ResearchResourceStateChangePayload {
  return {
    version: 1,
    from: input.from,
    to: input.to,
    reason: input.reason,
    elapsedMs: input.elapsedMs,
    consecutiveNoProgressCycles: input.consecutiveNoProgressCycles,
  };
}

/**
 * 已真正发出的外部动作次数：重复跳过与策略上界不烧外部调用，也不计入
 * （与工具层的判定同一口径，从动作事件派生）。
 */
function externalActionCounts(events: readonly ResearchActionEvent[]): { readonly search: number; readonly fetch: number } {
  let search = 0;
  let fetch = 0;
  for (const event of events) {
    if (event.kind !== "tool_call") continue;
    const tool = event.payload.tool;
    if (tool === "research_search") {
      try {
        if (parseResearchSearchAttemptPayload(event.payload).executed) search += 1;
      } catch { /* 非本形状的事件不计入 */ }
    } else if (tool === "research_fetch") {
      try {
        if (parseResearchFetchAttemptPayload(event.payload).executed) fetch += 1;
      } catch { /* 非本形状的事件不计入 */ }
    }
  }
  return { search, fetch };
}

/** propose_stop 是否已落账（工具只在校验通过后写 tool_result 事件）。 */
function hasRecordedStopAssessment(events: readonly ResearchActionEvent[]): boolean {
  for (const event of events) {
    if (event.kind !== "tool_result" || event.payload.tool !== "research_propose_stop") continue;
    try {
      parseResearchStopAssessmentPayload(event.payload);
      return true;
    } catch { /* 形状不符的事件不构成停止提议 */ }
  }
  return false;
}

/**
 * 进展签名：账本实体的确定性摘要。相邻两个 turn 签名不变 = 这一轮没有产生任何
 * 持久研究进展（无推进/无声/无记忆），计入一次无进展周期。
 */
function progressSignature(ledger: ResearchLedger): string {
  const investigated = ledger.questions.filter((question) => question.status !== "open").length;
  return [
    ledger.questions.length,
    investigated,
    ledger.sources.length,
    ledger.evidence.length,
    ledger.claims.length,
    ledger.gaps.length,
    ledger.conflicts.length,
  ].join(":");
}

/** loop 失败码中的 provider 类：按稳定 errorCode 分支，不按错误文案猜测。 */
function isProviderFailureCode(errorCode: string | undefined): boolean {
  if (errorCode === undefined) return false;
  return errorCode.startsWith("provider_") || errorCode === "context_overflow";
}

function finalizationUnavailableMessage(reason: string): string {
  if (reason === "provider_unavailable") {
    return "模型服务在成稿阶段不可用，研究账本已完整保存；请检查模型配置后重新研究。";
  }
  return `报告未能生成（${reason}），研究账本已完整保存。`;
}

function emptyUsage(): ResearchUsage {
  return {
    searchRequests: 0,
    fetchRequests: 0,
    modelRequests: 0,
    inputTokens: null,
    outputTokens: null,
    elapsedMs: 0,
  };
}

/** 启动期失败记账：还没有任何调用发生，额度如实为零。 */
function emptyTaskUsage(): ResearchUsage {
  return emptyUsage();
}

/**
 * 把模型端口返回的失败原因转成用户能照着做的说明。
 *
 * 配置类问题要指名缺什么（未配置模型 / 缺 API Key / 缺模型名），用户才知道去哪里补；
 * 其余（传输、上游 5xx 等）如实说明是暂时不可用并建议稍后重试——不要把临时故障
 * 说成配置问题，那会让人去改本来正确的配置。
 */
function describeModelFailure(reason: string): string {
  if (reason === "model_provider_not_configured") {
    return "尚未配置模型服务，无法开始研究。请在设置里选择模型服务后重试。";
  }
  if (reason === "model_provider_disabled") {
    return "当前模型服务已被停用，无法开始研究。请在设置里启用模型服务后重试。";
  }
  if (reason === "model_api_key_missing") {
    return "模型服务缺少 API Key，无法开始研究。请在设置里补全后重试。";
  }
  if (reason.startsWith("model_config_incomplete:")) {
    const detail = reason.slice("model_config_incomplete:".length).trim();
    return `模型配置不完整，无法开始研究：${detail}`;
  }
  return `模型服务暂时不可用（${reason}），请稍后重新研究。`;
}

function addTokens(current: number | null, value: number | null): number | null {
  if (value === null) return current;
  return (current ?? 0) + value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
