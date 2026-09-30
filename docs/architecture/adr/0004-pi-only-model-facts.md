# ADR 0004：模型事实以 Pi 为唯一事实源（pi-only model facts）

> 状态：Accepted（2026-09-28）
> 日期：2026-09-28
> 关联：ADR 0001（其「pi 生成目录镜像」决策由本 ADR 作废，见该文首注记）；ADR 0005（模型协议 Adapter：`piProviderId` 匹配、连接级 transport 与构造期失败）；ADR 0003（Agent Runtime Provider 边界）
> 影响面：`src/domain/config` 事实契约、`src/adapters/intelligence` 解析与 binding、`src/app/model-runtime` 能力解析、运行开始准入、模型设置面板投影

---

## 1. 背景

### 1.1 已冻结的产品方向

用户指定的模型链路分工：

- **远程模型接口 `/models`**：负责发现和展示当前连接可用的模型 ID；
- **Pi**：负责已知模型的模型语义、能力、协议、transport、兼容参数和运行方式；
- **Synech**：负责连接配置、产品展示、工具权限、审批、账本、取消、恢复和产品运行语义。

### 1.2 此前的实现及其问题

ADR 0001 落地的链路是「构建期 pi 目录镜像 + 手工差异登记 + 协议基线兜底 + 用户覆写」。它在方向上确认了「pi 值优先于本地猜测」，但实现形态产生了新的问题：

- 镜像文件（`model-capability-definitions.generated.ts`）是构建期快照，与运行时实际安装的 `@earendil-works/pi-ai` 构成第二事实源；漏重跑生成即产生无法对账的静默漂移；
- 手工层与镜像层长期并存，同一能力两个来源，必须逐条「收编」才敢改动，收敛成本随时间累积；
- 厂商识别按 model id 关键词和 URL 猜测（`provider-profile-detection.ts`），走网关/反代时必然猜错；
- 未知模型落到粗糙协议基线（ctx 256K / 不支持工具调用），把「Synech 不知道」伪装成「模型不支持」；
- compat 五分支表与固定推理档位链是 Synech 自维护的第二份协议方言事实。

## 2. 决策

### 2.1 远程发现模型 ID

远程 `/models` 只负责发现：远程返回什么模型 ID 就正常保留和展示什么。`modelCatalogs` 是纯发现缓存，不是能力事实源；保存远程目录不改变目录外已配置的模型 ID。

### 2.2 Pi 增强已知模型语义

「已知模型」= 模型 ID 在**连接显式声明的 `piProviderId`** 作用域内被 pi-ai 真实 catalog 精确命中。命中后，真实 `Model<Api>` 的能力、协议、transport、兼容参数和运行方式就是运行事实；Synech 只覆盖连接事实（provider 注册键、baseUrl、auth），不得改写能力字段。匹配规则（精确匹配、不猜厂商）由 ADR 0005 冻结。

### 2.3 未知模型使用连接级默认 transport

Pi 不识别的模型：正常展示，允许选择、保存和发送；按连接级默认 transport 把模型 ID 原样发给上游，请求是否成功由真实上游决定。不得显示「匹配失败」、不得被 UI 过滤、不得在运行开始阶段被 `model_not_in_pi_catalog` 拦截。

### 2.4 Synech 不猜测未知模型能力

不得伪造 `contextWindow` / `maxOutputTokens` / `supportsVisionInput` / `supportsReasoningOutput` / 推理档位 / compat；不做模糊匹配、不按模型 ID 猜厂商、不在多个 Pi Provider 中取第一条同名模型；同一模型 ID 按明确的 `piProviderId` 匹配。

### 2.5 二态边界：KnownPiModel / UnknownDiscoveredModel

Adapter 是唯一允许出现 pi 类型的位置；产品层契约无任何 pi 类型：

| 层 | 已知 | 未知 |
| --- | --- | --- |
| Adapter 内部 | `KnownPiModel`：持真实 `Model<Api>` | `UnknownDiscoveredModel`：零能力字段 |
| 产品层契约 | `ConfirmedModelFacts`：逐字段真实投影 | `UnconfirmedModelFacts = { status: "unconfirmed", modelId }` |

