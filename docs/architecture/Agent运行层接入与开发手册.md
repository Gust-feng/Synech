# Agent 运行层接入与开发手册

> 状态：Accepted design baseline
> 适用范围：Synech 的 Agent 运行机制、产品运行语义、pi-agent 接入和后续运行时升级
> 当前实现状态：已有 AgentLoop/ToolCenter 产品抽象；边界收口和 Pi Adapter 重构尚未完成
> 配套决策：`docs/architecture/adr/0003-agent-runtime-provider-boundary.md`

本文是 Synech Agent 运行层的长期开发手册。它规定产品层、运行时提供者和接入适配器之间的责任边界，并约束后续 Agent 开发、升级和迁移。

Synech 已经拥有一层可用的产品侧运行抽象，主要包括 `AgentLoop`、`AgentLoopInput/Result`、`ToolExecutionGateway`、`ToolCallRequest/Result` 和 Ordinary execution port。本次工作不是再造第二套完整 Agent Runtime，也不是默认推倒这些抽象，而是审查并收紧它们：保留已经稳定的产品语义，替换被 pi Session、entry identity、事件和恢复机制污染的部分。

本文不是 pi-agent 的使用说明，也不是当前代码状态的逐行描述。标为“目标”或“必须”的内容是后续实现应收敛到的架构约束；标为“当前遗留”或“尚未完成”的内容不能被误认为已经实现。

## 1. 背景与目标

Synech 的 Agent 底座经历了以下演进：

```text
早期自研 Agent
  → OpenAI SDK
  → pi-agent
  → Synech Agent Runtime Boundary
```

Provider 协议、流式输出、工具调用、上下文、重试、压缩和会话恢复等基础机制交给成熟的 pi-agent 是合理方向。但 pi 的对象模型不能直接成为 Synech 的产品模型。

目标是：

```text
复用 pi 的运行机制
隔离 pi 的实现模型
保留 Synech 的产品语义
降低后续上游升级影响
```

这不是重新实现一个 Agent，也不是把 pi 的全部能力复制到 Synech。Synech 已有的运行抽象是候选 Product Runtime Contract；pi-agent 是当前的一种实现，Adapter 负责翻译两套模型。只有现有契约无法通过收紧完成隔离时，才进行局部替换，不整体重写。

### 1.1 非目标

- 不重新实现 Provider 协议和厂商 wire 差异。
- 不重新实现通用 Agent Loop、上下文压缩或 Provider retry。
- 不复制一套完整的 pi Session 状态机。
- 不设计支持所有未来 Agent 框架的巨大通用接口。
- 不为了兼容未发布开发数据增加启动时隐式迁移或自动修复。
- 不把 pi 的所有高级能力都暴露为 Synech 公共能力。
- 不因为本次边界重构顺手接入遥测、会话分叉或 pi 技能系统。

### 1.2 对 pi 版本变化的判断

当前没有足够证据断言 pi 官方将 `0.80.10 → 0.87.1` 明确命名为一次“重构版本”。但从实际接口和实现边界看，这次已经构成 Agent Runtime 的架构代际变化：

- `AgentHarness` 从直接运行对象变为 `AgentHarness.create(...)`。
- 具体运行从 harness 方法变为 `harness → lane → operation`。
- `Context` 成为取消、超时和后台任务传播的显式参数。
- Hooks、events、tool execution 和 operation result 重新划分。
- Session 从旧的 leaf/storage 操作转为 commit、value、list、usage 和 operation 状态模型。
- JSONL 会话格式和旧条目导入策略发生变化。

因此，Synech 是否继续使用 pi，不取决于上游如何命名版本；只要上游内部模型可能变化，Synech 就必须通过 Provider Boundary 隔离它。

## 2. 两条责任线

两条责任线可以通过 Adapter 交互，但不能共用一个产品状态机。

### 2.1 Pi Runtime Mechanism

