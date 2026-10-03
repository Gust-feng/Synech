# ADR 0002：全面接入 pi 的遗留清理（七个切片）

> 状态：Accepted（2026-09-24）
> 日期：2026-09-24
> 关联：ADR 0002（pi 模型目录镜像为能力第一事实源）
> 影响面：能力解析的厂商识别；`ModelMessage` 删除 `protocolExtensions`；协议绑定的失败语义（静默 → 显式）；Session 写入边界归一化；压缩对含图历史的降级语义；`ExecutionEnv` 生命周期；本地 pi-ai patch 削减
> 历史决策：厂商猜测和目录镜像由 ADR 0004/0005 替代；压缩实施以本文 2.5 的 Pi 0.87.1 补记为准。

---

## 1. 背景

在 ADR 0002 把 pi 定为底层事实源之后，仓库里仍留着「当年围着自研 SDK 路径 / pi 半接入状态」写的代码。它们不再匹配现状，且部分是用户可见缺陷。共七项，逐项核实后处理：

| # | 问题 | 核实结论 |
|---|---|---|
| 1 | 厂商识别用 URL 字符串猜（`includes("glm")` / `includes("kimi")` …） | 走网关/反代时 URL 无厂商名 → 落默认档；URL 含别家名会猜错。model id 远比 URL 可靠 |
| 2 | `ModelMessage.protocolExtensions` 整条链路空转 | 字段穿过 5 处、白名单 `persistedModelProtocolExtensions` 与错误类型零消费者、零生产者 |
| 3 | 协议相关三处静默兜底 | `resolveProviderApiKind` 三元、payload transformer 的 `return payload`、tool 序列化 api 白名单——未来加第 3 种协议时全部静默降级 |
| 4 | `Session` Proxy 剔除 `addedToolNames` | 传输层字段被写进 JSONL 转录，用 Proxy 在读取侧擦 |
| 5 | 视觉模型 + 含图历史触发压缩 → 整个 run 失败 | 上游 pi 至今无 image-aware compaction（`compaction.js` 只给估算加 4800 字符/图，`prepareCompaction` 原样送图进 summarizer） |
| 6 | `ExecutionEnv` 构造方式不一致 | 研究 loop 每轮 new + cleanup；另两处长期/每 run new。且全仓无 `env.exec` 调用（命令执行是 tool-center 自研） |
| 7 | 对 pi-ai 的 780 行本地 patch | fork 上游 dist；其中 reasoning-details 签名编解码的唯一消费方就是第 2 条的死链路 |

## 2. 决策与实施

### 2.1 厂商识别改为「model id 优先、URL 兜底」，单一实现

新增 `src/domain/config/provider-profile-detection.ts` 的 `detectProviderProfileId({ model, baseUrl, profileId, label })`；`openai-compatible-chat-protocol.ts` 的 `inferProviderProfileId` 与 `model-capability-resolution.ts` 的 `providerProtocolProfileIdFor` 都改为调用它，重复逻辑删除。判定顺序：model id 关键词（kimi/k2/k3→moonshot、glm/z-ai/zai→glm、minimax→minimax、deepseek→deepseek、gpt-/o3/o4/chatgpt→openai）→ 原有 URL/标签规则兜底 → `openai_compatible`。`ProviderProtocolProfileId` 联合不变。

**行为变化**：「URL 属 A 厂商而 model 属 B 厂商」的组合，结果由 A 变 B——这是意图（模型 id 才是模型属于谁的事实）。验收脚本 22/22 通过，`test:core` 139/139 无回归。

### 2.2 删除 `protocolExtensions` 空转脚手架

删除 `src/domain/intelligence/persisted-protocol-extensions.ts`（144 行）、`ModelMessage.protocolExtensions` 字段、5 处传递/检查。删除前全仓确认零生产者零消费者。跨协议续接由 pi Session 自行持有 provider 原生消息，不需要产品层白名单。

### 2.3 协议绑定改为显式失败（为第 3 种协议铺路）

- `resolveProviderApiKind` → `Record<ModelProtocolKind, api>` 穷尽表，缺键即编译失败；
- payload transformer 的未知 api 分支从 `return payload` 改为抛错（错误信息带期望 api 与实际 api）；
- 新增**构造期**校验：`selectedModel.api` 与 binding 期望不一致时在 provider 构造期失败，不留到请求期；
- 工具定义序列化：新增 `toolDefinitionSerializationApiForProtocol`（穷尽 switch + never 断言），`serializeModelVisibleToolDefinitions` 与 `validCostGate` 对未知 api 显式抛错，不再静默走 responses 分支或静默 `false`；
- `run-tool-visibility-policy.ts` 与 `harness-event-projector.ts` 的 api 推断同样改为穷尽/显式失败。

