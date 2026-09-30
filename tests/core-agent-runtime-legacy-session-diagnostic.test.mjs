import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { TODO_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const outputRoot = path.resolve(process.env.SYNECH_TEST_DIST ?? "dist");
const { FileSystemAgentSessionRepository } = await import(pathToFileURL(path.join(outputRoot, "adapters/intelligence/file-system-agent-session-repository.js")));
const { parseLegacyV3SessionHeader } = await import(pathToFileURL(path.join(outputRoot, "adapters/intelligence/session-legacy-diagnostic.js")));
const { AgentSessionRepositoryError } = await import(pathToFileURL(path.join(outputRoot, "app/model-runtime/agent-session.js")));
const { createAgentRuntimeEnvironment } = await import(pathToFileURL(path.join(outputRoot, "adapters/intelligence/pi-agent/runtime-environment.js")));

const V3_HEADER = {
  type: "session",
  version: 3,
  id: "legacy-session",
  timestamp: "2026-09-01T00:00:00.000Z",
  cwd: process.cwd(),
};

test("legacy header parser identifies only Pi-compatible v3 headers", () => {
  assert.deepEqual(parseLegacyV3SessionHeader(JSON.stringify(V3_HEADER)), {
    id: V3_HEADER.id,
    cwd: V3_HEADER.cwd,
    timestamp: V3_HEADER.timestamp,
  });
  assert.equal(parseLegacyV3SessionHeader(undefined), undefined);
  assert.equal(parseLegacyV3SessionHeader("not json"), undefined);
  assert.equal(parseLegacyV3SessionHeader(JSON.stringify({ ...V3_HEADER, version: 4 })), undefined);
  assert.equal(parseLegacyV3SessionHeader(JSON.stringify({ ...V3_HEADER, timestamp: "invalid" })), undefined);
  assert.equal(parseLegacyV3SessionHeader(JSON.stringify({ ...V3_HEADER, parentSession: null })), undefined);
});

test("repository rejects a real Pi v3 session without modifying its bytes and opens v4", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synech-legacy-session-"));
  const agentRoot = path.join(root, "data", "agent");
  const sessionsRoot = path.join(agentRoot, "sessions");
  const environment = createAgentRuntimeEnvironment(agentRoot);
  const repository = new FileSystemAgentSessionRepository({ executionEnvironment: environment, sessionsRoot });
  const piEnvironment = new NodeExecutionEnv({ cwd: agentRoot });
  const piRepository = new JsonlSessionRepo({ fileSystem: piEnvironment, sessionsRoot });
  try {
    const legacyDirectory = path.join(sessionsRoot, `--${process.cwd().replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`);
    await mkdir(legacyDirectory, { recursive: true });
    const legacyPath = path.join(legacyDirectory, "2026-09-01T00-00-00-000Z_legacy-session.jsonl");
    const v3Bytes = `${JSON.stringify(V3_HEADER)}\n`;
    await writeFile(legacyPath, v3Bytes, "utf8");
    const listedLegacy = await piRepository.list({ cwd: process.cwd() }, TODO_CONTEXT);
    assert.equal(listedLegacy.length, 1, "the fixture header must be recognized by Pi 0.87");
    const legacyRef = {
      sessionId: V3_HEADER.id,
      storageKey: path.relative(sessionsRoot, legacyPath).split(path.sep).join("/"),
      sessionCwd: V3_HEADER.cwd,
      createdAt: new Date(Date.parse(V3_HEADER.timestamp)).toISOString(),
    };
    const originalBytes = await readFile(legacyPath);
    await assert.rejects(
      () => repository.activeTranscriptPositions(legacyRef),
      (error) => error instanceof AgentSessionRepositoryError &&
        error.code === "agent_session_legacy_requires_reset",
    );
    assert.deepEqual(await readFile(legacyPath), originalBytes, "the v3 file must remain byte-for-byte unchanged");

    const damagedPath = path.join(legacyDirectory, "2026-09-02T00-00-00-000Z_damaged-session.jsonl");
    await writeFile(damagedPath, "{not-json}\n", "utf8");
    await assert.rejects(
      () => repository.activeTranscriptPositions({ ...legacyRef, sessionId: "damaged-session", storageKey: path.relative(sessionsRoot, damagedPath).split(path.sep).join("/") }),
      (error) => error instanceof AgentSessionRepositoryError &&
        error.code === "agent_session_not_found",
    );
    await assert.rejects(
      () => repository.activeTranscriptPositions({ ...legacyRef, sessionId: "missing-session", storageKey: "missing.jsonl" }),
      (error) => error instanceof AgentSessionRepositoryError &&
        error.code === "agent_session_not_found",
    );

    const v4Session = await piRepository.create({ id: "current-session", cwd: process.cwd() }, TODO_CONTEXT);
    const v4Ref = {
      sessionId: v4Session.metadata.id,
      storageKey: path.relative(sessionsRoot, v4Session.metadata.path).split(path.sep).join("/"),
      sessionCwd: v4Session.metadata.cwd,
      createdAt: new Date(v4Session.metadata.createdAt).toISOString(),
    };
    await v4Session.close(TODO_CONTEXT);
    assert.deepEqual(await repository.activeTranscriptPositions(v4Ref), []);
  } finally {
    await piRepository.close(TODO_CONTEXT);
    await piEnvironment.cleanup(TODO_CONTEXT);
    await environment.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