pi-agent 负责：

- Provider 请求和协议差异；
- 流式模型输出；
- 普通 Agent 循环；
- 模型工具调度；
- Context 构建；
- 阈值判断和上下文压缩；
- 普通 Agent 运行的 Provider retry；
- pi transcript Session；
- lane、operation 和底层运行恢复；
- Provider 用量采集；
- pi 内部写入串行和 commit。

### 2.2 Synech Product Runtime Semantics

Synech 负责：

- Conversation、Space、Workspace 的 owner 关系；
- Run admission；
- 哪个用户、哪个 Conversation 发起运行；
- 工具授权、审批、审计和证据；
- ToolCenter 执行和 ToolCallResult 事实；
- 用户取消的产品含义；
- 运行账本和终态收敛；
- 产品 checkpoint 和恢复许可；
- Memory、Skill、Knowledge、Space 等产品能力；
- Panel 活动流、Conversation 投影和用户可见错误。

pi 可以决定“模型如何运行”，但不能决定运行属于谁、工具是否允许、用户是否批准、结果是否进入产品账本或哪个状态是产品恢复点。

## 3. 依赖方向与目录边界

目标依赖方向固定为：

```text
Panel / Product Feature
        ↓
Synech Agent Runtime Port
        ↓
Pi Agent Adapter
        ↓
pi-agent-core / pi-ai
```

产品层只能依赖 Synech 自己的 Runtime Port、事件、工具权限和运行结果契约。以下内容不得进入 `src/app`、`src/domain`、Panel API、Panel UI 或产品状态类型：

- `AgentHarness`、`AgentLane`、pi `Session`、pi `Context`；
- `HarnessEvent`、`OperationResultRecord`；
- pi 的 `entryId`、`tipId`、`operationId`、`usageId`；
- pi 专属工具执行函数签名；
- pi 的 retry state、compaction preparation、provider payload。

Pi 专属实现应逐步收口到专门目录，例如：

```text
src/adapters/intelligence/pi-agent/
```

只有该 Adapter 可以依赖 pi 类型。模型事实**不存在构建期镜像**：已知模型的能力、协议与 transport 由 Pi Adapter 在 pi-ai 真实 catalog 中按连接显式声明的 `piProviderId` 精确匹配后取得（见 `adr/0004-pi-only-model-facts.md`）；产品层只接收无 pi 类型的二态投影（`ConfirmedModelFacts` / `UnconfirmedModelFacts`）。任何"生成一份目录快照"的做法都会重新制造第二事实源，已删除，不得回退。

当前 `src/adapters/intelligence` 下仍有运行循环、Session repository、Harness event projector 和工具可见性代码直接依赖 pi。它们是迁移对象，不是目标边界。升级探针中的半完成 0.87 迁移不得直接合并到 `main`。

## 4. 现有抽象的保留与替换策略

### 4.1 保留的产品语义

以下抽象已有明确的 Synech 语义，原则上保留并作为后续 Port 的基础：

- `AgentLoop` 的执行、终态和 live-only approval continuation；
- `AgentLoopInput/Result` 中的产品输入、输出和取消语义；
- `AgentLoopToolBoundary`、`ToolExecutionGateway` 和 `ToolPermissionCheck`；
- `ToolCallRequest`、`ToolCallResult` 和 invocation identity acceptance；
- ToolCenter 的权限、审批、证据和大结果 continuation；
- Ordinary execution port、Run Ledger 和终态结算；
- nested agent 的产品授权和结果交付语义。

### 4.2 必须收口或替换的部分

以下内容当前虽然位于产品侧 `model-runtime` 或 Ordinary contract 中，但仍带有 pi 实现语义，是本次重构的重点：

