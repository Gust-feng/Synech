import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { readJsonBody } from "../dist/app/panel-server/http-utils.js";
import { parseConfirmationDecision } from "../dist/app/panel-server/request-parsers.js";

test("panel JSON decoding preserves UTF-8 characters split across chunks", async () => {
  const body = Buffer.from(JSON.stringify({ value: "中文😀" }), "utf8");
  const splitAt = body.indexOf(Buffer.from("中", "utf8")) + 1;
  const request = Readable.from([body.subarray(0, splitAt), body.subarray(splitAt)]);
  assert.deepEqual(await readJsonBody(request), { value: "中文😀" });
});

test("confirmation guidance preserves internal whitespace and full content", () => {
  const guidance = `第一行\n  保留缩进  和连续空格\n${"中".repeat(1_000)}`;
  assert.deepEqual(parseConfirmationDecision({
    confirmationId: "confirmation-1",
    decision: "guidance",
    guidance,
  }), { decision: "guidance", guidance });
});

test("confirmation guidance rejects oversize input instead of silently truncating it", () => {
  assert.throws(() => parseConfirmationDecision({
    confirmationId: "confirmation-1",
    decision: "guidance",
    guidance: "中".repeat(4_001),
  }), (error) => error?.code === "confirmation_guidance_too_large" && error?.statusCode === 400);
});
