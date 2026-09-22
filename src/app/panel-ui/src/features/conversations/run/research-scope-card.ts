import {
  RESEARCH_SCOPE_PROPOSAL_VERSION,
  readResearchScopeProposal,
  type ResearchScopeProposal,
  type ResearchScopeQuestionView,
  type ResearchStartPayload,
} from '@panel-api/research'
import { createResearchTask, ResearchScopeRejected } from '../../research/research-client'

/** 提案信封的围栏前缀：既有解析用，也有展示剥离用（同一常量，不写两遍）。 */
const PROPOSAL_FENCE = '```research-scope'

/**
 * 范围卡（ADR 0001 §2.2 / 设计草案 §8.1）：把主会话产出的结构化提案渲染为
 * 可确认卡片，用户点击「开始研究」产生携带 payload 的用户命令。
 *
 * 这是深度研究的**唯一启动路径**：卡片是闸门组成部分，不提供免确认入口。
 * 结构完整性由服务端的范围门判定；卡片只负责把用户已批准的载荷原样送出去，
 * 范围门拒绝时把结构化缺失字段清单带回，由对话侧继续追问。
 *
 * 数据流（与既有 decideApproval 的用户决定模式同构）：
 * 主会话 answer 文本里的版本化提案信封 → 本模块解析 → 卡片渲染
 * → 用户点击 → POST /api/research（Route 只解析输入、调一个 command）
 * → ResearchApplication.start。
 */

export type ResearchScopeCardState = {
  readonly proposal: ResearchScopeProposal
  /** 提案在同一轮回答里的稳定标识：批准/驳回后不再重复渲染。 */
  readonly proposalKey: string
}

export type ResearchScopeApprovalInput = {
  readonly conversationRef: string
  readonly approvedAt?: number
  /** 澄清期摘要级检索次数（提案自带披露；缺失表示未检索）。 */
  readonly snippetSearches?: number
}

/** 从 run 视图已有的回答文本里取出待确认提案；没有则 undefined。 */
export function readResearchScopeCardState(text: string | undefined): ResearchScopeCardState | undefined {
  if (text === undefined || text.trim().length === 0) return undefined
  const proposal = readResearchScopeProposal(text)
  if (proposal === undefined) return undefined
  return { proposal, proposalKey: researchScopeProposalKey(proposal) }
}

/**
 * 展示用正文：把提案信封从回答里摘掉，范围卡渲染它，不在正文里重复出现一遍。
 *
 * 只在确实取到提案时才改写；纯展示处理，不改变模型原文的事实内容。
 */
export function stripResearchScopeProposalBlock(text: string): string {
  if (!text.includes(PROPOSAL_FENCE)) return text
  return text
    .replace(/[ \t]*```research-scope[ \t]*\n[\s\S]*?```[ \t]*\n?/u, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** 提案标识：同一内容的提案只算一张卡（内容变了我才算新提案）。 */
export function researchScopeProposalKey(proposal: ResearchScopeProposal): string {
  const questions = proposal.questions
    .map((question) => `${question.priority}|${question.text}|${question.boundaryNote}`)
    .join('\n')
  const search = proposal.scopeSearchDisclosure?.snippetSearches ?? -1
  return `v${RESEARCH_SCOPE_PROPOSAL_VERSION}:${proposal.brief.objective}|${proposal.brief.answerCriteria}|${questions}|${search}`
}

/**
 * 组装启动载荷：brief 与 questions 原样来自用户批准的提案，approval 由点击产生
 * （时间 + 会话引用）。框架在服务端按规范化 payload 计算并落账 payload_hash，
 * 因此这里不传哈希——客户端自述的哈希不构成可审计事实。
 */
export function researchStartPayloadFromProposal(
  state: ResearchScopeCardState,
  input: ResearchScopeApprovalInput,
): ResearchStartPayload {
  const questions: readonly ResearchScopeQuestionView[] = state.proposal.questions.map((question) => ({
    text: question.text,
    priority: question.priority,
    boundaryNote: question.boundaryNote,
  }))
  const snippetSearches = input.snippetSearches ?? state.proposal.scopeSearchDisclosure?.snippetSearches
  return {
    brief: {
      objective: state.proposal.brief.objective,
      inclusions: [...state.proposal.brief.inclusions],
      exclusions: [...state.proposal.brief.exclusions],
      audience: state.proposal.brief.audience,
      answerCriteria: state.proposal.brief.answerCriteria,
    },
    questions,
    approval: {
      approvedAt: input.approvedAt ?? Date.now(),
      conversationRef: input.conversationRef,
    },
    ...(snippetSearches === undefined
      ? {}
      : { scopeSearchDisclosure: { snippetSearches } }),
  }
}

/** 用户点击「开始研究」：只调 Application 的同一个命令，不在 UI 侧编排。 */
export async function submitResearchScope(payload: ResearchStartPayload): Promise<void> {
  await createResearchTask(payload)
}

export { ResearchScopeRejected }

/** 卡片展示用的纯派生数据：把提案整理成可读的分组；程序分支只用字段，不用文案。 */
export function researchScopeCardSections(proposal: ResearchScopeProposal): {
  readonly objective: string
  readonly inclusions: readonly string[]
  readonly exclusions: readonly string[]
  readonly audience: string
  readonly answerCriteria: string
  readonly questions: readonly ResearchScopeQuestionView[]
  readonly snippetSearches: number | undefined
} {
  return {
    objective: proposal.brief.objective,
    inclusions: proposal.brief.inclusions,
    exclusions: proposal.brief.exclusions,
    audience: proposal.brief.audience,
    answerCriteria: proposal.brief.answerCriteria,
    questions: proposal.questions,
    snippetSearches: proposal.scopeSearchDisclosure?.snippetSearches,
  }
}