- `AgentSessionEntryRef`、`AgentSessionExecutionRefs` 和 `AgentSessionWriteCheckpoint`；
- 以 Session leaf、assistant entry、tool round leaf 或 compaction entry 表达产品 checkpoint；
- 产品状态通过 pi entry ID 判断恢复、分支和终态；
- 产品层直接依赖 pi Session 的存储与恢复模型；
- 将 pi event ordering 直接当作产品事件契约；
- 将 pi 专属命名带入产品公共接口。

这些内容不要求一次性删除。正确顺序是：定义产品 checkpoint 和产品事件 → 建立映射 → 停止新增 pi identity 依赖 → 迁移旧状态 → 删除旁路。

### 4.3 不新增第二套完整 Runtime

后续 Agent 不得看到本手册后直接创建一个与 `AgentLoop` 并行的 `AgentRuntime`、`RuntimeRunner` 或 `AgentExecutor` 大接口，再把现有调用方全部改过去。先审查现有 `AgentLoop` 是否能承载稳定 Port；只有契约职责无法收口时，才新建窄接口并给出替换理由。

## 5. Synech Agent Runtime Port

中间层不是把 pi 每个方法机械包装一遍，而是只表达 Synech 产品真正需要的稳定能力。它优先从现有 `AgentLoop` 收口，目标形态如下，具体字段以实现切片中的窄契约为准：

```ts
interface AgentRuntimeProvider {
  createRun(input: AgentRuntimeInput): Promise<AgentRuntimeRun>;
}

interface AgentRuntimeRun {
  execute(): Promise<AgentRuntimeOutcome>;
  cancel(input: AgentRuntimeCancel): Promise<void>;
  release(): Promise<void>;
  subscribe(listener: AgentRuntimeEventListener): () => void;
}
```

Port 必须覆盖运行创建、文本/thinking 增量、工具请求与进度、工具结果、approval-required、压缩观察、retry 观察、usage 观察、completed/failed/cancelled、产品 checkpoint 和 Adapter 内部 opaque runtime reference。

Port 只使用 Synech 自己的身份：

```text
conversationId
runId
turnId
toolInvocationId
checkpointId
runtimeCheckpointRef
```

`runtimeCheckpointRef` 可以是不透明值。产品层只能保存、传递和比较它是否存在，不能解析其中的 pi ID 或依据其字符串内容分支。

以下能力留在 Adapter 内部，除非未来形成明确产品需求并通过新的架构决策：lane、branch、Session mutation、Pi usage row、Pi retry state、Pi compaction preparation、Pi provider payload、pi 原生遥测、pi 会话分叉和 pi 技能资源协议。

## 6. 身份、Checkpoint 与存储归属

### 6.1 身份分层

Synech 产品身份：

```text
conversationId
runId
turnId
toolInvocationId
checkpointId
```

Pi Adapter 内部身份：

```text
sessionId
lane
entryId
tipId
operationId
usageId
```

两者可以有映射，但产品代码不得解析 pi ID，产品状态不得通过 pi ID 推导业务状态。映射丢失或不一致时必须显式失败，不得猜测、自动修复或静默重建。pi `entryId` 不再作为 Synech 产品稳定身份。

### 6.2 三类 Session 事实

1. **Pi Transcript Session**：为模型上下文、工具调度和上游恢复服务，owner 是 Pi Adapter 与 pi Session backend。
2. **Synech Run Ledger**：记录授权、审批、工具结果接受、取消、终态和产品恢复事实，owner 是 Ordinary 或对应产品运行 owner。
3. **Synech Product Projection**：为 Panel、Conversation 和查询提供稳定投影，owner 是对应 read-model/projection。

三者可以关联，但不能复制成三份完整 transcript。每个长期事实只有一个 owner。

### 6.3 世代栅栏

pi commit queue 只能保证写入串行，不能替代 Synech 的世代语义：撤销某个写入世代后，该世代未完成的写请求不得继续写入。世代撤销是 Synech 的治理与权限不变量，必须继续由 Synech Adapter/Repository 层拥有。

## 6A. 模型事实与模型接入

