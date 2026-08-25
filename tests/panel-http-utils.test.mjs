import assert from "node:assert/strict";
import test from "node:test";

import { PanelHttpError, readJsonBody } from "../dist/app/panel-server/http-utils.js";

test("JSON body preserves UTF-8 characters split across transport chunks", async () => {
  const payload = Buffer.from(JSON.stringify({ guidance: "先分析，再执行。" }), "utf8");
  const splitInsideFirstChineseCharacter = payload.indexOf(Buffer.from("先", "utf8")) + 1;
  const request = chunkedRequest([
    payload.subarray(0, splitInsideFirstChineseCharacter),
    payload.subarray(splitInsideFirstChineseCharacter, splitInsideFirstChineseCharacter + 1),
    payload.subarray(splitInsideFirstChineseCharacter + 1),
  ]);

  assert.deepEqual(await readJsonBody(request), { guidance: "先分析，再执行。" });
});

test("JSON body rejects malformed UTF-8 with a structured client error", async () => {
  const request = chunkedRequest([
    Buffer.from('{"value":"', "utf8"),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}', "utf8"),
  ]);

  await assert.rejects(
    readJsonBody(request),
    (error) => error instanceof PanelHttpError && error.statusCode === 400 && error.code === "invalid_utf8",
  );
});

function chunkedRequest(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}
