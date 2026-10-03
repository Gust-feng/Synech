/** Shared maintenance budgets and retry policy. No model orchestration belongs here. */
export const MAINTENANCE_BATCH_TOKEN_BUDGET = 8_000;
export const MAINTENANCE_ADJACENT_TOKEN_BUDGET = 1_000;
export const MAINTENANCE_SUMMARY_TARGET_TOKENS = 1_200;
export const MAINTENANCE_SUMMARY_MAX_TOKENS = 3_000;
export const MAINTENANCE_MEMORY_TARGET_TOKENS = 3_000;
export const MAINTENANCE_MEMORY_MAX_TOKENS = 6_000;
/** 全文对照模式的证据总预算：不超过时优先从原文重新读取整段会话。 */
export const MAINTENANCE_FULL_CONVERSATION_TOKEN_BUDGET = 24_000;
/**
 * 后台请求输入容量硬顶（N04，实验参数）：系统提示 + 旧产物 + 证据 + 输出预留
 * 的总 token 计数不得超过该值；单轮超过剩余证据容量时按「片段」消费（进度
 * 精确到字符偏移，正式设计 §8.2）。
 */
export const MAINTENANCE_MAX_REQUEST_INPUT_TOKENS = 32_000;
/** 输出预留：双正文 + JSON 开销的输出预算（§13）。 */
export const MAINTENANCE_OUTPUT_RESERVE_TOKENS = 12_000;
/** 证据容量的最低可用值：低于该值视为配置/容量不足（§13「最低可处理单元」）。 */
export const MAINTENANCE_MIN_EVIDENCE_CAPACITY_TOKENS = 200;

/** 网络类失败的重试节奏（正式设计 §12：30s / 2min / 10min）。 */
export const MAINTENANCE_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
/** 每个输入快照的自动重试上限；新信号扩大边界时重置。 */
export const MAINTENANCE_MAX_ATTEMPTS = 3;

/** Finite continuation, shared by orchestration and the existing no-tools model adapter. */
export const MAINTENANCE_MAX_READ_ROUNDS = 2;
export const MAINTENANCE_MAX_READ_REQUESTS_PER_ROUND = 4;
export const MAINTENANCE_READ_TOKEN_BUDGET = 6_000;
export const MAINTENANCE_INITIAL_ENTRY_TOKEN_BUDGET = 4_000;
export const MAINTENANCE_MAX_ENTRY_MUTATIONS = 8;
export const MAINTENANCE_MAX_TOPICS = 32;
export const MAINTENANCE_MAX_NEW_TOPICS = 4;
export const MAINTENANCE_MAX_TOPIC_ALIASES = 4;
export const MAINTENANCE_MAX_OUTPUT_TOKENS = 12_000;
export const MAINTENANCE_MAX_LATENCY_MS = 120_000;
export const MAINTENANCE_MAX_TOTAL_REQUEST_TOKENS = 128_000;
export const MAINTENANCE_REQUEST_WRAPPER_RESERVE_TOKENS = 1_000;