本节冻结模型侧边界，当前自动匹配与用户设置由 ADR 0010 / 0011 接续 ADR 0004 / 0005。

### 6A.1 三层职责

```text
远程 /models 接口  → 只负责发现当前连接暴露了哪些模型 ID
Pi 真实 catalog   → 自动模型能力默认值、原生运行与 transport 编码
ConfigCenter      → 连接配置与每模型显式用户设置
Synech Adapter    → 有效能力与连接 transport 装配，保留原始上游 ID
```

三者不可互相顶替：远程列表不是能力事实源，Pi 目录不是连接配置源，用户设置不是 Pi 已确认事实。目录刷新不覆盖 `modelSettings`。

### 6A.2 二态事实

原生/显式连接作用域精确匹配；自定义模型自动按完整 ID 匹配，未命中时从左逐段去除路径前缀并精确匹配，最长剩余 ID 优先，保留目录自身命名空间。原厂目录优先，冲突不取第一条，不剥离版本/型号后缀，不提供手动标准模型选择。命中时目录事实逐字段来自真实 `Model<Api>`，未命中时仍为未确认模型。

| | 已知 | 未确认 |
| --- | --- | --- |
| Adapter 内部 | `KnownPiModel`：持真实 `Model<Api>` | `UnknownDiscoveredModel`：零能力字段 |
| 产品层契约 | `ConfirmedModelFacts` | `UnconfirmedModelFacts = { status, modelId }` |
| transport | 原生保持真实 `Model.api`；自定义使用连接协议 | 连接协议，ID 原样发送 |
| 上下文 / 输出上限 / 视觉 / 推理档位 | Pi 默认，可叠加稀疏用户配置 | 上下文默认预算 256K；其余仅显式用户配置 |

已知与未确认不得合并为同一个伪造事实类型。产品层出现 pi 类型即为边界破坏。

### 6A.3 未确认模型的运行口径

- 正常展示、可选择、可保存、可发送；不显示"匹配失败"，不被 UI 过滤，运行开始不得被 `model_not_in_pi_catalog` 拦截；
- 不得伪造已确认的上下文 / 输出上限 / 视觉 / 推理档位 / `compat`；
- 未填写的上下文使用 256,000 tokens 产品预算，UI 明确显示默认值；用户输出上限保持可选。未知 OpenAI-compatible 模型保持 Pi transport 的省略路径；Anthropic Messages 要求请求携带 `max_tokens`，未知模型未配置时使用 4,096 tokens 请求预算，显式设置优先。这些默认值不是模型能力承诺（ADR 0014）；
- 压缩与工具可见性使用当前 run 冻结的有效窗口；用户窗口 > Pi 窗口 > 产品默认预算使用同一口径；
- 不做关键词包含/版本剥离匹配，不在实质冲突的多个 Provider 中取第一条同名模型。

### 6A.4 transport 集合

自定义连接使用配置的 Chat Completions / Responses / Messages transport；目录关联不更换接口或原始模型 ID。同协议才复用目录 compat，不跨协议复制参数。原生服务保持真实 Pi API，不以兼容协议替换。

原生服务接入见 ADR 0008：产品连接声明 `native` 模式，Adapter 按内部 provider 身份复用 Pi factory，保留各模型真实 API、模型专属地址、鉴权、订阅过滤和动态目录刷新。`native` 是产品边界的路由模式，不是新增网络协议。自定义服务仍提供三种兼容连接协议与手动模型 ID；官方模板不要求用户选择底层协议。秘密按连接与认证方式分槽存储，切换认证方式不删除另一槽的凭据；Pi OAuth 刷新复用 ConfigCenter 的串行凭据入口；取消、删除或改变连接身份后，旧登录/刷新不得回写。

