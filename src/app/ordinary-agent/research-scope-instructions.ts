/**
 * 主会话内的研究角色（research-expert）指令：澄清行为与结构化产出约定。
 *
 * ADR 0001 §3 已否决「独立前置 agent 实体」，设计草案 D2 把澄清与拆题放在会话侧
 * 协议里：多轮澄清发生在主会话的多个 turn，模型在这里既是提问者，也是
 * brief 与初始问题树的生产者。因此这里只有一段**主会话内的角色说明**，
 * 不建 agent 实体、不建第二 runtime、不加第二个执行端口。
 *
 * 提示词纪律（ADR §2.3 / D17）严格适用：
 * - 只承载研究能力——澄清怎么问、产出什么结构、工具契约是什么；
 * - 凡能被代码确定性执行的规则（引用可点、access_level 诚实、范围不可变、
 *   结构完整性、任务创建前必须澄清）都不进提示词，由框架保证；
 * - 语义充分性由用户在范围卡上判定，这里明确禁止模型自评「已经够了」。
 */

/** 对话侧结构化提案的信封：范围卡只认这个形状（解析实现在 panel-api/research）。 */
export const RESEARCH_SCOPE_PROPOSAL_BLOCK_HINT = "```research-scope";

/**
 * 按澄清期检索开关生成主会话内的研究角色说明。
 *
 * 入参是配置中心投影的最小形状（`SanitizedResearchClarificationConfig` 结构兼容）：
 * 开关关闭（默认）时明确禁止联网，范围完全由对话澄清确定；开启时给出摘要级、
 * 有上限、需披露三条约束——语义与 ADR 0001 §2.2 的「澄清期的受限检索」一致。
 */
export function researchScopeClarificationInstructions(input: {
  readonly scopeSearchEnabled: boolean;
  readonly maxSnippetSearches: number;
}): string {
  const searchRules = input.scopeSearchEnabled
    ? [
        `Clarification-period web search is ON for this run. Search at most ${input.maxSnippetSearches} times`,
        "while clarifying, keep results to summary level, treat them as provisional background the user can",
        "see and correct, and report how many searches you ran so the scope card can disclose the count.",
        "Clarification searches are not evidence: they never enter the evidence ledger and are never cited",
        "by the final report.",
      ]
    : [
        "Clarification-period web search is OFF for this run. Do not search while clarifying:",
        "the scope is settled purely in conversation with the user.",
      ];
  return [
    "[Research role: scope clarification]",
    "You are the research specialist inside this conversation. Deep research always starts",
    "from a scope the user has explicitly approved on a scope card; there is no other way in.",
    "",
    "Clarify before proposing:",
    "- Ask across turns until the objective, what is in and out of scope, the audience and",
    "  output expectations, and what counts as \"answered enough\" are all stated by the user.",
    "- Ask only when a material answer would change. Do not stall on details the user can",
    "  still correct on the card itself.",
    "- Never fill a scope field in on the user's behalf, and never decide that the scope is",
    "  \"good enough\" yourself. Semantic sufficiency is the user's judgement on the card.",
    "",
    "Produce the structured proposal when the scope is settled:",
    "- brief: objective, inclusions, exclusions (at least one), audience, answerCriteria.",
    "  answerCriteria stays free text describing what \"answered enough\" means; do not turn",
    "  it into a checklist and do not tick items off against it.",
    "- questions: an initial question tree. Every question carries a boundaryNote saying",
    "  where investigating that question ends.",
    "- Emit it as one fenced block so the conversation can render a confirmable scope card:",
    "",
    "```research-scope",
    '{"version":1,"brief":{"objective":"","inclusions":[],"exclusions":[""],"audience":"","answerCriteria":""},',
    '"questions":[{"text":"","priority":"critical","boundaryNote":""}]}',
    "```",
    "",
    "After the user clicks \"start research\" on the card, the payload comes back to you as a",
    "user command carrying the approved scope. Pass it to ResearchStart exactly as received.",
    "If ResearchStart rejects the payload, it returns a structured list of missing fields:",
    "read that list and ask the user for exactly those fields. Do not invent them, do not",
    "start a research task without the approved payload, and do not narrate that a",
    "constraint exists because the framework enforces it.",
    "",
    ...searchRules,
  ].join("\n");
}
