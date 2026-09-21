/**
 * 深度研究的有界编排参数：轮数、额度、并发与超时的唯一 owner。
 *
 * 研究是「一次请求内跑不完」的长任务，全部上界必须在一个地方说清楚，
 * 否则单次研究可能无界地消耗额度。取值按本地长驻进程的实际情况放宽
 * （对照：托管函数形态只能给到分钟级），但仍保留总预算以便用户等待可控。
 */
export const RESEARCH_POLICY = {
  /** 最多轮数：1 轮初始取证 + 最多 2 轮补查。 */
  maxRounds: 3,
  /** 拆题产出的子问题数上限（下限见 minQuestions）。 */
  maxQuestions: 5,
  minQuestions: 3,
  /** 整项研究的检索次数上限（跨轮累计）。 */
  maxSearchRequests: 12,
  /** 整项研究的正文抓取次数上限（跨轮累计）。 */
  maxFetchRequests: 12,
  /** 最终可引用来源条数上限。 */
  maxSources: 24,
  /** 单轮补查的查询数上限。 */
  maxQueriesPerRound: 5,
  /** 总时间预算；到点后不再取证，直接用已有资料成稿。 */
  totalBudgetMs: 15 * 60 * 1000,
  /** 成稿预留：剩余时间低于该值时不再开始新一轮取证。 */
  synthesisReserveMs: 4 * 60 * 1000,
  /** 并发：检索与抓取各自的有界并发。 */
  searchConcurrency: 3,
  fetchConcurrency: 2,
  /** 单次检索与单次抓取的超时。 */
  perSearchTimeoutMs: 15_000,
  perFetchTimeoutMs: 20_000,
  /** 抓取正文进入提示词的截断长度。 */
  fetchContentChars: 8_000,
  /** 送进提示词的检索摘要截断长度。 */
  promptSnippetChars: 600,
  /** 成稿模型输出上限。 */
  reportMaxOutputTokens: 12_000,
  /** 拆题/判断模型输出上限：结构化 JSON，不需要长正文。 */
  planningMaxOutputTokens: 3_000,
  /** 拆题与覆盖判断的单次模型调用超时：结构化小输出，不需要太久。 */
  perModelTimeoutMs: 180_000,
  /**
   * 成稿的单次模型调用超时。
   *
   * 报告是多节长文（本策略允许 12000 输出 token），慢模型上远超拆题的耗时：
   * 实测某个预览模型光拆题就要 40–50 秒，成稿在 180 秒处被掐断，用户拿到的
   * 是「模型不可用」——但模型其实只是慢。给成稿单独放宽，且仍落在总预算内。
   */
  reportModelTimeoutMs: 420_000,
  /**
   * 传输抖动的重试：一次连接失败不该让整项研究在起步阶段就失败。
   * 只重试传输类失败（见 research-model 的判定），确定性的配置/鉴权问题不重试。
   * 这里是总尝试次数：1 次首试 + 1 次重试。每次尝试都计入 usage.modelRequests。
   */
  modelMaxAttempts: 2,
  /** 重试前的等待：给瞬时故障一个恢复窗口，同时不至于让用户等太久。 */
  modelRetryBackoffMs: 1_500,
  /** 队列轮询间隔：worker 无到期任务时的唤醒周期。 */
  workerPollMs: 1_500,
} as const;

export type ResearchPolicy = typeof RESEARCH_POLICY;