生命周期收口见 ADR 0009。交互登录由应用层管理，宿主按实例装配和释放，HTTP 仅负责请求映射。工具渐进可见性只在实际模型有已接入的成本表示时启用，不因 `native` 标签整体禁用；Anthropic 使用真实 `input_schema` 格式。请求前估算不推导缓存/鉴权修饰字段；实际工具统计读取 Pi 已组装的 payload，无法辨识的格式不伪造数值。

### 6A.5 推理档位

产品固定显示低、中、高、极高、最高五档，沿用 Pi 的 `low/medium/high/xhigh/max` 编码，只呈现有效模型支持的子集。原始 Pi 事实保留 `off/minimal`，二者不进入产品选项。用户可在每个连接的每个模型上显式调整集合。UI、工具与运行从同一有效配置派生；具体编码与 clamp 交给 Pi，产品不开放任意请求 JSON 编辑器。

### 6A.6 不得重新引入的结构

- 构建期生成/镜像的模型目录快照及配套脚本；
- 将用户配置冒充 Pi 已确认事实，或把 Pi 全目录默认值复制进设置；
- 每个模型的协议用户选择，以及官方原生模板内的协议用户选择（自定义服务的连接协议独立于模型关联）；
- 将产品五档误当成所有模型都支持，或增加 Synech 自维护的厂商参数编码。

## 7. 工具接入模型

工具流程固定为：

```text
Pi 产生 provider tool call
        ↓
Adapter 转换为 Synech ToolCallRequest
        ↓
Synech owner 接受 invocation identity
        ↓
ToolCenter 做权限、审批、审计和执行
        ↓
Synech 生成 ToolCallResult
        ↓
Adapter 转换为 Pi tool result
```

规则：

- provider call ID 只做外部调用定位；
- invocation ID 由 Synech 生成并由产品账本拥有；
- Pi 不得自行生成 Synech invocation ID；
- Pi active tool set 只是模型输入可见性，不等于产品授权；
- Synech `allowedTools` 是产品授权事实；
- approval-required 不能被 Adapter 吞掉或自动批准；
- 工具结果是否进入账本，由 Synech owner 决定；
- 工具证据、大结果 continuation 和审计仍由 ToolCenter 拥有；
- ToolCenter 的文本结果预算只计算文本 envelope，不把图片等二进制附件的 Base64 当成文本 token；图片输入预算由模型上下文策略负责。live `ToolExecutionResult.modelAttachments` 是显式字段，不附着在 JSON output 的隐藏 Symbol 上；正规化分别处理输出和附件，留存/缩略只替换 `output`，`ReadOutput` 只承接文本证据，不能替代图片投递（ADR 0012）；
- Pi Adapter 在产品回调、最终结果和 Pi tool details 出口显式生成 durable `ToolCallResult`，只保留既有 `modelAttachmentRefs`。图片字节仅写入 Pi Session content，不复制到 Run、Panel、结果留存文件或 details。恢复继续使用引用与 Session 校验，无新 schema、迁移或第二图片存储；
- 附件按需读取和用户图片自动输入共用读取守卫与文件工具的路径锁。owner 引用在锁内复用冻结/当前来源身份及 mountVersion 校验，用户显式文件与上传附件保留各自的结构化授权；不得把上传存储路径加入通用可写 grant。目录遍历校验真实路径边界、跳过链接并传播取消；
- pi 新工具签名只在 Adapter 内部适配。

## 8. 产品事件模型

Adapter 将 pi 事件转换为 Synech 产品事件：

```text
run_started
model_output_delta
model_thinking_delta
tool_requested
tool_progress
tool_result_observed
tool_result_accepted
approval_required
compaction_started
compaction_completed
retry_observed
usage_observed
run_completed
run_failed
run_cancelled
```

事件规则：

