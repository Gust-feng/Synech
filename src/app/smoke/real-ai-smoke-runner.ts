import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ModelUsage } from "../../domain/intelligence/index.js";
import type { ToolCallResult } from "../../domain/tools/index.js";
import { createLocalConfigCenter } from "../config-center/index.js";
import { startLocalPanelServer } from "../panel-server.js";
import type { PanelProviderFetch } from "../panel-server/types.js";

type RealAiSmokeEnvironment = Readonly<Record<string, string | undefined>>;
type SmokeProtocol = "openai_responses" | "openai_compatible_chat_completions";

export type RealAiSmokeSummary =
  | {
      readonly status: "completed";
      readonly runtime: "ordinary_agent";
      readonly protocol: SmokeProtocol;
      readonly conversationId: string;
      readonly runId: string;
      readonly answer: string;
      readonly toolCallCount: number;
      readonly usage: ModelUsage;
    }
  | {
      readonly status: "failed";
      readonly runtime: "ordinary_agent";
      readonly protocol: SmokeProtocol;
      readonly runId?: string;
      readonly message: string;
    }
  | {
      readonly status: "skipped";
      readonly runtime: "ordinary_agent";
      readonly boundary: "configuration";
      readonly code: "ai_disabled" | "missing_api_key" | "missing_model_name" | "invalid_protocol";
      readonly message: string;
    };

export type RunRealAiSmokeOptions = {
  readonly env?: RealAiSmokeEnvironment;
  readonly providerFetch?: PanelProviderFetch;
  readonly configDirectory?: string;
  readonly timeoutMs?: number;
};

