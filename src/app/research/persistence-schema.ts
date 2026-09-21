import { z } from "zod";

import type {
  ResearchCoverageRound,
  ResearchPlan,
  ResearchQueryRecord,
  ResearchSource,
  ResearchTask,
  ResearchTaskSummary,
  ResearchUsage,
} from "./contracts.js";

/**
 * 从 SQLite 读出的每一行都经此校验：`as` 断言不构成运行时保证，
 * 库被外部改写或 schema 漂移必须在读取点明确失败。
 */

const id = z.string().min(1);
const timestamp = z.number().finite();

const questionSchema = z.object({
  id,
  text: z.string(),
  priority: z.enum(["high", "normal"]),
}).strict();

const planSchema = z.object({
  objective: z.string(),
  questions: z.array(questionSchema).min(1),
}).strict();

const coverageRoundSchema = z.object({
  round: z.number().int().min(1),
  answers: z.array(z.object({
    questionId: id,
    coverage: z.enum(["supported", "partial", "contested", "unanswered"]),
    text: z.string(),
    gaps: z.array(z.string()),
  }).strict()),
}).strict();

const usageSchema = z.object({
  searchRequests: z.number().int().min(0),
  fetchRequests: z.number().int().min(0),
  modelRequests: z.number().int().min(0),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  elapsedMs: z.number().int().min(0),
}).strict();

const taskSchema = z.object({
  id,
  question: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "interrupted", "cancelled"]),
  stage: z.enum(["planning", "searching", "reading", "analyzing", "writing"]).nullable(),
  plan: planSchema.nullable(),
  coverage: z.array(coverageRoundSchema),
  reportTitle: z.string().nullable(),
  reportMarkdown: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  usage: usageSchema,
  createdAt: timestamp,
  startedAt: timestamp.nullable(),
  endedAt: timestamp.nullable(),
}).strict();

const taskSummarySchema = z.object({
  id,
  question: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "interrupted", "cancelled"]),
  stage: z.enum(["planning", "searching", "reading", "analyzing", "writing"]).nullable(),
  sourceCount: z.number().int().min(0),
  questionCount: z.number().int().min(0),
  createdAt: timestamp,
  endedAt: timestamp.nullable(),
  errorCode: z.string().nullable(),
}).strict();

const sourceSchema = z.object({
  id,
  taskId: id,
  ordinal: z.number().int().min(1),
  title: z.string(),
  url: z.string(),
  canonicalUrl: z.string(),
  snippet: z.string(),
  contentText: z.string().nullable(),
  contentStatus: z.enum(["pending", "ready", "failed", "skipped"]),
  publishedAt: z.string().nullable(),
  retrievedAt: timestamp,
}).strict();

const querySchema = z.object({
  id,
  taskId: id,
  round: z.number().int().min(1),
  text: z.string(),
  status: z.enum(["succeeded", "failed"]),
  resultCount: z.number().int().min(0),
  createdAt: timestamp,
}).strict();

export function parseResearchTask(value: unknown): ResearchTask {
  return taskSchema.parse(value);
}

export function parseResearchTaskSummary(value: unknown): ResearchTaskSummary {
  return taskSummarySchema.parse(value);
}

export function parseResearchSource(value: unknown): ResearchSource {
  return sourceSchema.parse(value);
}

export function parseResearchQuery(value: unknown): ResearchQueryRecord {
  return querySchema.parse(value);
}

export function parseResearchPlan(value: unknown): ResearchPlan {
  return planSchema.parse(value);
}

export function parseResearchCoverageRound(value: unknown): ResearchCoverageRound {
  return coverageRoundSchema.parse(value);
}

export function parseResearchUsage(value: unknown): ResearchUsage {
  return usageSchema.parse(value);
}