- `eventType`、`code` 和状态字段负责程序分支；
- title、label、message、detail 只负责展示；
- 观察事件不能直接替代产品状态提交；
- UI 只订阅 Synech 事件，不订阅 pi 事件；
- Adapter 可保留 Provider 原始诊断，但不泄露 pi 事件名；
- usage 由 Adapter 采集，跨会话统计由 Synech 聚合；
- retry 由 pi 负责机制，Synech 只记录产品需要的观察事实；
- compaction 触发由 pi 负责，Synech 只提供 context contribution 和图像降级策略。

## 9. 取消、重试、压缩和恢复

取消分两层：Pi cancellation 停止底层 operation；Synech cancellation 记录 actor、原因、时间、产品状态和最终收敛。两者必须关联，但不能把 Pi 的 aborted 结果直接当作完整的 Synech cancellation 事实。

普通 Agent 运行的 Provider retry 交给 pi；记忆整理、会话标题等不经过 Pi Agent Runtime 的辅助调用继续使用 Synech 自己的重试策略。Pi retry 不得创建新的产品 run。

阈值判断和压缩运行交给 pi；Synech 不在请求边界重复触发压缩。Pi 0.87.1 的摘要请求由 `convertToLlm`、`serializeConversation` 生成文本，不直接发送原始图片块；Synech 不另建图片摘要器，也不记录虚构的图片替换计数。普通模型请求的非视觉输入占位、Memory background、Skill context 等产品输入贡献通过 Adapter hook 注入，不能与原生压缩混为一谈。压缩失败转换为 Synech 结构化 runtime failure。

恢复时 Synech 先依据产品账本判断允许恢复到哪个 checkpoint，Adapter 再把 opaque checkpoint 转换为 pi 内部恢复位置。不能直接依据当前 pi leaf 推断产品是否允许恢复。Pi commit queue 不能替代世代栅栏。

ADR 0014 约束产品装配与恢复顺序：先确定本次有效模型，再一起冻结能力和工具目录。工作区 `ViewImage` 使用与 `Read` 相同的锁内路径授权；附件图片工具保留附件身份授权；二者共享图片读取与显式附件构造政策。

取消停止 Pi operation 后，产品仍需释放运行资源、关闭 Session 并结算已接受结果。删除不能仅等待取消任务返回后直接移除 Run：先完成 finalization，失败保留 Run、附件和会话供重试。Pi 工具结果先写入 pending entry，再进入 transcript；异常退出后的图片恢复必须从对应 assistant 工具批次取回，验证调用身份、文本、状态和全部图片哈希后才能改变活动分支。图片字节仅存于 Pi Session，不重执行工具。

Ordinary 驻留的 Run 集合同时决定对话可见性、轮次和提交幂等。统计和 Memory 读取不得把它作为临时显示缓存驱逐；`releaseTerminalRunCaches` 仅释放可重建的活动流。捕获空起点不等于写入 Session：首条输入写入前取消的 Run 仍是可见产品轮次；多个 Run 定位到同一 Session 位置时按产品 ordinal 排序。重复删除已不存在的 Session 视为完成，其他身份、元数据及活动 writer 错误继续上抛。

后续轮次进入 Session 后，仍沿该轮次的 predecessor 链保留此前没有 Session 记录的取消或失败轮次。可见性只能补回当前分支的这些前序轮次及待运行后继，不能把回滚后已退出活动分支的 transcript 轮次重新显示出来。

## 10. 旧 Session 与数据迁移

pi 0.87 可以读取部分旧 v3 JSONL，但旧会话导入可能重铸 entry ID。因此“pi 能读取旧会话”不等于“Synech 产品引用仍然兼容”。

当前未发布开发数据不建立引用兼容链。旧 v3 会话由 Repository 在打开前明确拒绝，返回 `agent_session_legacy_requires_reset`；由用户显式执行 `pnpm reset:product-home`，启动和普通读取不得自动导入或删除。一次性探针的过程与原始输出不属于维护手册。

迁移规则：