const DEFAULT_GOAL = [
  "Use the list tool to inspect the current workspace root.",
  "Then return a concise, evidence-based optimization report that cites the observed entries.",
].join(" ");
const submitSchema = z.object({
  ok: z.literal(true),
  conversation: z.object({ conversationId: z.string().min(1) }).passthrough(),
  run: z.object({ runId: z.string().min(1) }).passthrough(),
}).passthrough();
const spaceSchema = z.object({
  ok: z.literal(true),
  space: z.object({ id: z.string().min(1) }).passthrough(),
}).passthrough();
const viewSchema = z.object({
  ok: z.literal(true),
  view: z.object({
    run: z.object({
      runId: z.string().min(1),
      status: z.enum(["queued", "running", "approval_needed", "blocked", "completed", "failed", "cancelled"]),
    }).passthrough(),
    workView: z.object({
      answer: z.object({ content: z.string() }).passthrough().optional(),
    }).passthrough(),
    detail: z.object({
      error: z.object({ message: z.string() }).passthrough().optional(),
      toolResults: z.array(z.custom<ToolCallResult>()),
      usage: z.custom<ModelUsage>(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export async function runRealAiSmoke(
  goal = DEFAULT_GOAL,
  options: RunRealAiSmokeOptions = {},
): Promise<RealAiSmokeSummary> {
  const env = options.env ?? process.env;
  const configuration = smokeConfiguration(env);
  if (configuration.status === "skipped") return configuration;

  const ownsDirectory = options.configDirectory === undefined;
  const configDirectory = options.configDirectory ?? await fs.mkdtemp(path.join(os.tmpdir(), "synech-real-ai-smoke-"));
  const local = createLocalConfigCenter({ configDirectory });
  let server: Awaited<ReturnType<typeof startLocalPanelServer>> | undefined;
  try {
    const smokeProfileId = "real-ai-smoke";
    await local.configCenter.createModelProviderProfile({
      profileId: smokeProfileId,
      label: "Real AI Smoke",
      providerKind: "openai_compatible",
      protocolKind: configuration.protocol,
      baseUrl: configuration.baseUrl,
      model: configuration.model,
      apiKey: configuration.apiKey,
      defaultAiMode: configuration.protocol === "openai_responses" ? "openai-responses" : "openai-compatible",
      enabled: true,
    });
    await local.configCenter.activateModelProviderProfile(smokeProfileId);
    server = await startLocalPanelServer({
      port: 0,
      configDirectory,
      configCenter: local.configCenter,
      providerFetch: options.providerFetch,
    });
    const space = spaceSchema.parse(await requestJson(new URL("api/spaces", server.url), {
      method: "POST",
      body: JSON.stringify({ title: "Real AI Smoke" }),
    }));
    const submitted = submitSchema.parse(await requestJson(new URL("api/conversations", server.url), {
      method: "POST",
      body: JSON.stringify({ goal, spaceId: space.space.id }),
    }));
    const view = await waitForTerminalView(server.url, submitted.run.runId, options.timeoutMs ?? 120_000);
    if (view.view.run.status !== "completed" || view.view.workView.answer === undefined) {
      return {
        status: "failed",
        runtime: "ordinary_agent",
        protocol: configuration.protocol,
        runId: submitted.run.runId,
        message: view.view.detail.error?.message ?? `Ordinary Agent ended with status ${view.view.run.status}.`,
      };
    }
    if (view.view.detail.toolResults.length === 0) {
      return {
        status: "failed",
        runtime: "ordinary_agent",
        protocol: configuration.protocol,
        runId: submitted.run.runId,
        message: "Ordinary Agent completed without a persisted tool fact.",
      };
    }
    if (!hasReportedUsage(view.view.detail.usage)) {
      return {
        status: "failed",
        runtime: "ordinary_agent",
        protocol: configuration.protocol,
        runId: submitted.run.runId,
        message: "Ordinary Agent completed without valid provider usage.",
      };
    }
    return {
      status: "completed",
      runtime: "ordinary_agent",
      protocol: configuration.protocol,
      conversationId: submitted.conversation.conversationId,
      runId: submitted.run.runId,
      answer: view.view.workView.answer.content,
      toolCallCount: view.view.detail.toolResults.length,
      usage: view.view.detail.usage,
    };
  } catch (error) {
    return {
      status: "failed",
      runtime: "ordinary_agent",
      protocol: configuration.protocol,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await server?.close().catch(() => undefined);
    if (ownsDirectory) {
      await fs.rm(configDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
    }
  }
}

function smokeConfiguration(env: RealAiSmokeEnvironment):
  | { readonly status: "ready"; readonly protocol: SmokeProtocol; readonly baseUrl: string; readonly model: string; readonly apiKey: string }
  | Extract<RealAiSmokeSummary, { readonly status: "skipped" }> {
  if (env.SYNECH_AI_MODE?.trim().toLowerCase() === "none") {
    return skipped("ai_disabled", "AI is disabled; the Ordinary Agent smoke was not started.");
  }
  const apiKey = env.SYNECH_MODEL_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return skipped("missing_api_key", "SYNECH_MODEL_API_KEY or OPENAI_API_KEY is required.");
  }
  const model = env.SYNECH_MODEL_NAME?.trim();
  if (model === undefined || model.length === 0) {
    return skipped("missing_model_name", "SYNECH_MODEL_NAME is required.");
  }
  const rawProtocol = env.SYNECH_MODEL_PROTOCOL?.trim() ||
    (env.SYNECH_AI_MODE?.trim() === "openai-responses" ? "openai_responses" : "openai_compatible_chat_completions");
  if (rawProtocol !== "openai_responses" && rawProtocol !== "openai_compatible_chat_completions") {
    return skipped("invalid_protocol", "SYNECH_MODEL_PROTOCOL must be openai_responses or openai_compatible_chat_completions.");
  }
  return {
    status: "ready",
    protocol: rawProtocol,
    baseUrl: env.SYNECH_MODEL_BASE_URL?.trim() || "https://api.openai.com/v1",
    model,
    apiKey,
  };
}

function skipped(
  code: Extract<RealAiSmokeSummary, { readonly status: "skipped" }>["code"],
  message: string,
): Extract<RealAiSmokeSummary, { readonly status: "skipped" }> {
  return { status: "skipped", runtime: "ordinary_agent", boundary: "configuration", code, message };
}

async function waitForTerminalView(baseUrl: string, runId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const view = viewSchema.parse(await requestJson(
      new URL(`api/ordinary/runs/${encodeURIComponent(runId)}/view`, baseUrl),
    ));
    if (["completed", "failed", "cancelled", "blocked", "approval_needed"].includes(view.view.run.status)) return view;
    if (Date.now() >= deadline) throw new Error(`Ordinary Agent smoke timed out after ${timeoutMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function hasReportedUsage(usage: ModelUsage): boolean {
  return typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens) && usage.inputTokens > 0 &&
    typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens) && usage.outputTokens > 0 &&
    typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0;
}

async function requestJson(url: URL, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json() as unknown;
  if (!response.ok) throw new Error(`Smoke request failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
