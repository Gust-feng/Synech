import type {
  ResearchCoverageRound,
  ResearchFeature,
  ResearchPlan,
  ResearchSourceDraft,
  ResearchScopeStartInput,
  ResearchStage,
  ResearchUsage,
} from "../research/index.js";
import { RESEARCH_POLICY } from "../research/index.js";
import {
  RESEARCH_INITIAL_QUESTION_SCOPE_BASIS,
  assertResearchScope,
} from "../research/scope-gate.js";
import {
  buildCoveragePrompt,
  buildPlanPrompt,
  buildReportPrompt,
  parseJsonObject,
  readCoverageDraft,
  readPlanDraft,
  readReportMarkdown,
} from "./research-prompts.js";

/**
 * 深度研究编排（Application）：范围闸门 → 拆题 → 多轮检索取证 → 覆盖判断 → 成稿。
 *
 * 与其他 Application 一样，本层拥有输入校验、流程顺序、取消与错误传播；
 * Feature 只保存事实，端口负责外部世界（模型、检索、正文抓取）。
 *
 * 范围闸门（ADR 0001 §2.2）是启动的唯一入口：结构化 scope payload 通过结构完整性
 * 校验后才创建任务，并同批落账 brief + scopeApproval + 初始问题树。
 *
 * 有界与降级（不整单失败的阶梯）：
 * - 轮数、检索/抓取次数、来源条数与总时间都由 research-policy 限定；
 * - 拆题两次解析失败 → 退回单轮取证（用原问题检索一次）后成稿；
 * - 覆盖判断失败 → 保留已得资料照样成稿；
 * - 时间预算到点 → 用已有资料成稿；
 * - 单次检索或抓取失败 → 只记账，报告在「缺口与限制」中如实反映；
 * - 取消请求在步骤边界读取，取消后写入终态 cancelled，不产出报告。
 */

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

export type ResearchReadiness = {
  readonly search: { readonly available: boolean; readonly reason?: string };
};

