import {
  RESEARCH_POLICY,
  type ResearchBrief,
  type ResearchCeilingKind,
  type ResearchCitationCheckDraft,
  type ResearchCitationVerdict,
  type ResearchFeature,
  type ResearchLedger,
} from "../research/index.js";
import {
  buildResearchCitationSample,
  buildResearchReportWritingPrompt,
  composeResearchReport,
  readResearchCitationSupportRate,
  toResearchReportSpanDrafts,
  type ResearchCitationSample,
  type ResearchCitationSampleItem,
  type ResearchCitationSupportRate,
  type ResearchCitationVerdictInput,
  type ResearchReportComposition,
  type ResearchReportDraft,
} from "../research/report/index.js";
import { readLatestResearchStopAssessment } from "../research/persistence-schema.js";
import { researchGateFailureCodes } from "./research-instrumentation.js";
import type {
  ResearchFinalizationOutcome,
  ResearchFinalizationPort,
  ResearchModelPort,
} from "./research-application.js";
import { classifyResearchModelFailure } from "./research-application.js";

/**
 * 成稿接线（S5w）：把 S4b 报告库接进 ResearchFinalizationPort 这个窄 seam。
 *
 * 顺序（设计草案 §8.4）：
 *   账本快照 → 成稿提示词（brief + Claim 图 + Evidence 卡 + Gap + Conflict + StopAssessment）
 *   → 模型一次调用 → composeResearchReport（解析 → 硬门 → 渲染）
 *   → 硬门通过才抽样核验（verifier 模型）；报告由应用层经 S1 finishTask 与终态同事务写入。
 *
 * 三条边界（本模块只做编排，不复制规则）：
 * 1. 报告规则只在报告库：提示词形状、span 契约、确定性硬门、抽样与支撑率计算都在
 *    `src/app/research/report/**`，本模块不内联第二套实现；
 * 2. 模型/provider 事实只在端口：配置类不可用如实返回 unavailable（应用层据此按
 *    research_model_unavailable 收敛，不烧额度），其余失败同样不伪造报告；
 * 3. 抽样不阻断发布（ADR §2.4）：verifier 失败时停止核验、照常成稿，已拿到的判定照常
 *    计算支撑率并落账——核验是测量，不是闸门。
 */

/** 成稿系统提示词：角色与输出契约一句话；提示词主体是报告库的写作提示词。 */
const REPORT_WRITING_SYSTEM = "你是深度研究报告的成稿员。只输出一个 JSON 对象。";
/** 核验系统提示词：verifier 只被允许回答一个五值枚举（设计草案 §10.2）。 */
const VERIFIER_SYSTEM = "你是引用支撑度核验器。只输出一个五值枚举词。";

/** verifier 五值枚举：入口归一化只做精确匹配，不做语义猜测。 */
const CITATION_VERDICTS: readonly ResearchCitationVerdict[] = [
  "supports",
  "partially_supports",
  "contradicts",
  "does_not_support",
  "insufficient_context",
];

export type ResearchFinalizationDependencies = {
  readonly feature: Pick<ResearchFeature, "commands" | "queries">;
  readonly model: ResearchModelPort;
  /** verifier 模型标识（用户可见面的溯源事实；解析不到时为 null，不猜）。 */
  readonly describeVerifierModel?: () => Promise<string | null>;
  /** 抽样问题数；缺省 RESEARCH_POLICY.citationSampleQuestionsPerTask。 */
  readonly questionsPerTask?: number;
  readonly onDiagnostic?: (topic: string, error: unknown) => void;
};

/** 一条待落账的抽样核验事实（span 序号 + claim + verifier 输入/输出/判定）。 */
type CitationVerificationEntry = {
  readonly spanOrdinal: number;
  readonly claimId: string;
  readonly verifierInput: string;
  /** verifier 原始输出：信任边界，原样留档（展示与诊断用）。 */
  readonly verifierOutput: string;
  /** 归一化后仍不是五值枚举时为 null：不落账，也不伪装成任何核验结论。 */
  readonly verdict: ResearchCitationVerdict | null;
};

