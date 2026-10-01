import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAITokenCounter } from "../dist/app/context-maintenance/token-counter.js";
import { ToolCenter } from "../dist/app/tool-center/tool-center.js";
import { InMemoryToolOutputStore } from "../dist/app/tool-center/tool-output-store.js";
import { createReadToolOutputTool } from "../dist/app/tool-center/adapters/tool-output-read-tool.js";
import { harnessToolResult } from "../dist/adapters/intelligence/tool-result-transport.js";
import { withToolModelAttachments } from "../dist/domain/tools/model-attachments.js";

const tokenCounter = createOpenAITokenCounter();
const image = {
  kind: "image",
  source: { kind: "data", mimeType: "image/png", data: Buffer.alloc(100_000, 17).toString("base64") },
};
const request = {
  providerCallId: "image-call",
  invocationId: "image-invocation",
  toolName: "AttachmentReadImage",
  input: {},
};
const context = { callerAgentId: "ordinary", traceId: "image-run", goalId: "image-goal" };

function registerImageTool(center, body) {
  center.register({
    definition: {
      name: request.toolName,
      description: "Read an image with text metadata.",
      inputSchema: { type: "object", properties: {} },
      metadata: { category: "filesystem", operationType: "read-only", riskLevel: "low", requiresConfirmation: false },
    },
    async execute() {
      return withToolModelAttachments(body, [image]);
    },
  });
}

function modelResult(result) {
  return harnessToolResult(result, { supportsVisionInput: true, modelInputSupportsImage: true });
}

test("a normal image reaches the model without requiring text result retention", async () => {
  const center = new ToolCenter({ outputTokenCounter: tokenCounter });
  registerImageTool(center, { format: "image", readable: true });

  const result = await center.execute(request, context, {
    callerAgentId: context.callerAgentId, allowedTools: [request.toolName],
  });
  assert.equal(result.status, "completed");
  assert.equal(result.output.contentRef, undefined);
  const delivered = modelResult(result);
  assert.equal(JSON.parse(delivered.content[0].text).status, "completed");
  assert.deepEqual(delivered.content[1], {
    type: "image", mimeType: image.source.mimeType, data: image.source.data,
  });
});

test("retaining oversized text preserves its image and readable continuation", async () => {
  const store = new InMemoryToolOutputStore();
  const center = new ToolCenter({ outputStore: store, outputTokenCounter: tokenCounter });
  const body = { format: "image", description: "Image evidence and detailed metadata. ".repeat(10_000) };
  registerImageTool(center, body);
  center.register(createReadToolOutputTool(store, { outputTokenCounter: tokenCounter }));
  const permission = { callerAgentId: context.callerAgentId, allowedTools: [request.toolName, "ReadOutput"] };

  const result = await center.execute(request, context, permission);
  assert.equal(result.status, "completed");
  assert.ok(result.output.contentRef);
  const delivered = modelResult(result);
  assert.equal(delivered.content[1].type, "image");
  assert.equal(delivered.content[1].data, image.source.data);
  const next = await center.execute({
    providerCallId: "read-call", invocationId: "read-invocation",
    toolName: "ReadOutput", input: result.output.continuation.nextInput,
  }, context, permission);
  assert.equal(next.status, "completed");
  assert.ok(JSON.stringify(body).startsWith(next.output.content));
  assert.ok(next.output.content.length > 0);
});
