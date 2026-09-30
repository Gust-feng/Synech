# ADR 0005：模型协议 Adapter（piProviderId 匹配与连接级 transport）

> 状态：Accepted（2026-09-28）
> 日期：2026-09-28
> 关联：ADR 0004（模型事实二态：KnownPiModel / UnknownDiscoveredModel）；ADR 0002（其 §9「thinkingLevelMap 镜像链路」表述由本 ADR 与 0004 修正）
> 影响面：模型 provider binding 构造、连接配置契约（`piProviderId`）、transport 选择、HTTP 配置解析

---

## 1. 背景

ADR 0004 冻结了模型事实二态，但仍需一条明确规则回答：模型的 transport 从哪来、在哪个 provider 作用域内匹配。

此前实现里，协议是**每模型/每连接的用户选择**（`protocolKind` 设置项），配合 Synech 自研的 compat 方言层（compat 五分支表、固定推理档位链）。由此产生三个问题：

- transport 与模型事实可能矛盾：连接选了 chat completions，而 Pi 该模型的真实 api 是 responses；
- 厂商作用域靠猜：`provider-profile-detection.ts` 按 model id 关键词和 URL 猜 vendor，网关/反代场景必然猜错；
- 匹配范围过大：跨 Pi Provider 取第一条同名模型时，同一模型 ID 在不同 provider 下的事实会互相串用。

## 2. 决策

### 2.1 `piProviderId` 是连接级显式可选字段

- 预置映射：`openai→openai`、`deepseek→deepseek`、`moonshot→moonshotai-cn`、`glm→zai-coding-cn`；
- `minimax` 家族映射到 pi 的 `minimax` / `minimax-cn`：pi 目录的 api 是 `anthropic-messages`，由 Anthropic Messages transport 接入，不为它另开 OpenAI 兼容特判；
- 留空（含通用 OpenAI 兼容端点）= 该连接的全部模型按未知发现模型处理；
- HTTP 层以条件键输出 `piProviderId` / `clearPiProviderId`（`parseConfigUpdate`），未提交的字段不被静默清空。

### 2.2 同一模型 ID 按明确的 `piProviderId` 匹配

`builtinModels().getModel(piProviderId, modelId)` 只在显式命名的 provider 作用域内做 `model.id === modelId` 精确比较：不做模糊匹配、不按 model id 猜厂商、不在多个 Pi Provider 中取第一条同名模型。因此同一模型 ID 在不同 Pi Provider 下的事实不会互相串用。

### 2.3 协议不再作为每模型用户选择

- 已知模型的 transport 由真实 Pi Model.api 决定；
- 未知模型使用连接级默认 transport；
- 已知模型 api 与连接 `protocolKind` 不一致时**以 Pi api 为准**；
- Pi api 是 Synech 没有的 transport（如 `bedrock-converse-stream`、`google-generative-ai`）时，binding **构造期显式失败**，不留到请求期；
- Anthropic Messages transport 不套用 OpenAI 方言层的 payload 字段策略：pi 直接构建 SDK 请求（含 thinking 字段），产品侧没有可覆写的明文 payload；
- 产品内建 Web Search 只在 Responses transport 上有对应物；连接落到 Anthropic Messages 时启用该开关必须显式失败，不静默丢弃。

### 2.4 Synech 边界 DTO 只能是运行时投影

`src/domain/config` 的 `ConfirmedModelFacts` / `UnconfirmedModelFacts` 不得出现 pi 类型；pi 事实由 `src/adapters/intelligence` 解析后投影到 domain。构建期镜像、生成脚本、手工能力表不再存在（ADR 0004 §2.7）。

### 2.5 兼容参数与运行方式

已知模型的 compat（如 thinkingFormat）、`thinkingLevelMap`、`reasoning` 由真实 Model 供给；Synech 只保留 pi 无对应物的少量字段策略（kimi-k3 的两字段、minimax 的 `reasoning_split`、moonshot/deepseek 的 temperature 与 tool_choice 风险策略）。compat 五分支表与固定推理档位链已删除——它们是 Synech 自维护的第二份协议方言事实。

## 3. 失败语义

| 情况 | 行为 |
| --- | --- |
| 已知模型 api 是 Synech 没有的 transport | binding 构造期显式失败（错误信息带模型 api 与期望 transport） |
| `piProviderId` 留空 | 全部模型按未知发现模型处理，用连接级默认 transport 原样发送 |
| `piProviderId` 声明但模型未命中 | 未知发现模型，同上 |
| 已知模型 api 与连接 protocolKind 不一致 | 以 Pi api 为准，不按用户选择的 protocol 改写模型事实 |
| 未知模型发送推理档位/图片 | 档位请求不被能力拒绝（ADR 0004 §2.6）；图片不发送（视觉未确认） |

## 4. 后果与备选

**正面**：transport 与模型事实不再可能矛盾；匹配范围由显式声明收敛，可对账；删除方言层后，上游 compat 更新直接生效。

**负面 / 风险**：用户为连接选错 `piProviderId` 时，已知模型会被整体降级为未知发现模型（显式而非猜测失败）；Synech 的 transport 白名单（`openai-completions`、`openai-responses`、`anthropic-messages`）之外的上游 api 需要显式扩展，不存在"顺手支持"。

**备选（不采用）**

| 方案 | 不采用的原因 |
| --- | --- |
| 保留每模型 transport 用户选择 | transport 与模型事实双源，用户选择与 Pi 真实 api 可能矛盾 |
| 按 URL 或 model id 猜 provider | ADR 0002 已实证网关场景猜错；显式 `piProviderId` 才是可对账事实 |
| 跨 Provider 取第一条同名模型 | 同一模型 ID 在不同 provider 下的事实互相串用，无法归因 |

## 5. 验证

- `pnpm check:baseline`、`pnpm check:whitespace`、`git diff --check` 通过；
- 行为核对（实现切片已落地）：预置连接按映射命中真实 Pi Model 并以 Pi api 构造 provider；未知 transport api 在 binding 构造期失败；`piProviderId` 经 HTTP 更新与清空语义一致（条件键输出）。