原则：**漏配必须响，不能静默降级**。`harness-event-projector.ts` 的抛错位于观测边界（外层 try/catch 明确「观测不得影响请求」），实际不可达——构造期已校验。

### 2.4 `addedToolNames` 改为写入边界归一化

`TranscriptNormalizingSession extends Session` 覆写 `appendMessage`，在消息进入持久化 Session 前剥离 `addedToolNames`；删除原 Proxy、运行期台账与读侧过滤。与委托 Session 共享同一 storage，写屏障/世代租约语义不变。`tool-result-transport.ts`、`tool-visibility-session.ts` 零改动——`addedToolNames` 仍通过 `AgentToolResult` 上报 harness，渐进可见性外部行为不变。

**取舍**：pi-ai 目录里 moonshot 模型带 `compat.deferredToolsMode:"kimi"`（pi 原生 deferred tools）。剥离后 Kimi 的「激活工具以 load-point system message 注入」不再发生，改由顶层 `tools` 投递（工具可用性不变，payload 位置不同）。旧实现对**上一个 run**的标记本来就剥离，即 Kimi 原生延迟加载回放从来只在单 run 内生效、跨 run 本就不一致；新实现使其统一。若未来要恢复 Kimi 原生协议，需要重新决策「转录里保留传输层字段」。

### 2.5 含图压缩归还 Pi 原生机制

早期实现曾维护自定义占位降级与 `replacedImageBlocks`。Pi 0.87.1 接入后，请求边界压缩、替换计数及对应的检查点/事件/面板字段已移除，不能把历史方案描述为当前行为。

Pi 的 `generateSummaryWithRequest` 与 `generateTurnPrefixSummary` 将 `convertToLlm` 的结果交给 `serializeConversation`，再构造仅含文本的摘要请求。Synech 沿用该原生机制，不额外重写含图历史或自产压缩结果。`transform_context` 中的非视觉模型图片占位是普通请求输入政策，不是压缩中的图片替换机制。

### 2.6 `ExecutionEnv` 收敛为按 root 共享

`panel-host.ts` 新增按 root 缓存的共享工厂，研究 loop 与普通 run 改为注入共享实例；`releaseAgentSessionStorage` 语义从「释放会话存储 env」扩大为「释放全部共享 env」，仍接在 `request-handler.ts` 既有关闭路径。共享处注释明确：**Synech 有意不使用 `ExecutionEnv` 的 Shell 部分**（`env.exec` 全仓无调用），命令执行由 tool-center 自掌。

生命周期风险：共享 Map 按 root 增长（`NodeExecutionEnv` 无状态、`cleanup()` 为 no-op，暂无实际泄漏）；若 workspace 规模变大需引入 root 级引用计数。

### 2.7 削减本地 pi-ai patch

移除 `openai-reasoning-details:` 签名编解码（唯一消费方即 2.2 的死链路；全仓无人读 `signature`）。patch 780 → 693 行，`pnpm-lock.yaml` 的 patch hash 同步更新。保留四项：`stream?:boolean` 非流式、`normalizeCumulativeDeltas?`（MiniMax 累积快照）、`provider_refusal` 诊断、Responses 非流式 + providerMetadata。

**其余四项为何仍必须 patch**：它们都是产品行为契约对上游钩子的依赖（非流式仍须产出同一 event contract；累积快照需后缀差分；拒答须成为结构化诊断并收敛 error 终态；重放需要 providerMetadata）。上游 0.80.10 没有对应选项/导出。

**上游化路径**：建议优先推 `normalizeCumulativeDeltas` compat 开关、`provider_refusal` 诊断类型与 `appendAssistantMessageDiagnostic` 导出、Responses 非流式 + providerMetadata——都是通用 provider 兼容能力，可拆独立小 PR。patch 中每项保持独立 hunk 结构，便于逐项退役。

已知不彻底处：两个 `.map` 的 `mappings` 未重算（dev-time 辅助，Electron 主进程未启用 source-map 支持，src 无消费者）；原 patch 的 `index` 哈希本就与实际文件不符。彻底干净需等上游发布对应版本后整块替换。

## 3. 验证

七项各自完成后按仓库验证清单执行（`check:baseline` / `typecheck:panel` / `build:panel` / `check:whitespace`）+ `pnpm test:core` **139/139**；合并后复跑同样全绿。逐项行为验证：

