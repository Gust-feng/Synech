import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isTerminal,
  isTerminalEvent,
  type OrdinaryAgentFeature,
  type OrdinaryRunActivity,
  type OrdinaryRunActivityCursor,
  type OrdinaryRunState,
} from "../../ordinary-agent/index.js";
import { durableOrdinaryRunReplayFromState } from "../../ordinary-agent/activity-replay.js";
import { nowIso } from "../../../kernel/id.js";
import {
  encodeOrdinaryPanelCursor,
  parseOrdinaryPanelCursor,
  projectOrdinaryPanelActivityBatch,
  projectOrdinaryPanelConversation,
  projectOrdinaryPanelConversationSummary,
  projectOrdinaryPanelRunView,
  type OrdinaryPanelRunView,
} from "./ordinary-agent-panel-projection.js";
import { PanelHttpError, readJsonBody, writeJson } from "../http-utils.js";
import {
  parseConfirmationDecision,
  parseConversationPinInput,
  parseConversationRenameInput,
  parseConversationRollbackInput,
  parseRunInput,
} from "../request-parsers.js";
import type { PanelRunInput } from "../request-parsers.js";
import type { ConversationLifecycleCoordinator, SpaceConversationDeletionCoordinator } from "../spaces/space-conversation-coordinator.js";
import type { WorkspaceDeletionCoordinator } from "../spaces/workspace-deletion-coordinator.js";
import { SseResponseWriter } from "../sse-response-writer.js";
import type { OrdinaryTurnApplication, OrdinaryTurnInput } from "../../application/ordinary-turn-application.js";

const ORDINARY_STREAM_HEARTBEAT_INTERVAL_MS = 5_000;
const ORDINARY_STREAM_DELTA_COALESCE_MS = 16;
const ORDINARY_STREAM_MAX_QUEUED_FRAMES = 256;

export type OrdinaryRouteDependencies = {
  readonly ordinaryAgentFeature: {
    readonly commands: Pick<OrdinaryAgentFeature["commands"], "renameConversation" | "setConversationPinned" | "rollbackConversation" | "cancel" | "decideApproval">;
    readonly queries: Pick<OrdinaryAgentFeature["queries"], "getConversation" | "getConversationOwner" | "listConversations" | "getRun">;
    readonly events: Pick<OrdinaryAgentFeature["events"], "replay" | "subscribe">;
  };
  readonly ordinaryTurnApplication: OrdinaryTurnApplication;
  readonly conversationLifecycle: Pick<ConversationLifecycleCoordinator, "deleteConversation" | "assertConversationAvailable">;
  readonly spaceConversationDeletion: Pick<SpaceConversationDeletionCoordinator, "assertAvailable">;
  readonly workspaceDeletion: Pick<WorkspaceDeletionCoordinator, "assertAvailable">;
};