- 不自动假设旧产品 entry 引用兼容；
- 不在启动时静默重写、删除或重建；
- 迁移前识别所有使用 `AgentSessionEntryRef` 的产品状态；
- 区分正式发布数据和未发布开发数据；
- 无法证明引用稳定的旧开发数据，采用显式备份后显式 reset 或显式迁移；
- 引用映射记录迁移版本、旧引用、新 checkpoint 和失败原因；
- 迁移失败保持原数据，不进入半兼容状态。

## 11. 分阶段实施规约

### 阶段 0：冻结决策

产出本手册、ADR 0003、架构基线和维护规则中的边界引用、pi 类型泄漏清单、entry ID 使用清单和 Adapter 迁移范围清单。文档边界未冻结前，不继续在升级探针上增加迁移补丁；未完成探针不合并到 `main`。

### 阶段 1：审查并冻结现有 Port，建立 Fake Runtime

以现有 `AgentLoop` 和 Ordinary execution port 为候选，列出保留、收紧、替换三类契约差异；确认产品层最终使用的窄 Port 后建立 Fake Runtime。Fake Runtime 覆盖正常完成、工具调用、approval-required、工具失败、取消、Provider failure、retry/compaction observation、checkpoint rollback、release 和重复 release。此阶段不接 pi 0.87，也不默认新建第二套并行 Runtime。

### 阶段 2：隔离现有产品层

移除产品层中的 pi `Session`、`HarnessEvent`、`AgentHarness`、pi entry reference 和 pi 专属执行签名，保留 ToolCenter、权限、审批、运行账本和 Ordinary 生命周期。

### 阶段 3：建立 Pi Adapter

把 `AgentHarness.create`、lane、Context、Pi hooks/events、Pi tool signature、Session commit、retry/compaction、usage、failure/result mapping 和 opaque checkpoint mapping 收口到 Adapter。Adapter 必须通过 Port contract tests，不能只通过 TypeScript 编译。

### 阶段 4：迁移身份和 checkpoint

用 `runId/turnId/toolInvocationId/checkpointId` 替换产品层 entry 引用；为旧状态建立显式迁移或显式拒绝路径；将 pi entry ID 降级为 Adapter 诊断信息；删除产品层基于 pi leaf 的状态推断。

### 阶段 5：迁移存储与运行机制

让 Pi 接管 transcript commit、压缩触发、运行 retry 和 runtime usage；让 Synech 保留产品账本、工具对账、取消、恢复和终态；删除旧请求边界压缩和旧 Harness API 旁路；统一 Context 在 Adapter 内部生成和传播。

### 阶段 6：删除旧路径

只有在产品层无 pi import、产品类型无 pi 类型、产品状态无 pi entry ID、UI 无 pi event type、旧 Session repository 旁路不存在、Fake Runtime 和 Adapter contract tests 通过、Ordinary 主链路核心测试通过后，才能删除旧路径。

## 12. 命名治理与字段设计规约

现有抽象中的部分命名带有“通用 AI SDK/模型适配器”风格，后续可以在边界迁移时做小范围重命名，但命名调整必须服务于 owner 和语义，不得为了风格统一制造无行为价值的大规模改名。

命名原则：

- 产品层使用业务语义，例如 `run`、`turn`、`toolInvocation`、`checkpoint`、`execution`；
- Adapter 内部才使用 `lane`、`operation`、`entry`、`tip`、`session` 等上游术语；
- `request` 表示外部或模型发起的请求，`invocation` 表示 Synech 已接受并拥有的工具执行身份，二者不能混用；
- `result` 表示执行事实，`projection` 表示展示投影，`event` 表示观察或状态通知，避免用一个 `data`/`payload` 类型承载三者；
- `runtimeRef` 或 `opaqueRef` 表示不能由产品层解释的 Adapter 身份；
- 公共字段避免 `agentXxx`、`modelXxx`、`providerXxx` 这类无法说明 owner 的泛化前缀；
- 命名调整与行为迁移分开记录，优先在触碰该接口的逻辑切片中完成，不做独立的大范围 rename commit；
- 任何改名必须回答“旧名表达了什么错误 owner 或错误语义”，不能只以“更优雅”作为理由。