/**
 * 一次抽样核验的全部事实（成稿时算出，报告写入后落账）。
 *
 * 为什么不直接在这里 appendCitationChecks：核验记录指向 reportSpanId，而报告与终态
 * 由 S1 finishTask 同事务写入（发生在本端口返回之后）。因此分两步：finalize 只做测量，
 * recordCitationChecks 在 span 存在后落账——顺序由应用层固定，端口不猜时序。
 */
type PendingCitationVerification = {
  readonly verifierModel: string | null;
  readonly entries: readonly CitationVerificationEntry[];
  readonly supportRate: ResearchCitationSupportRate;
};

export function createResearchFinalization(
  input: ResearchFinalizationDependencies,
): ResearchFinalizationPort {
  const feature = input.feature;
  const model = input.model;
  const onDiagnostic = input.onDiagnostic
    ?? ((topic: string, error: unknown) => console.error(`[research] ${topic}`, error));
  /** 每任务一份待落账核验事实：终态写入后由 recordCitationChecks 消费并清除。 */
  const pending = new Map<string, PendingCitationVerification>();

  async function composeWithModel(request: {
    readonly taskId: string;
    readonly ledger: ResearchLedger;
    readonly brief: ResearchBrief;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly status: "completed"; readonly composition: ResearchReportComposition }
    | { readonly status: "unavailable"; readonly reason: string }
  > {
    const prompt = buildResearchReportWritingPrompt(writingSpecOf(request.ledger, request.brief));
    for (let attempt = 1; ; attempt += 1) {
      const response = await model.complete({
        system: REPORT_WRITING_SYSTEM,
        user: prompt,
        format: "json_object",
        maxOutputTokens: RESEARCH_POLICY.reportModelMaxOutputTokens,
        timeoutMs: RESEARCH_POLICY.reportModelTimeoutMs,
        signal: request.signal,
      });
      if (response.status !== "completed") {
        // 配置类原因原样上交：应用层按 describeModelFailure 给出可执行的用户指引，
        // 不把「没配模型」说成「这次没成」。provider/传输类归一为 provider_unavailable，
        // 与 S4a 的终态语义同一口径（分类只有 research-application 一份实现）。
        const failure = classifyResearchModelFailure(response.reason);
        return {
          status: "unavailable",
          reason: failure === "provider" ? "provider_unavailable" : response.reason,
        };
      }
      const composition = composeResearchReport({
        ledger: request.ledger,
        modelOutput: readJsonEnvelope(response.text),
      });
      const parse = composition.parse;
      // 解析契约失败 = 模型这次没按输出契约回答，重试一次换调用；硬门失败不重试
      // （同一账本重发只会得到同样的发布判定）。
      if (parse.ok || attempt >= RESEARCH_POLICY.reportModelAttempts) {
        return { status: "completed", composition };
      }
      onDiagnostic(
        `research report output contract failed for ${request.taskId} (attempt ${attempt})`,
        new Error(parse.failures.map((failure) => `${failure.field}:${failure.code}`).join("; ")),
      );
    }
  }

  /** 抽样核验（默认每任务 1 个已覆盖问题）：测量，不阻断发布。 */
  async function runCitationSample(request: {
    readonly ledger: ResearchLedger;
    readonly composition: ResearchReportComposition;
    readonly signal: AbortSignal;
  }): Promise<PendingCitationVerification | undefined> {
    if (!request.composition.parse.ok) return undefined;
    const draft: ResearchReportDraft = request.composition.parse.draft;
    const sample: ResearchCitationSample = buildResearchCitationSample({
      ledger: request.ledger,
      draft,
      ...(input.questionsPerTask === undefined ? {} : { questionsPerTask: input.questionsPerTask }),
    });
    if (sample.items.length === 0) return undefined;

    const verifierModel = await describeVerifierModel();
    const entries: CitationVerificationEntry[] = [];
    const verdicts: ResearchCitationVerdictInput[] = [];
    for (const item of sample.items) {
      const response = await model.complete({
        system: VERIFIER_SYSTEM,
        user: item.verifierInput,
        format: "text",
        maxOutputTokens: RESEARCH_POLICY.verifierModelMaxOutputTokens,
        timeoutMs: RESEARCH_POLICY.verifierModelTimeoutMs,
        signal: request.signal,
      });
      if (response.status !== "completed") {
        // 抽样不可用不是发布闸门：停止核验，已拿到的判定照常算支撑率（sampled 变小
        // 是可见事实；总项数不进支撑率，也不进模型上下文）。
        break;
      }
      const verdict = readCitationVerdict(response.text);
      entries.push({
        spanOrdinal: item.spanOrdinal,
        claimId: item.claimId,
        verifierInput: item.verifierInput,
        verifierOutput: response.text.trim(),
        verdict,
      });
      verdicts.push({
        spanOrdinal: item.spanOrdinal,
        claimId: item.claimId,
        // 非枚举输出原样上交：报告库把它显式计入 rejected 桶。
        verdict: verdict ?? response.text.trim(),
      });
    }
    if (entries.length === 0) return undefined;
    return {
      verifierModel,
      entries,
      supportRate: readResearchCitationSupportRate({ sample, verdicts }),
    };
  }

  async function describeVerifierModel(): Promise<string | null> {
    if (input.describeVerifierModel === undefined) return null;
    try {
      return await input.describeVerifierModel();
    } catch (error) {
      // 模型标识只是溯源事实，取不到不影响核验本身。
      onDiagnostic("research verifier model label unresolved", error);
      return null;
    }
  }

  return {
    async finalize(request: {
      readonly taskId: string;
      readonly completion: "normal" | "forced";
      readonly ceilingHit: ResearchCeilingKind | null;
      readonly signal: AbortSignal;
    }): Promise<ResearchFinalizationOutcome> {
      // 成稿全程用同一份账本快照：提示词装配、硬门核验与渲染必须看到同一状态，
      // 否则渲染出的引用与核验通过的引用不是同一批。
      const ledger = await feature.queries.ledger(request.taskId);
      if (ledger === undefined) {
        return { status: "unavailable", reason: "task_not_found" };
      }
      if (ledger.brief === null) {
        // 未批准范围的任务根本不该进入执行（start 把范围批准与任务创建放同事务）；
        // 走到这里说明账本缺 brief，报告没有范围锚点，如实拒绝而不是写无锚点报告。
        return { status: "rejected", reason: "brief_not_recorded", failureCodes: ["brief_not_recorded"] };
      }

      const written = await composeWithModel({
        taskId: request.taskId,
        ledger,
        brief: ledger.brief,
        signal: request.signal,
      });
      if (written.status === "unavailable") return written;

      const composition = written.composition;
      if (!composition.ok) {
        // 硬门（零保留来源、引用不落 content hash、内部标识泄漏……含解析契约失败后的
        // 最终判定）不过即不出版：结构化失败码随 outcome 上交（reason 串与 codes
        // 数组同一处计算；应用层把 codes 落成用户可见的发布判定事件）。
        const failureCodes = researchGateFailureCodes(readGateFailureCodes(composition));
        return { status: "rejected", reason: failureCodes.join(","), failureCodes };
      }

      const verification = await runCitationSample({
        ledger,
        composition,
        signal: request.signal,
      });
      if (verification !== undefined) pending.set(request.taskId, verification);

      return {
        status: "completed",
        // 硬门通过 ⇒ 解析通过 ⇒ title 必为非空字符串（这里的兜底只为类型完备）。
        title: composition.title ?? "",
        spans: toResearchReportSpanDrafts(composition.spans),
      };
    },

    async recordCitationChecks(request: { readonly taskId: string }): Promise<void> {
      const verification = pending.get(request.taskId);
      if (verification === undefined) return;
      pending.delete(request.taskId);
      const ledger = await feature.queries.ledger(request.taskId);
      if (ledger === undefined || ledger.report === null) {
        onDiagnostic(
          `research citation checks dropped for ${request.taskId}`,
          new Error("报告尚未写入，核验记录无处挂靠。"),
        );
        return;
      }
      const spanByOrdinal = new Map(ledger.report.spans.map((span) => [span.ordinal, span]));
      const checks: ResearchCitationCheckDraft[] = [];
      for (const entry of verification.entries) {
        const span = spanByOrdinal.get(entry.spanOrdinal);
        // 无对应 span（报告形状与核验时不一致）或判定不是五值枚举：不落账。
        if (span === undefined || entry.verdict === null) continue;
        checks.push({
          reportSpanId: span.id,
          claimId: entry.claimId,
          verdict: entry.verdict,
          sampled: true,
          verifierInput: entry.verifierInput,
          verifierOutput: entry.verifierOutput,
          verifierModel: verification.verifierModel,
        });
      }
      if (checks.length === 0) return;
      try {
        await feature.commands.appendCitationChecks({ taskId: request.taskId, checks });
      } catch (error) {
        // 核验落账失败不改变已发布的报告；诊断保留原因（账本事实不丢）。
        onDiagnostic(`research citation checks failed for ${request.taskId}`, error);
        return;
      }
      await recordSupportRateEvent(request.taskId, verification.supportRate);
    },
  };

  /**
   * 抽样支撑率进用户可见面（ADR §2.4）：以账本变更事件落一条结构化记录。
   *
   * 支撑率的**唯一事实源**是刚落账的核验行（verdict 逐条可核），这里只是把派生量
   * 与它一起持久化：事件进入任务活动流，结构字段（sampled / supporting / supportRate）
   * 供读取方投影，展示层不得从文案反推数字。它**不进入模型上下文**——投影器只装配
   * 账本实体与 ResourceState，引用支撑率不在任何槽位里。
   */
  async function recordSupportRateEvent(taskId: string, rate: ResearchCitationSupportRate): Promise<void> {
    try {
      await feature.commands.appendActionEvents({
        taskId,
        events: [{
          kind: "ledger_change",
          payload: {
            version: 1,
            entity: "citation_check",
            change: "citation_support_rate",
            sampled: rate.sampled,
            supporting: rate.supports + rate.partiallySupports,
            rejected: rate.rejected,
            supportRate: rate.supportRate,
          },
        }],
      });
    } catch (error) {
      // 事件落账失败不改变核验记录本身；诊断保留原因。
      onDiagnostic(`research citation support rate event failed for ${taskId}`, error);
    }
  }
}

/** 成稿规格：报告库写作提示词的唯一输入来源（Gap/Conflict 与 Claim/Evidence 同级进入）。 */
function writingSpecOf(ledger: ResearchLedger, brief: ResearchBrief) {
  const stopAssessment = readLatestResearchStopAssessment(ledger.actionEvents);
  return {
    brief,
    questions: ledger.questions,
    claims: ledger.claims,
    evidence: ledger.evidence,
    gaps: ledger.gaps,
    conflicts: ledger.conflicts,
    stopAssessment: stopAssessment === null ? null : stopAssessment.payload,
  };
}

/** 硬门失败码（含零保留来源）：解析契约失败后的最终判定也归到结构化码，展示层不改写其语义。 */
function readGateFailureCodes(composition: ResearchReportComposition): readonly string[] {
  return composition.gate.ok ? [] : composition.gate.failures.map((failure) => failure.code);
}

/**
 * 模型输出 → JSON 信封。
 *
 * 输出契约（提示词给定、spans.ts 强制）要求裸 JSON 对象：围栏或额外文字属契约失败，
 * 由解析层判定并在成稿侧重试一次，不在这里替模型擦边界。
 */
function readJsonEnvelope(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * verifier 原始输出 → 五值枚举（信任边界归一化）。
 *
 * verifier 输出天然不可信：只做确定性归一化（去首尾引号/空白/收尾标点、小写化）后的
 * **精确匹配**；不匹配返回 null——由调用方原样上交，报告库把它显式计入 rejected 桶，
 * 不计入支撑率分子分母，也不伪装成 insufficient_context。
 */
function readCitationVerdict(output: string): ResearchCitationVerdict | null {
  const normalized = output
    .trim()
    .toLowerCase()
    .replace(/^[`"'“”‘’\s]+/u, "")
    .replace(/[`"'“”‘’\s。.，,！!？?；;]+$/u, "");
  return CITATION_VERDICTS.find((verdict) => verdict === normalized) ?? null;
}