- 厂商识别：22/22 用例（含网关 URL + kimi model、大小写与点号变体、URL 兜底不回归）；
- `addedToolNames`：e2e 临时脚本（真实 `createAgentSessionLoop` + 假 provider 流，三轮 McpLoad→调用→收尾）证明转录与 `buildContext` 不含该字段，且激活链路完好；并对旧代码做反向证明（旧代码确有 1 条带字段的落库）；
- 含图压缩：视觉/纯文本/无图三种会话均 `compacted`，计数 3/3/0，summarizer 输入不含原始图片数据，面板文案正确。

依据仓库测试做减法原则，未新增常驻测试（均属收敛/降级语义，且 139 项核心测试全绿）。**建议后续权衡**：2.4 的「转录无传输层字段」与 2.5 的「含图降级不失败」是两条长期不变量，值得各补一个最小场景测试。

## 4. 后续待办（本 ADR 未做，需单独决策）

1. `session_before_compact` 取消钩子（`harness-event-projector.ts:134`、`delegated-agent-runner.ts:345`）在准备含图时仍返回 `cancel`，与 2.5 的降级语义不一致——src 内无人调用 `harness.compact()`，属防御性代码，建议统一为占位降级。
2. transcript read-model 的 compaction 节点 DTO 不带 `replacedImageBlocks`（面板 DTO 扩展，超出本次范围）；目前只有活动流可见降级计数。
3. Kimi 原生 deferred tools 的取舍见 2.4。
4. patch 上游化（2.7 的三项 + 非流式语义需上游认可）。
5. 协议扩展（Anthropic Messages）仍待独立 ADR；2.3 已把坑填上。

---

## 9. 追加切片（2026-09-27）：reasoning 控制交给 pi

### 决策

Chat Completions 的推理控制原本是**双写**：`model-provider-binding.ts` 已按厂商设置 pi 的 `compat.thinkingFormat`，同时 `openai-compatible-chat-protocol.ts` 又在 payload 里自己写一遍 `reasoning_effort` / `thinking`（自研方言层 125 行）。Responses 路径本来就全量委托 pi（`reasoning.effort` 由 pi 按 map 写），Chat 路径在补票。

新分工：

- **pi**：把档位翻译成厂商字段（compat 的 thinkingFormat + 模型的 `thinkingLevelMap`），并 clamp 模型不支持的档位；
- **应用**：只决定「请求哪个档位」（`chatCompletionsThinkingLevel`），以及 pi 没有 format 的少量字段（kimi-k3 的两字段、minimax 的 `reasoning_split`、以及 moonshot/deepseek 的 temperature·tool_choice 风险策略）。

第五个镜像字段 `thinkingLevelMap` 由 pi 目录供给（`model-capability-definitions.generated.ts`）。

### 为什么必须同时给 map

不填 `thinkingLevelMap` 时，pi 的 `clampThinkingLevel` 认为 `xhigh`/`max` 不受支持，会把 `xhigh` 静默压成 `high`——自研层写的 `xhigh` 虽然能出去，但一旦委托就丢。填上目录里的 map 后档位语义由上游保证。

### 验证（逐字段比对真实出网请求体）

临时验证台（未入库）对 5 家厂商 × 5 个档位共 25 个用例，抓取经 `fetch` 发出的最终请求体，重构前后一致，除两处有意变更：

| 位置 | 之前 | 之后 | 判定 |
|---|---|---|---|
| openai 关推理 | 不发 `reasoning_effort` | 发 `reasoning_effort:"none"` | 采纳：显式关闭，否则走 provider 默认档，"关闭推理"可能不生效 |
| glm 开推理 | `thinking:{type:"enabled"}` | `thinking:{type:"enabled",clear_thinking:false}` | 采纳：`clear_thinking` 是 pi 为 z.ai 设置的 compat 字段，自研层原先把它擦掉了 |
| deepseek / minimax / moonshot(kimi-k3) | — | — | 完全一致 |

### 保留的自研部分（pi 无对应物）

`kimi_k3_reasoning_effort`（pi 没有 Kimi thinking format，两字段显式写）、`reasoning_split`（minimax 独有）、`applyOpenAICompatibleChatRequestPolicy` 的 temperature/tool_choice 风险策略。

---

## 10. 追加切片（2026-09-27）：移除 pi-ai 本地补丁，拒答与拒绝改为如实分类

### 决策

删除对 `@earendil-works/pi-ai` 的全部本地补丁（`patches/` 与 `pnpm-workspace.yaml` 登记、lockfile 一并移除），pi-ai 回到上游原版。原补丁提供的 4 项能力分别处置：