后续 Agent 可以提出命名替换，但不能自行把 `AgentLoop`、`AgentSessionRepository` 等公共概念批量改名。公共命名的改变必须在对应迁移切片中说明旧名、目标名、语义变化、影响面和兼容策略。

## 13. 后续 Agent 开发规约

任何 Agent 接手运行层工作前，必须阅读架构基线、开发维护规则、本手册、Agent Runtime ADR 和当前 Port/Adapter contract tests。

每次改动必须回答：代码属于运行机制、产品能力、治理还是呈现？owner 是谁？是否把 pi 类型带入产品层？是否新增第二个状态写者？是否把 provider call ID 当成产品 invocation ID？是否把 pi entry ID 写进产品状态？是否把取消、重试、压缩、恢复两条责任线合并？失败路径和终态是否仍由同一个产品 owner 收敛？

禁止：产品层直接 import pi；修改 Pi dist 或 node_modules；通过字符串解析 pi 事件推导业务状态；为旧开发数据增加启动时自动修复；在 Adapter 外复制 Pi Session 状态机；为了类型通过伪造空 assistant、空 usage 或空 checkpoint；只修当前报错而不更新 Port、Adapter 和 contract test；把非当前需求的遥测、分叉或 pi 技能系统顺手暴露出来。

## 14. 验证与完成定义

实施阶段按改动范围执行：

```text
pnpm check:baseline
pnpm typecheck:panel
pnpm build:panel
node node_modules/typescript/bin/tsc -p tsconfig.json
pnpm test:core
pnpm check:whitespace
git diff --check
```

重点验证：ToolCenter 授权仍在 Adapter 前生效；用户取消不会变成 Provider failure；工具结果只接受一次；世代撤销后旧写入不能继续；产品 checkpoint 不依赖 pi entry ID；pi retry 不重复创建产品 run；compaction 沿用 Pi 原生语义且不丢失 Memory contribution；Adapter release 后不会继续发送产品事件；不支持的旧数据明确拒绝且不修改原数据。

完成定义：产品层只依赖 Synech Runtime Port；Pi 依赖集中在 Adapter；产品身份不再使用 pi entry ID；产品账本和 Pi transcript owner 明确；ToolCenter、审批、权限、取消和终态语义未被 Pi 接管；Fake Runtime 与 Adapter contract tests 通过；文档、ADR、基线、类型和实现一致；没有隐式兼容层或平行事实源。

### 恢复会话后的 Run 模型配置

Pi `AgentHarness.create` 的 model/thinkingLevel 只作为新 lane 的初始值；恢复已有 lane 时会读取 Session 中上一次的配置。Ordinary Pi Adapter 必须在收敛遗留 operation 后、提交本轮 prompt 前，通过 `lane.setModel` 和 `lane.setThinkingLevel` 应用本轮冻结的模型与推理档位。未配置推理档位时明确使用 `off`，避免继承上一轮设置。模型切换保留同一 Session 的对话历史，不通过重建会话或注册历史模型绕过配置同步。

恢复后的模型身份、推理档位和活动工具列表须与本轮配置一致；通过 Pi getter 比较后，仅对发生变化的字段调用 setter，避免无变化续聊重复提交 lane 配置。模型同名但能力或请求参数改变时，运行使用本轮新建的 registry 与 hooks，不从历史 lane 复制模型对象或 Provider 参数。分支回退仅移动 transcript，不作为恢复本轮模型配置的来源。

本地运行时 `model_unavailable`、`configured_tools_unavailable` 可按结构化错误码显示装配失败提示；保留原始诊断，不将它们推断为厂商服务下线。Provider 返回的错误文案继续原样呈现，不通过英文字符串匹配判断原因。
