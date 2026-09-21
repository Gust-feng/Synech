import assert from "node:assert/strict";
import test from "node:test";

import {
  isRetryableModelFailure,
} from "../dist/app/panel-server/research/research-model.js";

/**
 * 传输抖动的重试判定（研究能力的最小不变量验证）。
 *
 * 保护的事实：一次瞬时连接失败不该让整项研究在起步阶段失败，但确定性的
 * 失败（配置、鉴权、限流、输出不合规）不能重试——重试只会白耗一次额度。
 */

test("transient transport failures are retryable", () => {
  // 适配层把连接错误归为 provider_response，因此这条必须靠消息特征识别。
  assert.equal(isRetryableModelFailure({ kind: "provider_response", message: "Connection error." }), true);
  assert.equal(isRetryableModelFailure({ kind: "provider_response", message: "fetch failed" }), true);
  assert.equal(isRetryableModelFailure({ kind: "provider_response", message: "socket hang up" }), true);
  assert.equal(isRetryableModelFailure({ kind: "provider_response", message: "read ECONNRESET" }), true);
  assert.equal(isRetryableModelFailure({ kind: "provider_response", message: "connect ETIMEDOUT" }), true);
  // 适配层已正确分类时按分类判断，不依赖文案。
  assert.equal(isRetryableModelFailure({ kind: "provider_network", message: "any" }), true);
  assert.equal(isRetryableModelFailure({ kind: "provider_timeout", message: "any" }), true);
});

test("deterministic failures are never retried", () => {
  // 配置、鉴权、限流：重试只会再浪费一次额度。
  assert.equal(isRetryableModelFailure({ kind: "provider_config", message: "missing api key" }), false);
  assert.equal(isRetryableModelFailure({ kind: "provider_auth", message: "unauthorized" }), false);
  assert.equal(isRetryableModelFailure({ kind: "provider_rate_limit", message: "429" }), false);
  assert.equal(isRetryableModelFailure({ kind: "request_validation", message: "bad request" }), false);
  // 内容与输出问题：重试得到同样的结果。
  assert.equal(isRetryableModelFailure({ kind: "content_filtered", message: "blocked" }), false);
  assert.equal(isRetryableModelFailure({ kind: "output_validation", message: "schema mismatch" }), false);
  // 未知/缺失失败事实：保守不重试。
  assert.equal(isRetryableModelFailure(undefined), false);
});

test("non-transport provider_response messages are not retried", () => {
  // 只有传输类特征才重试；其它 provider_response（例如模型返回了非法结构）不重试。
  assert.equal(isRetryableModelFailure({ kind: "provider_response", message: "unexpected tool call" }), false);
  assert.equal(isRetryableModelFailure({ kind: "provider_response", message: "invalid JSON in response" }), false);
});