| 补丁能力 | 处置 | 理由 |
|---|---|---|
| `stream?: boolean`（非流式） | **删除**，连同 `OpenAIModelRequestSettings.stream` 与 config/解析/装配三处引用 | 统一只走 pi 的流式事件契约。该开关无 UI 暴露、无任何预设使用（纯潜伏字段），`supportsStreaming` 能力位也没有任何决策消费方 |
| `normalizeCumulativeDeltas`（MiniMax 累积快照差分） | **删除** | 仓库内零证据（无注释、无测试、无复现记录）支撑「MiniMax 发累积快照」这一假设。若复现，正确位置是上游 PR 或应用侧投影层，不是 pi 的 dist |
| `provider_refusal` 诊断 | **删除**，改为自有分类 | 上游 pi 原生完全没有拒答感知（`StopReason` 无 contentFilter、无 providerMetadata），补丁是在替上游补感知。改由我们自己的失败分类完成 |
| Responses 非流式 + `providerMetadata` | **删除** | 同上；`incompleteReason` 读取随补丁一起移除 |

### 「如实回应」由分类层承担

`provider-result-projection.ts` 保留自有的响应体结构化码提取（`structuredProviderErrorCode`：SDK 把 code 放在 body 里而非错误对象上），失败分类新增两类确定性归属：

- `REQUEST_REJECTED_CODES`（`unsupported_parameter` / `unsupported_model` / `model_not_found` / `unsupported_country_region` / `invalid_request_error` 等）→ `request_validation`，文案「该模型或其端点不接受这个请求（参数、模型或区域不受支持），请检查模型配置。」
- `content_filter` 一系 → `content_filtered`，文案「模型按内容策略拒绝了该请求，请调整输入内容后重试。」

200 形态的拒答（上游报 `stop`、内容为空）无法与「模型真的没话说」区分，新增 `assistantAnswerIsEmpty`：此时明确返回 `model_refusal` 与「The model returned no content; it may have refused the request on content-policy grounds.」，不再落进通用失败。

### 后果与验证

- pi-ai `node_modules` 已回到上游原版（三个补丁特征计数均为 0）。
- `pnpm typecheck:panel` / `tsc -p tsconfig.json` / `check:baseline` / `check:whitespace` 全部通过，`test:core` **106/106**。
- **已知代价**：非流式端点不再被支持（没有这样的端点在用）；MiniMax 若真的发累积快照，会出现文本重复（待复现再处理，且不该用补丁）。
- 未动的死角（汇报给 owner）：`supportsStreaming` 能力位仍存在于能力契约与持久化 run 文档 zod 中，但已无任何决策消费方；删除它要改持久化 schema，本次不做。

### 修正（同日）：API 原文优先，我们只做兜底

上条落实时把方向搞反了——`friendlyUserFacingModelFailureText` 原先只有 `provider_response` 一种会显示 API 原文，**其余类型一律用我们自编的分类文案顶掉 API 的报错**。这是自作主张：用户看到的是「模型服务响应异常」之类，而不是厂商真实说了什么。

已改为：**API 返回什么就显示什么**，分类文案只在该内容缺失时兜底。

```text
显示优先级：API 原文（经可见文本净化与截断） → 该分类的兜底短语 → 「没有返回可用结果。」
```

同时删掉本轮自己加的臆断措辞：`content_filtered` / `request_validation` 的文案不再附「请调整输入内容」「参数、模型或区域不受支持」这类我们无法验证的解释；空回答也不再猜测「可能因内容策略拒绝」，只陈述「模型没有返回内容」（`empty_model_answer`）。

判据：分类只负责决定**是否可重试**与**兜底措辞**，不负责改写厂商的原话。

### 再修正（同日）：删掉零影响的分类清单与文案改写

按「不预设、不编造」的标准复查上一轮自己加的东西，发现三类是纯装饰：

| 删掉的东西 | 为什么它是多余的 |
|---|---|
| `REQUEST_REJECTED_CODES` → `request_validation` | 重试判定只认 network / timeout / rate_limit；`request_validation` 与兜底 `provider_response` 一样都不重试，行为完全相同 |
| `CONTEXT_OVERFLOW_CODES` → `context_overflow` | 同上，且真实的上下文超长由 pi 的 `isContextOverflow` 在投影层判定 |
| `friendlyFailureCopy` 把 SDK 的 `429 status code (no body)` 改写成 `HTTP 429` | 纯改写，厂商/SDK 说什么就显示什么 |

保留 `ACCOUNT_EXHAUSTION_CODES`：它是唯一真正影响行为的清单——把 429 里的「欠费」从「限流」中摘出来，否则用户要白等三次退避才看到真实的欠费原因。

现状：失败分类只剩「是否可重试」这一个程序判断，用户可见文本一律来自厂商原文（无原文则留空）。
