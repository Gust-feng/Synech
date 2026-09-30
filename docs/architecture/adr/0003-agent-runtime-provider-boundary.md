# ADR 0003：Agent Runtime Provider 边界

> 状态：Accepted
> 日期：2026-09-28
> 影响面：Agent 运行层、Ordinary、ToolCenter、Session/Checkpoint、运行账本、Panel 活动投影和 pi-agent 接入方式
> 配套手册：[Agent 运行层接入与开发手册](../Agent运行层接入与开发手册.md)

## 1. 背景

Synech 的 Agent 底座经历了自研 Agent、OpenAI SDK 和 pi-agent 多次演进。pi-agent 能够提供 Provider 协议、流式输出、工具调度、上下文、压缩、重试、Session 和运行恢复等复杂基础机制，因此继续使用它作为底层 Runtime Provider。

但当前接入把 pi 的 `AgentHarness`、`Session`、事件、工具签名和 entry ID 带入了 Synech 的产品运行状态。pi 0.80 到 0.87 的运行模型变化证明：上游运行时内部对象不是稳定的产品契约。

## 2. 决策

### 2.1 Provider 定位

pi-agent 是 Agent Runtime Provider，负责通用运行机制；Synech 负责产品运行语义。Synech 不直接把 pi 的对象模型作为产品 API。

### 2.2 稳定接入层

在产品层和 pi-agent 之间完成 Synech 自己定义的 Agent Runtime Port，并由 Pi Agent Adapter 实现该 Port。Synech 已有 `AgentLoop`、ToolCenter 和 Ordinary execution port 等产品侧抽象；本决策不要求另起一套并行 Runtime，而要求审查并收紧现有抽象，保留稳定产品语义，替换被 pi Session、entry identity、事件和恢复机制污染的部分。

目标依赖方向为：

```text
Product Feature / Panel
        ↓
Synech Agent Runtime Port
        ↓
Pi Agent Adapter
        ↓
pi-agent-core / pi-ai
```

只有 Adapter 可以依赖 pi 的 `AgentHarness`、`AgentLane`、`Context`、`Session`、`HarnessEvent` 和内部运行 ID。

### 2.3 产品运行语义归属

Synech 继续拥有 Conversation、Space、Workspace owner、Run admission、工具权限、审批、审计、ToolCenter、ToolCallResult、取消、运行账本、产品 checkpoint、恢复许可、终态收敛和 Panel 投影。

pi 负责 Provider 请求、Agent loop、Context 构建、压缩触发和运行、普通 Agent Provider retry、Pi transcript Session、operation/lane 恢复和 Provider usage。

### 2.4 身份边界

pi `entryId`、`tipId`、`operationId`、`usageId`、lane 和 branch 不属于 Synech 产品稳定身份。Synech 使用 `conversationId`、`runId`、`turnId`、`toolInvocationId` 和 `checkpointId`。

Pi Adapter 可以维护 opaque runtime checkpoint 映射，但产品层不得解析、比较或通过 pi ID 推导业务状态。

### 2.5 工具边界

Pi 产生 provider tool call 后，必须由 Adapter 转换为 Synech `ToolCallRequest`，再进入 invocation acceptance、权限、审批、ToolCenter 和账本流程。Pi active tool set 只是模型可见性，不替代 Synech 授权事实。

### 2.6 Session 与世代栅栏

Pi Session transcript 和 commit queue 负责 Pi 运行机制的持久化与串行写入；Synech Run Ledger 负责产品生命周期与治理事实。Pi commit queue 不替代 Synech 的世代栅栏：撤销某个写入世代后，该世代的未完成写请求不得继续写入。

### 2.7 暂不纳入公共 Port 的能力

暂不将 pi 遥测、会话分叉和 pi 技能系统纳入 Synech 公共 Runtime Port。未来接入必须另行证明产品需求、owner 和数据语义。

## 3. 后果

正面后果：

- pi 升级的主要影响面收敛到 Adapter；
- 产品层拥有稳定的运行语义；
- 可以用 Fake Runtime 测试产品生命周期，而不依赖 Provider；
- ToolCenter、审批、权限和账本不再被上游内部模型牵引；
- 未来可以替换其他 Agent Runtime Provider。

负面后果：

- 需要冻结并收紧现有产品内部 Port，必要时才新增窄接口，并建立 Adapter 边界；
- 当前产品层直接使用 pi Session 和 entry 引用的代码需要迁移；
- 旧开发会话的 entry ID 兼容不能默认假设；
- Adapter 需要维护 Pi checkpoint 与 Synech checkpoint 的映射；
- 接入测试必须覆盖 Port contract，而不能只依赖 TypeScript 编译。

## 4. 迁移约束

- 本 ADR 生效后，不继续扩大产品层对 pi 类型的直接依赖。
- 未完成的 0.87 升级探针不得直接合并到主工作树。
- 先审查现有 `AgentLoop`、ToolCenter 和 Ordinary execution port，冻结保留/收紧/替换清单并建立 Fake Runtime，再建立 Pi Adapter。
- 不默认新建与现有 `AgentLoop` 并行的第二套完整 Agent Runtime。
- 不在启动时静默迁移、重写或删除旧开发会话。
- 不为了类型通过伪造空 assistant、空 usage 或空 checkpoint。
- 产品层没有完成 pi import、entry ID 和旧 Session 旁路清理前，不能宣称边界迁移完成。

## 5. 实施边界

Ordinary 继续使用已有 `AgentLoop`，不为替代现有抽象而引入并行完整 Runtime。Pi 0.87.1、产品 checkpoint 持久映射、工具签名桥接与环境适配已经接入。

无 writer 时 Session 临时读取按会话串行执行打开、读取与关闭；writer 存活时复用其 fenced handle。事件中的 assistant entryId 可能早于条目持久化，活跃运行直接消费事件携带的文本，最终回复检查点在运行完成后记录。

租约的检查点写入、撤销与释放只能作用于其拥有的写入代际。撤销包括检查点解析和恢复叶提交，释放须等待整个撤销完成；旧租约的重复释放不能注销新写者。检查点序号在同一 Pi mutation 中分配和持久化，损坏或重复映射明确拒绝。实时预分配 entryId 可以建立映射，但持久恢复前必须确认目标条目存在。会话身份校验使用磁盘头派生的 metadata，不能用引用自身合成 metadata 后自证一致。

产品投影失败记录首个诊断并立即请求取消，等待取消标记后允许 Pi 结算，再返回产品失败；事件订阅者抛错不构成停止保证。该政策同样适用于委派运行与并行子任务。成功的子智能体必须有非空、无 tool call 且 stop reason 为 `stop` 的最终回复；初始化失败、取消、投影失败和正常完成都释放其订阅、Harness、Session 与内存仓储。子智能体继承本次运行的压缩配置。

产品恢复叶与 Adapter 类型别名仍需要继续收紧。`AgentSessionHandle` 的不透明命名不等于已经完全隔离 Pi Session 的结构，不能仅凭导入门禁宣称迁移完成。

旧 v3 开发会话采用显式拒绝与显式 reset，不做产品引用兼容。不自动 resume 遗留 operation；产品已结算的中断运行由 Adapter abort 收尾。

## 6. 原生压缩与图片输入

压缩归 Pi 原生机制。Pi 0.87.1 的摘要请求通过 `serializeConversation` 构造文本，Synech 不另建摘要器，不增加 `replacedImageBlocks` 或“图片已替换”的产品事实。普通请求的非视觉模型图片占位与压缩分别处理。