- 产品层 DTO 只能是运行时投影；不得把投影反向持久化为第二份事实。
- 构造 pi provider 所需的占位常量（未知模型的 contextWindow / maxOutputTokens）只存在于 Adapter 内部，绝不得外溢到产品层 DTO / UI；产品层的「未确认」投影不携带任何数字。
- 已知/未知不得合并为同一伪造事实类型。

### 2.6 失败与行为语义

| 情况 | 行为 |
| --- | --- |
| 未知模型运行开始 | 一律放行 |
| 推理档位请求与已确认能力矛盾 | 仅此时以 `unsupported_model_reasoning_effort` 拒绝；未确认模型不得据此被阻断 |
| 视觉输入未确认 | 不发送图片 |
| 压缩阈值未确认 | 不触发压缩判断 |
| 工具调用能力 | 按协议层事实推导，模型层不持有第二份工具调用事实 |
| 用户覆写 | 用户自有事实源；生效口径为「覆写 > Pi 确认 > 未确认」。未确认模型的能力只能由用户显式覆写声明，Synech 不猜测 |

### 2.7 删除镜像链

删除以下全部内容：`model-capability-definitions.generated.ts`、`scripts/generate-model-capabilities.mjs`、手工能力表 `model-capability-definitions.ts`、`provider-profile-detection.ts`（按 model id/URL 猜厂商）、compat 五分支表与固定推理档位链。能力事实的唯一运行时来源 = pi-ai 真实 catalog（已知模型）+ 未确认（无事实）。

用户能力覆写层（`ModelCapabilityOverrideValues` / `ModelCapabilityOverrideSettings` / `modelCapabilityOverrides`）与固定推理档位表（`low/medium/high`）同属第二事实源，正在移除；覆写相关类型当前为过渡保留，新代码不得读取，UI 不得再提供能力编辑入口。运行级推理档位直接派生自 Pi 档位名并排除 `off`，产品不维护自己的档位集合。

## 3. 后果

**正面**

- 能力事实单源：运行事实与运行时安装的 pi-ai 严格一致，不存在构建期快照漂移；
- 未知模型不再被惩罚：不显示「匹配失败」、不被过滤、不阻断运行，请求成败由真实上游决定；
- 「Synech 不知道」不再被伪装成「模型不支持」，未确认状态在 DTO 中如实存在；
- pi-ai 升级即能力事实更新，传播路径唯一且可对账。

**负面 / 风险**

- 未确认模型在压缩阈值、视觉、推理档位上没有事实，相关行为降级为「不做」而非「做错」；需要能力时应由上游 Pi 目录补充该模型，而不是在 Synech 侧声明；
- pi 目录本身若错，修正路径是上游 PR 或用户覆写，本地不得重新引入自建表（那会重新制造漂移）；
- 上游新增 provider 或 api 时，Synech 的服务范围需要显式扩展（transport 白名单），不存在「顺手支持」。

## 4. 备选方案（已评估，不采用）

| 方案 | 不采用的原因 |
| --- | --- |
| 保留构建期镜像作为「过渡投影」 | 过渡投影会长期存留：只要有这条路径，能力事实就有第二个来源，漂移与「哪份生效」的歧义延续，违背单一事实源 |
| 运行期直接 import pi 的 `models.generated.js` | 与镜像等价，只是把第二事实源从构建期搬到运行期 |
| 保留手工表作为未知模型兜底 | 把猜测伪装成事实；未知模型的正确承诺是「未确认」，不是粗糙基线 |
| 保留按 id/URL 猜厂商 | ADR 0002 已实证网关场景猜错；猜测结果无法与用户显式声明对账 |
| 保留协议基线兜底表 | 同上，且它是「未知 = 不支持工具调用」这一错误行为的来源 |

## 5. 验证

- `pnpm check:baseline`、`pnpm check:whitespace`、`git diff --check` 通过；
- 行为核对（实现切片已落地）：未知模型可保存、可发送，运行开始无 `model_not_in_pi_catalog` 拦截；已确认模型的 contextWindow / maxTokens / thinkingLevels 与 pi-ai 真实 catalog 逐字段一致；未确认模型的边界 DTO 只含 `status` 与 `modelId`。