export async function handlePanelOrdinaryRoute(
  runtime: OrdinaryRouteDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/conversations") {
    writeJson(response, 200, { ok: true, conversations: await listConversations(runtime) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/conversations") {
    await submitTurn(runtime, request, response);
    return true;
  }

  const messages = /^\/api\/conversations\/([^/]+)\/messages$/u.exec(url.pathname);
  if (request.method === "POST" && messages !== null) {
    await submitTurn(runtime, request, response, decode(messages[1]));
    return true;
  }
  const rename = /^\/api\/conversations\/([^/]+)\/rename$/u.exec(url.pathname);
  if (request.method === "POST" && rename !== null) {
    const conversationId = decode(rename[1]);
    await assertConversationMutationAvailable(runtime, conversationId);
    const input = parseConversationRenameInput(await readJsonBody(request));
    const conversation = await runtime.ordinaryAgentFeature.commands.renameConversation(conversationId, input.title);
    writeJson(response, 200, {
      ok: true,
      conversation: await projectConversation(runtime, conversation),
      conversations: await listConversations(runtime),
    });
    return true;
  }
  const pin = /^\/api\/conversations\/([^/]+)\/pin$/u.exec(url.pathname);
  if (request.method === "POST" && pin !== null) {
    const conversationId = decode(pin[1]);
    await assertConversationMutationAvailable(runtime, conversationId);
    const input = parseConversationPinInput(await readJsonBody(request));
    const conversation = await runtime.ordinaryAgentFeature.commands.setConversationPinned(conversationId, input.pinned);
    writeJson(response, 200, {
      ok: true,
      conversation: await projectConversation(runtime, conversation),
      conversations: await listConversations(runtime),
    });
    return true;
  }
  const rollback = /^\/api\/conversations\/([^/]+)\/rollback$/u.exec(url.pathname);
  if (request.method === "POST" && rollback !== null) {
    const conversationId = decode(rollback[1]);
    await assertConversationMutationAvailable(runtime, conversationId);
    const input = parseConversationRollbackInput(await readJsonBody(request));
    const existing = await runtime.ordinaryAgentFeature.queries.getConversation(conversationId);
    if (existing === undefined) throw new PanelHttpError(404, "conversation_not_found", "未找到对话。");
    const targetTurnId = input.targetTurnId;
    const targetRunId = targetTurnId === undefined
      ? input.targetRunId
      : existing.turns.find((turn) => turn.turnId === targetTurnId)?.runId;
    if (targetTurnId !== undefined && targetRunId === undefined) {
      throw new PanelHttpError(404, "conversation_turn_not_found", "未找到要回退到的对话轮次。");
    }
    const conversation = await runtime.ordinaryAgentFeature.commands.rollbackConversation({
      conversationId,
      targetRunId,
      stepsBack: input.stepsBack,
    });
    writeJson(response, 200, { ok: true, conversation: await projectConversation(runtime, conversation) });
    return true;
  }

  const conversation = /^\/api\/conversations\/([^/]+)$/u.exec(url.pathname);
  if (request.method === "GET" && conversation !== null) {
    const view = await runtime.ordinaryAgentFeature.queries.getConversation(decode(conversation[1]));
    if (view === undefined) throw new PanelHttpError(404, "conversation_not_found", "未找到对话。");
    writeJson(response, 200, { ok: true, conversation: await projectConversation(runtime, view) });
    return true;
  }
  if (request.method === "DELETE" && conversation !== null) {
    const conversationId = decode(conversation[1]);
    await runtime.conversationLifecycle.deleteConversation(conversationId);
    writeJson(response, 200, {
      ok: true,
      deletedConversationId: conversationId,
      conversations: await listConversations(runtime),
    });
    return true;
  }

  const runView = /^\/api\/ordinary\/runs\/([^/]+)\/view$/u.exec(url.pathname);
  if (request.method === "GET" && runView !== null) {
    const runId = decode(runView[1]);
    const cursor = requestCursor(url, request);
    const view = await projectRunView(runtime, runId, cursor);
    if (view === undefined) throw new PanelHttpError(404, "run_not_found", "未找到普通 Agent 运行视图。");
    writeJson(response, 200, { ok: true, view: view.view });
    return true;
  }
  const stream = /^\/api\/ordinary\/runs\/([^/]+)\/stream$/u.exec(url.pathname);
  if (request.method === "GET" && stream !== null) {
    await streamRun(runtime, decode(stream[1]), requestCursor(url, request), request, response);
    return true;
  }
  const cancel = /^\/api\/ordinary\/runs\/([^/]+)\/cancel$/u.exec(url.pathname);
  if (request.method === "POST" && cancel !== null) {
    const state = await runtime.ordinaryAgentFeature.commands.cancel(decode(cancel[1]), "cancelled_by_user");
    writeJson(response, 200, { ok: true, run: (await projectCommandRun(runtime, state)).view.run });
    return true;
  }
  const confirmation = /^\/api\/ordinary\/runs\/([^/]+)\/confirmations\/([^/]+)\/decision$/u.exec(url.pathname);
  if (request.method === "POST" && confirmation !== null) {
    const runId = decode(confirmation[1]);
    const confirmationId = decode(confirmation[2]);
    const decision = parseConfirmationDecision(await readJsonBody(request));
    const state = await runtime.ordinaryAgentFeature.commands.decideApproval({
      ownerRunId: runId,
      confirmationId,
      decision: decision.decision,
      guidance: decision.guidance,
      decidedAt: nowIso(),
    });
    writeJson(response, 200, { ok: true, run: (await projectCommandRun(runtime, state)).view.run });
    return true;
  }
  return false;
}

async function submitTurn(
  runtime: OrdinaryRouteDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  conversationId?: string,
): Promise<void> {
  const runInput = parseRunInput(await readJsonBody(request));
  const result = await runtime.ordinaryTurnApplication.submit({ runInput: toOrdinaryTurnInput(runInput), conversationId });
  const run = await projectCommandRun(runtime, result.submitted.run);
  writeJson(response, 202, {
    ok: true,
    conversation: projectOrdinaryPanelConversation({
      conversation: result.submitted.conversation,
      currentRun: run.view,
      workspaceRun: run.state,
      owner: result.owner,
      spaceId: result.spaceId,
    }),
    run: run.view.run,
  });
}

function toOrdinaryTurnInput(input: PanelRunInput): OrdinaryTurnInput {
  return {
    goal: input.goal,
    ...(input.submissionId === undefined ? {} : { submissionId: input.submissionId }),
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    ...(input.aiMode === undefined ? {} : { aiMode: input.aiMode }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.toolConfirmationPolicy === undefined ? {} : { toolConfirmationPolicy: input.toolConfirmationPolicy }),
    ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
    ...(input.contextInput === undefined ? {} : { contextInput: input.contextInput }),
  };
}

async function assertConversationMutationAvailable(runtime: OrdinaryRouteDependencies, conversationId: string): Promise<void> {
  runtime.conversationLifecycle.assertConversationAvailable(conversationId);
  const owner = await conversationOwnerForList(runtime, conversationId);
  if (owner === undefined) {
    throw new PanelHttpError(409, "conversation_owner_required", "Conversation 缺少 owner，不能继续修改。");
  }
  if (owner.kind === "space") {
    runtime.spaceConversationDeletion.assertAvailable(owner.id);
  } else {
    runtime.workspaceDeletion.assertAvailable(owner.id);
  }
}

async function listConversations(runtime: OrdinaryRouteDependencies) {
  return Promise.all((await runtime.ordinaryAgentFeature.queries.listConversations(50)).map(async (conversation) => {
    const workspaceRun = conversation.latestRunId === undefined
      ? undefined
      : await runtime.ordinaryAgentFeature.queries.getRun(conversation.latestRunId);
    const owner = await conversationOwnerForList(runtime, conversation.conversationId);
    return projectOrdinaryPanelConversationSummary(
      conversation,
      workspaceRun,
      owner?.kind === "space" ? owner.id : undefined,
      owner,
    );
  }));
}

async function conversationOwnerForList(
  runtime: OrdinaryRouteDependencies,
  conversationId: string,
) {
  return runtime.ordinaryAgentFeature.queries.getConversationOwner(conversationId);
}

async function projectConversation(
  runtime: OrdinaryRouteDependencies,
  conversation: Exclude<Awaited<ReturnType<OrdinaryAgentFeature["queries"]["getConversation"]>>, undefined>,
) {
  const runId = conversation.activeRunId ?? conversation.latestRunId;
  const [currentRun, workspaceRun, owner] = await Promise.all([
    runId === undefined ? Promise.resolve(undefined) : projectRunView(runtime, runId),
    conversation.latestRunId === undefined
      ? Promise.resolve(undefined)
      : runtime.ordinaryAgentFeature.queries.getRun(conversation.latestRunId),
    conversationOwnerForList(runtime, conversation.conversationId),
  ]);
  return projectOrdinaryPanelConversation({
    conversation,
    currentRun: currentRun?.view,
    workspaceRun,
    owner,
    spaceId: owner?.kind === "space" ? owner.id : undefined,
  });
}

async function projectCommandRun(runtime: OrdinaryRouteDependencies, run: OrdinaryRunState): Promise<{
  readonly state: OrdinaryRunState;
  readonly view: OrdinaryPanelRunView;
}> {
  const fullReplay = await runtime.ordinaryAgentFeature.events.replay(run.runId)
    ?? (run.status.kind === "completed" ? undefined : durableOrdinaryRunReplayFromState(run, []));
  if (fullReplay === undefined) {
    throw new PanelHttpError(404, "run_not_found", "未找到基础 Agent 运行视图。");
  }
  return {
    state: run,
    view: projectOrdinaryPanelRunView({
      run,
      fullReplay,
    }),
  };
}

async function projectRunView(
  runtime: OrdinaryRouteDependencies,
  runId: string,
  cursor?: OrdinaryRunActivityCursor,
): Promise<{ readonly state: OrdinaryRunState; readonly view: OrdinaryPanelRunView } | undefined> {
  const [state, fullReplay, incremental] = await Promise.all([
    runtime.ordinaryAgentFeature.queries.getRun(runId),
    runtime.ordinaryAgentFeature.events.replay(runId),
    cursor === undefined ? Promise.resolve(undefined) : runtime.ordinaryAgentFeature.events.replay(runId, cursor),
  ]);
  if (state === undefined || fullReplay === undefined) return undefined;
  return {
    state,
    view: projectOrdinaryPanelRunView({
      run: state,
      fullReplay,
      replay: incremental ?? fullReplay,
    }),
  };
}

async function streamRun(
  runtime: OrdinaryRouteDependencies,
  runId: string,
  cursor: OrdinaryRunActivityCursor | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const initialRun = await runtime.ordinaryAgentFeature.queries.getRun(runId);
  if (initialRun === undefined) throw new PanelHttpError(404, "run_not_found", "未找到基础 Agent 运行事件。");

  const buffered: OrdinaryRunActivity[] = [];
  let initialized = false;
  let closed = false;
  let streamId = "";
  let lastSequence = cursor?.sequence ?? 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let deltaFlushTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingDelta: Extract<OrdinaryRunActivity, { readonly type: "model.output.delta" }> | undefined;
  const writer = new SseResponseWriter(response, {
    maxQueuedFrames: ORDINARY_STREAM_MAX_QUEUED_FRAMES,
    onFailure: () => cleanup(),
  });
  const unsubscribe = runtime.ordinaryAgentFeature.events.subscribe(runId, (activity) => {
    if (!initialized) {
      buffered.push(activity);
      return;
    }
    queueLiveActivity(activity);
  });
  request.once("close", cleanup);
  request.once("error", cleanup);
  response.once("close", cleanup);
  response.once("error", cleanup);
  try {
    const replay = await runtime.ordinaryAgentFeature.events.replay(runId, cursor);
    if (replay === undefined) {
      cleanup(false);
      throw new PanelHttpError(404, "run_not_found", "未找到基础 Agent 运行事件。");
    }
    streamId = replay.cursor.streamId;
    if (replay.reset) lastSequence = 0;

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    if (!(await writer.write(`: ordinary agent stream ${runId}\n\n`))) {
      cleanup();
      return;
    }
    if (replay.reset) {
      const resetCursor = encodeOrdinaryPanelCursor({ streamId, sequence: 0 });
      if (!(await writer.write(
        `id: ${resetCursor}\nevent: run.stream.reset\ndata: ${JSON.stringify({ runId, cursor: resetCursor })}\n\n`,
      ))) {
        cleanup();
        return;
      }
    }
    for (const activity of replay.activities) await writeActivity(activity);
    lastSequence = Math.max(lastSequence, replay.cursor.sequence);
    while (buffered.length > 0) {
      for (const activity of buffered.splice(0)) await writeActivity(activity);
    }
    if (closed) return;
    initialized = true;
    heartbeat = setInterval(() => {
      if (closed || response.writableEnded) return;
      const token = encodeOrdinaryPanelCursor({ streamId, sequence: lastSequence });
      if (!writer.enqueue(
        `event: run.stream.heartbeat\ndata: ${JSON.stringify({ runId, cursor: token })}\n\n`,
      )) cleanup();
    }, ORDINARY_STREAM_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    const current = await runtime.ordinaryAgentFeature.queries.getRun(runId);
    if (current !== undefined && isTerminal(current)) cleanup();
  } catch (error) {
    cleanup(response.headersSent);
    throw error;
  }

  async function writeActivity(activity: OrdinaryRunActivity): Promise<void> {
    if (closed || activity.sequence <= lastSequence) return;
    const state = await runtime.ordinaryAgentFeature.queries.getRun(runId);
    if (state === undefined || closed) return cleanup();
    const batch = projectOrdinaryPanelActivityBatch({
      run: state,
      replay: {
        cursor: { streamId, sequence: activity.sequence },
        reset: false,
        activities: [activity],
      },
    });
    const event = batch.events[0];
    if (event !== undefined) {
      const token = encodeOrdinaryPanelCursor({ streamId, sequence: activity.sequence });
      if (!(await writer.write(
        `id: ${token}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      ))) return cleanup();
    }
    lastSequence = activity.sequence;
    if (isTerminalTransition(activity)) cleanup();
  }

  function queueLiveActivity(activity: OrdinaryRunActivity): void {
    if (activity.type !== "model.output.delta") {
      flushPendingDelta();
      enqueueActivity(activity);
      return;
    }
    if (
      pendingDelta !== undefined &&
      activity.sequence === pendingDelta.sequence + 1 &&
      activity.modelRequestId === pendingDelta.modelRequestId &&
      activity.contentIndex === pendingDelta.contentIndex
    ) {
      pendingDelta = { ...activity, delta: `${pendingDelta.delta}${activity.delta}` };
    } else {
      flushPendingDelta();
      pendingDelta = activity;
    }
    if (deltaFlushTimer === undefined) {
      deltaFlushTimer = setTimeout(flushPendingDelta, ORDINARY_STREAM_DELTA_COALESCE_MS);
      deltaFlushTimer.unref?.();
    }
  }

  function flushPendingDelta(): void {
    if (deltaFlushTimer !== undefined) {
      clearTimeout(deltaFlushTimer);
      deltaFlushTimer = undefined;
    }
    const delta = pendingDelta;
    pendingDelta = undefined;
    if (delta !== undefined) enqueueActivity(delta);
  }

  function enqueueActivity(activity: OrdinaryRunActivity): void {
    if (!writer.enqueueTask(() => writeActivity(activity))) cleanup();
  }

  function cleanup(endResponse = true): void {
    if (closed) return;
    closed = true;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (deltaFlushTimer !== undefined) {
      clearTimeout(deltaFlushTimer);
      deltaFlushTimer = undefined;
    }
    pendingDelta = undefined;
    writer.close();
    unsubscribe();
    request.off("close", cleanup);
    request.off("error", cleanup);
    response.off("close", cleanup);
    response.off("error", cleanup);
    if (endResponse && !response.writableEnded) response.end();
  }
}

function requestCursor(url: URL, request: IncomingMessage): OrdinaryRunActivityCursor | undefined {
  const header = request.headers["last-event-id"];
  const raw = url.searchParams.get("cursor") ?? (Array.isArray(header) ? header[0] : header);
  return parseOrdinaryPanelCursor(raw ?? undefined);
}

function isTerminalTransition(activity: OrdinaryRunActivity): boolean {
  return activity.type === "run.transition" && isTerminalEvent(activity.event);
}

function decode(value: string | undefined): string {
  return decodeURIComponent(value ?? "");
}
