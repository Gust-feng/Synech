/**
 * 深度研究的有界参数唯一 owner：运行安全天花板、单次动作限制与工具契约。
 *
 * 研究是「一次请求内跑不完」的长任务。turn 驱动之后（ADR 0001 §2.3）不再有
 * 固定轮次与「每轮查什么」的研究策略限制（设计草案 §4.1：那些上限是预算代理，
 * 不是充分性度量，由模型按语义自行决定）；保留的是两类：
 *
 * 1. **运行安全天花板**（§4.3 / ADR §2.4）：墙钟、外部动作总数、连续无进展周期，
 *    叠加受保护的 finalization reserve。触发即禁止新的外部调查，进入强制收尾
 *    （completion=forced + 缺口清单），绝不静默截断；
 * 2. **单次动作限制**（§4.2）：一次检索拿多少条、一次抓取读多少字符、单次外部
 *    调用超时。它们是工具契约，不是研究深度上限。
 *
 * 报告子系统（`report/**`：渲染器/硬门/抽样/导出）的有界参数同属本文件：
 * 它们是同一类「框架政策，模型无权选择」的值，S7 收口时从
 * `report/contracts.ts` 原值并入（唯一 owner 不收窄也不架空）；首版保守值，
 * Phase 4 用本项目数据标定。
 *
 * constrained / finalization reserve 比例与无进展周期数均为首版保守值，
 * Phase 4 用本项目数据标定；精确余额永不进入模型上下文（ADR §2.4 / D5）。
 */

export const RESEARCH_POLICY = {
  /**
   * 范围卡 objective 的最小长度。
   *
   * 「目标非平凡」是结构校验门的一条（ADR 0001 §2.2）：短于此值视为没有写清研究目标。
   * 首版保守值，Phase 4 用本项目数据标定；语义充分性仍由用户在范围卡上判定，框架不判。
   */
  scopeObjectiveMinChars: 8,
  /** 拆题产出的子问题数上限（下限见 minQuestions）：范围结构门的界，不是研究深度上限。 */
  maxQuestions: 5,
  minQuestions: 3,

  /** 整项研究的检索次数上限（跨 turn 累计；执行层面同时是外部动作天花板的一部分）。 */
  maxSearchRequests: 12,
  /** 整项研究的正文抓取次数上限（跨 turn 累计）。 */
  maxFetchRequests: 12,
  /**
   * 单次检索返回的结果条数上限。
   *
   * 单次动作限制（设计草案 §4.2）是工具契约，不是研究深度上限：一次调用拿到多少条
   * 结果由检索服务与这里共同限定，模型无需也无法选择。
   */
  maxSearchResultsPerRequest: 8,
  /**
   * 读取投影里摘录与正文片段的最大长度。
   *
   * 完整正文只按 ID、有界地按需返回：超出部分给出截断事实，不把全量正文塞回模型
   * 上下文（设计草案 §7.3）。
   */
  readProjectionExcerptMaxChars: 1_200,

  /** 墙钟天花板：整项研究的总时间预算。 */
  totalBudgetMs: 15 * 60 * 1000,
  /**
   * constrained 的墙钟比例（首版保守值）：用时达到总预算的该比例后，投影器向模型
   * 给出 constrained 状态（只改行动优先级，不得用于判定 covered）。
   */
  constrainedWallClockRatio: 0.7,
  /**
   * 受保护的 finalization reserve 比例（首版保守值）：剩余时间低于该比例时不再
   * 开始新的外部调查，进入 finalization_required 并强制收尾。reserve 本身不参与
   * 研究，模型也只看到状态、看不到比例。
   */
  finalizationReserveRatio: 0.15,
  /** 连续无进展周期上限（首版保守值）：从账本状态派生，不落库。 */
  maxNoProgressCycles: 3,

  /** 单次检索与单次抓取的超时。 */
  perSearchTimeoutMs: 15_000,
  perFetchTimeoutMs: 20_000,
  /** 抓取正文进入工具返回与投影的截断长度。 */
  fetchContentChars: 8_000,

  /** 投影器槽位内单条文本（问题/主张/缺口等）的截断长度：有界装配，不无限塞上下文。 */
  projectionItemMaxChars: 600,

  /**
   * 报告成稿与抽样核验的单次模型调用预算（单次动作限制，不是研究深度上限）。
   *
   * 成稿是长输出：span 数、摘录引用与六节结构都计入 token；核验是短输出（一个
   * 五值枚举）。慢模型上成稿需要比核验宽得多的时间预算——两者分别设定，
   * 不共用「一次模型调用」这一个值。
   */
  reportModelMaxOutputTokens: 12_000,
  reportModelTimeoutMs: 420_000,
  verifierModelMaxOutputTokens: 512,
  verifierModelTimeoutMs: 120_000,
  /**
   * 语义抽样核验默认样本量：每任务抽验的已覆盖问题数（设计草案 §8.4）。
   *
   * 抽样是测量不是闸门：产出「本任务引用支撑率」展示给用户并作回归指标，
   * 不阻断发布（ADR §2.4 / D4）。
   */
  citationSampleQuestionsPerTask: 1,
  /** 单个 span 正文上限：防模型把整节压成一句或无限拉长。 */
  spanMaxChars: 4_000,
  /** 单篇报告 span 总数上限。 */
  maxSpans: 80,
  /** verifier 输入里单条证据摘录的截断长度（与读取投影同一量级）。 */
  verifierExcerptMaxChars: 1_200,
  /**
   * 内部标识泄漏判定的最小长度。
   *
   * 生产 ID 形如 `<prefix>-<uuid>`（约 40+ 字符）；短于该长度的字符串不视为可识别
   * 的内部标识，避免把普通词误判成泄漏。
   */
  internalIdMinChars: 8,
  /**
   * 成稿模型调用的尝试次数：1 次首试 + 1 次重试。
   *
   * 只在**输出契约失败**（JSON 信封/键名/枚举/六节缺失等解析层失败）时重试——
   * 那是模型这次没按契约回答，换一次调用通常就好。硬门失败（引用不落 content hash、
   * 内部标识泄漏、零保留来源）不重试：重发同样的账本会得到同样的发布判定。
   * 传输类失败的重试在 research-model 适配层，不在这里叠第二层。
   */
  reportModelAttempts: 2,

  /**
   * 传输抖动的重试：一次连接失败不该让整项研究在起步阶段就失败。
   * 只重试传输类失败（见 research-model 的判定），确定性的配置/鉴权问题不重试。
   * 这里是总尝试次数：1 次首试 + 1 次重试。每次尝试都计入 usage.modelRequests。
   *
   * 辅助单 shot 通道（Panel 设置等同链路）仍在用；研究 loop 的重试由 provider 层
   * 承担，应用层不再另加一轮 turn 重试。
   */
  modelMaxAttempts: 2,
  /** 重试前的等待：给瞬时故障一个恢复窗口，同时不至于让用户等太久。 */
  modelRetryBackoffMs: 1_500,
  /** 队列轮询间隔：worker 无到期任务时的唤醒周期（预留）。 */
  workerPollMs: 1_500,
} as const;

export type ResearchPolicy = typeof RESEARCH_POLICY;

/** 外部动作总数天花板：检索与抓取各自的有界次数之和（框架政策，模型只看状态）。 */
export const RESEARCH_EXTERNAL_ACTION_CEILING =
  RESEARCH_POLICY.maxSearchRequests + RESEARCH_POLICY.maxFetchRequests;