export type ResearchApplicationDependencies = {
  readonly feature: Pick<ResearchFeature, "commands" | "queries"> & {
    readonly cancel: ResearchFeature["cancel"];
  };
  readonly model: ResearchModelPort;
  readonly search: ResearchSearchPort;
  readonly content: ResearchContentPort;
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
      const startedAt = now();
      const deadline = startedAt + RESEARCH_POLICY.totalBudgetMs;
      let usage: ResearchUsage = emptyUsage();
      const elapsed = (): number => Math.max(0, now() - startedAt);
      const snapshotUsage = (): ResearchUsage => ({ ...usage, elapsedMs: elapsed() });
      const remainingMs = (): number => deadline - now();

      const question = async (): Promise<string> =>
        (await input.feature.queries.detail(taskId))?.task.question ?? "";

      /** 取消与时间预算的统一检查点：每个步骤边界都过一遍。 */
      const checkStop = async (): Promise<"cancelled" | "time" | null> => {
        if (signal.aborted) return "cancelled";
        if (await input.feature.queries.isCancelRequested(taskId)) return "cancelled";
        if (remainingMs() <= RESEARCH_POLICY.synthesisReserveMs) return "time";
        return null;
      };

      const stage = async (next: ResearchStage): Promise<void> => {
        await input.feature.commands.updateProgress({ id: taskId, stage: next, usage: snapshotUsage() });
      };

      /**
       * 最近一次模型不可用的原因；null 表示最近一次调用成功。
       * 用于把「模型为什么没返回」如实带到失败原因里，而不是笼统说服务不可用。
       */
      let modelFailureReason: string | null = null;

      /** 模型调用：统一记账与超时；返回 undefined 表示本次调用不可用。 */
      const callModel = async (request: {
        readonly system: string;
        readonly user: string;
        readonly format: "json_object" | "text";
        readonly maxOutputTokens: number;
        readonly timeoutMs: number;
      }): Promise<string | undefined> => {
        // 超时由适配器按「单次尝试」施加（见 ResearchModelPort 注释）；这里只传外层取消信号。
        const response = await input.model.complete({ ...request, signal });
        usage = { ...usage, modelRequests: usage.modelRequests + 1 };
        if (response.status !== "completed") {
          modelFailureReason = response.reason;
          onDiagnostic(`model unavailable (${response.reason})`, new Error(response.reason));
          return undefined;
        }
        modelFailureReason = null;
        usage = {
          ...usage,
          inputTokens: addTokens(usage.inputTokens, response.usage.inputTokens),
          outputTokens: addTokens(usage.outputTokens, response.usage.outputTokens),
        };
        return response.text;
      };

      /**
       * 配置类失败：模型不是「这次没成」而是「根本没配好」。
       * 这类问题重试与降级都无意义（没有模型就写不出报告），且用户能直接修，
       * 因此立即如实收敛，不烧检索额度。
       * 其余失败（输出不合规、传输抖动）保持设计中的降级阶梯。
       */
      const isModelMisconfigured = (): boolean => {
        const reason = modelFailureReason;
        if (reason === null) return false;
        return reason === "model_provider_not_configured"
          || reason === "model_provider_disabled"
          || reason === "model_api_key_missing"
          || reason.startsWith("model_config_incomplete:");
      };

      /** 模型不可用时的失败收敛：报告只能由模型写，没有模型就没有必要烧检索额度。 */
      const finishModelUnavailable = async (): Promise<void> => {
        const reason = modelFailureReason ?? "unknown";
        await input.feature.commands.finishTask({
          id: taskId,
          status: "failed",
          errorCode: "research_model_unavailable",
          errorMessage: describeModelFailure(reason),
          usage: snapshotUsage(),
        }).catch(() => undefined);
      };

      try {
        const researchQuestion = await question();

        // ---- 拆题：两次尝试（含一次重试）；都失败则退回单轮取证 ----
        await stage("planning");
        let plan: ResearchPlan | null = null;
        const planPrompt = buildPlanPrompt(researchQuestion);
        for (let attempt = 0; attempt < 2 && plan === null; attempt += 1) {
          if (signal.aborted) break;
          const text = await callModel({
            system: "你是深度研究的拆题员，只输出符合要求的 JSON 对象。",
            user: planPrompt,
            format: "json_object",
            maxOutputTokens: RESEARCH_POLICY.planningMaxOutputTokens,
            timeoutMs: RESEARCH_POLICY.perModelTimeoutMs,
          });
          if (text === undefined) continue;
          const draft = parseJsonObject(text, readPlanDraft);
          if (draft !== undefined) plan = toPlan(draft);
        }
        // 拆题阶段模型就没配好：此时既没有计划也没有资料，继续检索只会白耗额度
        // （实测过：模型未配置时仍跑满 12 次检索，最后才失败）。直接如实收敛。
        // 只对配置类失败这样做：「模型返回了但不符合要求」仍按设计降级为单轮取证，
        // 那是输出质量问题，不是没法继续。
        if (plan === null && isModelMisconfigured()) {
          if (await checkStop() === "cancelled") {
            await finishCancelled();
            return;
          }
          await finishModelUnavailable();
          return;
        }
        if (plan !== null) await input.feature.commands.savePlan({ id: taskId, plan });

        // ---- 取证循环：有界轮数；取消或时间到点即转入成稿 ----
        await stage("searching");
        const coverage: ResearchCoverageRound[] = [];
        let nextQueries: Array<{ questionId: string; query: string }> = [];
        const maxRounds = plan === null ? 1 : RESEARCH_POLICY.maxRounds;
        for (let round = 1; round <= maxRounds; round += 1) {
          if (await checkStop() !== null) break;
          const queries = round === 1
            ? plan === null
              ? [{ questionId: "", query: researchQuestion }]
              : plan.questions.map((item) => ({ questionId: item.id, query: item.text }))
            : nextQueries;
          if (queries.length === 0) break;

          usage = await runSearchRound({
            taskId,
            round,
            queries,
            usage,
            feature: input.feature,
            search: input.search,
            signal,
            remainingMs,
            now,
            onDiagnostic,
          });

          if (await checkStop() !== null) break;
          await stage("reading");
          usage = await runFetchRound({
            taskId,
            usage,
            feature: input.feature,
            content: input.content,
            signal,
            remainingMs,
            onDiagnostic,
          });

          // 无计划（拆题降级）时没有子问题可判断，一轮取证后直接成稿。
          if (plan === null) break;
          if (await checkStop() !== null) break;

          await stage("analyzing");
          const collected = await input.feature.queries.detail(taskId);
          const coverageText = await callModel({
            system: "你是深度研究的取证判断员，只输出符合要求的 JSON 对象。",
            user: buildCoveragePrompt({
              question: researchQuestion,
              plan,
              sources: collected?.sources ?? [],
              round,
            }),
            format: "json_object",
            maxOutputTokens: RESEARCH_POLICY.planningMaxOutputTokens,
            timeoutMs: RESEARCH_POLICY.perModelTimeoutMs,
          });
          const knownIds = new Set(plan.questions.map((item) => item.id));
          const draft = coverageText === undefined
            ? undefined
            : parseJsonObject(coverageText, (value) => readCoverageDraft(value, knownIds));
          // 覆盖判断失败：保留已得资料照样成稿，不丢整轮取证。
          if (draft === undefined) break;
          coverage.push({ round, answers: draft.answers });
          await input.feature.commands.saveCoverage({ id: taskId, coverage });
          nextQueries = draft.nextQueries.map((item) => ({ questionId: item.questionId, query: item.query }));
          if (draft.stop) break;
        }

        // ---- 成稿：资料不足也照写，由「缺口与限制」如实说明 ----
        if (await checkStop() === "cancelled") {
          await finishCancelled();
          return;
        }
        const collected = await input.feature.queries.detail(taskId);
        const sources = collected?.sources ?? [];
        // 抓取留下的 pending 来源（预算用尽）按失败收敛，不留下悬空状态。
        for (const source of sources) {
          if (source.contentStatus !== "pending") continue;
          await input.feature.commands.markSourceContent({
            taskId, sourceId: source.id, status: "skipped", contentText: null,
          });
        }
        await stage("writing");
        const reportText = await callModel({
          system: "你是深度研究报告的撰写员，只输出 Markdown 正文。",
          user: buildReportPrompt({
            question: researchQuestion,
            plan: plan ?? fallbackPlan(researchQuestion),
            sources,
          }),
          format: "text",
          maxOutputTokens: RESEARCH_POLICY.reportMaxOutputTokens,
          // 成稿是长文，慢模型上需要比拆题宽得多的预算。
          timeoutMs: RESEARCH_POLICY.reportModelTimeoutMs,
        });
        const markdown = reportText === undefined ? undefined : readReportMarkdown(reportText);
        if (markdown === undefined) {
          // 区分两种失败：模型压根没返回（服务不可用），还是返回了但正文不合规。
          // 前者要用户检查模型配置或稍后重试，后者是输出质量问题——两者的处置完全不同。
          if (reportText === undefined) {
            await finishModelUnavailable();
            return;
          }
          await input.feature.commands.finishTask({
            id: taskId,
            status: "failed",
            errorCode: "research_report_invalid",
            errorMessage: "模型返回的报告缺少必需的小节，未能保存为研究报告。",
            usage: snapshotUsage(),
          });
          return;
        }
        await input.feature.commands.finishTask({
          id: taskId,
          status: "completed",
          reportTitle: reportTitleOf(researchQuestion),
          reportMarkdown: markdown,
          usage: snapshotUsage(),
        });
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          await finishCancelled();
          return;
        }
        onDiagnostic(`research task ${taskId} failed`, error);
        await input.feature.commands.finishTask({
          id: taskId,
          status: "failed",
          errorCode: "research_failed",
          errorMessage: error instanceof Error ? error.message.slice(0, 300) : "研究执行失败。",
          usage: snapshotUsage(),
        }).catch(() => undefined);
      }

      async function finishCancelled(): Promise<void> {
        await input.feature.commands.finishTask({
          id: taskId,
          status: "cancelled",
          errorCode: "research_cancelled",
          errorMessage: "研究已停止。",
          usage: snapshotUsage(),
        }).catch(() => undefined);
      }
    },
  };
}

/** 一轮检索：有界并发、逐次记账；失败只记录，不中断整项研究。 */
async function runSearchRound(args: {
  readonly taskId: string;
  readonly round: number;
  readonly queries: readonly { readonly questionId: string; readonly query: string }[];
  readonly usage: ResearchUsage;
  readonly feature: ResearchApplicationDependencies["feature"];
  readonly search: ResearchSearchPort;
  readonly signal: AbortSignal;
  readonly remainingMs: () => number;
  readonly now: () => number;
  readonly onDiagnostic: (topic: string, error: unknown) => void;
}): Promise<ResearchUsage> {
  const { taskId, round, queries, feature, search, signal, remainingMs, onDiagnostic } = args;
  let usage = args.usage;
  const records: Array<{
    readonly id: string;
    readonly round: number;
    readonly text: string;
    readonly status: "succeeded" | "failed";
    readonly resultCount: number;
    readonly createdAt: number;
  }> = [];
  // 已入列的来源条数：达到上限后本轮不再发起检索——继续检索只会拿到
  // 入不了列的结果，白耗检索额度与时间。
  let collectedSources = (await feature.queries.detail(taskId))?.sources.length ?? 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(RESEARCH_POLICY.searchConcurrency, queries.length) }, async () => {
    while (cursor < queries.length) {
      const item = queries[cursor];
      cursor += 1;
      if (item === undefined) continue;
      const query = item.query.trim();
      if (query.length === 0) continue;
      if (usage.searchRequests >= RESEARCH_POLICY.maxSearchRequests) break;
      if (collectedSources >= RESEARCH_POLICY.maxSources) break;
      if (signal.aborted || remainingMs() <= RESEARCH_POLICY.synthesisReserveMs) break;
      usage = { ...usage, searchRequests: usage.searchRequests + 1 };
      const createdAt = args.now();
      // 记录 id 必须带 taskId：research_query.id 是整张表的主键，而这里的轮次与
      // 检索计数器都是**任务内**的。只拼 `轮次-序号-查询词` 会让两个研究问同一个
      // 问题时产生同一个 id（先写入的那条成功，后一个任务整轮检索记录因主键冲突
      // 全部回滚）。取值范围与 research_source 的 `${taskId}:s${ordinal}` 一致。
      const recordId = `${taskId}:q${usage.searchRequests}`;
      const combined = AbortSignal.any([signal, AbortSignal.timeout(RESEARCH_POLICY.perSearchTimeoutMs)]);
      try {
        const result = await search.search({ query, limit: 6, signal: combined });
        if (result.status === "failed") {
          records.push({ id: recordId, round, text: query, status: "failed", resultCount: 0, createdAt });
          continue;
        }
        const drafts: ResearchSourceDraft[] = [];
        for (const entry of result.results) {
          const title = entry.title.trim();
          const url = entry.url.trim();
          const snippet = entry.snippet.trim();
          if (title.length === 0 || url.length === 0) continue;
          drafts.push({
            title,
            url,
            snippet,
            ...(entry.publishedAt === undefined ? {} : { publishedAt: entry.publishedAt }),
          });
        }
        // 编号由 Feature 按入列顺序分配；跨轮去重，重复结果不重复计数。
        // 上限由策略给出并在事务内执行：来源条数直接决定成稿提示词的体量，
        // 不设上限会让 12 次检索累积出几十条来源、把成稿拖成分钟级。
        const accepted = await feature.commands.appendSources({
          taskId,
          drafts,
          limit: RESEARCH_POLICY.maxSources,
        });
        collectedSources += accepted.length;
        records.push({ id: recordId, round, text: query, status: "succeeded", resultCount: accepted.length, createdAt });
      } catch (error) {
        onDiagnostic(`search failed for query ${query}`, error);
        records.push({ id: recordId, round, text: query, status: "failed", resultCount: 0, createdAt });
      }
    }
  });
  await Promise.all(workers);
  if (records.length > 0) {
    await feature.commands.appendQueries({ taskId, records });
  }
  return usage;
}

/** 一轮正文抓取：只处理 pending 来源；失败按 failed 收敛，证据退回摘要。 */
async function runFetchRound(args: {
  readonly taskId: string;
  readonly usage: ResearchUsage;
  readonly feature: ResearchApplicationDependencies["feature"];
  readonly content: ResearchContentPort;
  readonly signal: AbortSignal;
  readonly remainingMs: () => number;
  readonly onDiagnostic: (topic: string, error: unknown) => void;
}): Promise<ResearchUsage> {
  const { taskId, feature, content, signal, remainingMs, onDiagnostic } = args;
  let usage = args.usage;
  const collected = await feature.queries.detail(taskId);
  const pending = (collected?.sources ?? []).filter((source) => source.contentStatus === "pending");
  let cursor = 0;
  const workers = Array.from({ length: Math.min(RESEARCH_POLICY.fetchConcurrency, pending.length) }, async () => {
    while (cursor < pending.length) {
      const source = pending[cursor];
      cursor += 1;
      if (source === undefined) continue;
      if (usage.fetchRequests >= RESEARCH_POLICY.maxFetchRequests) break;
      if (signal.aborted || remainingMs() <= RESEARCH_POLICY.synthesisReserveMs) break;
      usage = { ...usage, fetchRequests: usage.fetchRequests + 1 };
      const combined = AbortSignal.any([signal, AbortSignal.timeout(RESEARCH_POLICY.perFetchTimeoutMs)]);
      try {
        const result = await content.fetch({ url: source.url, signal: combined });
        await feature.commands.markSourceContent({
          taskId,
          sourceId: source.id,
          status: result.status === "completed" ? "ready" : "failed",
          contentText: result.status === "completed" ? result.text.slice(0, RESEARCH_POLICY.fetchContentChars) : null,
        });
      } catch (error) {
        onDiagnostic(`content fetch failed for ${source.url}`, error);
        await feature.commands.markSourceContent({
          taskId, sourceId: source.id, status: "failed", contentText: null,
        }).catch(() => undefined);
      }
    }
  });
  await Promise.all(workers);
  return usage;
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

function toPlan(draft: {
  readonly objective: string;
  readonly questions: readonly { readonly text: string; readonly priority: "high" | "normal" }[];
}): ResearchPlan {
  return {
    objective: draft.objective,
    questions: draft.questions.map((item, index) => ({
      id: `q${index + 1}`,
      text: item.text,
      priority: item.priority,
    })),
  };
}

/** 拆题降级时的占位计划：只用于成稿提示词，不写回任务。 */
function fallbackPlan(question: string): ResearchPlan {
  return {
    objective: question,
    questions: [{ id: "q1", text: question, priority: "high" }],
  };
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

function reportTitleOf(question: string): string {
  const trimmed = question.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}

function addTokens(current: number | null, value: number | null): number | null {
  if (value === null) return current;
  return (current ?? 0) + value;
}

/**
 * 关于请求信号的实测备注，避免后人重复踩坑。
 *
 * 2026-09-19 曾观察到模型调用以 `Connection error` 失败，一度判断是
 * `AbortSignal.any([...])` 组合信号的问题。后续对照实验证伪了这个结论：
 * 同一台机器、同一份配置下，原生 fetch 用组合信号 12/12 成功，
 * 生产模型适配器用组合信号连续 8 次调用也全部成功；而当时的失败既出现在
 * 组合信号下、也出现在不传信号的对照下（首次调用失败、后续成功），
 * 是短时上游/网络抖动，不是写法差异。因此这里继续使用 `AbortSignal.any`。
 *
 * 真正需要防的是抖动的后果：适配层对传输类失败做了一次有界重试
 * （见 panel-server/research/research-model.ts）。不要再按「信号写法」
 * 去改这段代码，除非有可复现的对照证据。
 */

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
