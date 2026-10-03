# ADR 0021：Memory owner 追随 Space-first 产品模型

> 状态：Accepted（2026-10-03）
> 范围：Memory owner、来源边界、Workspace 资源关系
> 相关：ADR 0019（Memory 条目与 provenance）、ADR 0020（Workspace 降级为 Space 本地资源）

## 背景

ADR 0019 在 Workspace 仍被视为用户级工作上下文时设计，曾将 Space 和 Workspace 都作为 Memory owner。随后 ADR 0020 将 Workspace 从独立产品 root 降级为 Space 引用的本地资源，并将 Conversation、Run 和用户级长期上下文统一到 Space。

如果 Memory 继续保留 Workspace owner，产品与数据边界会重新出现第二套项目上下文：Workspace 删除会误触发长期记忆清理，Workspace 重连会改变记忆归属，Memory UI 也会重新出现与 Space 并列的范围选择。

## 决策

### 1. Memory owner 只有 global 与 Space

- `MemoryOwner` 只允许 `{ kind: "global" }` 和 `{ kind: "space", id }`。
- global 只表示全局开关、策略和清除范围，不保存长期记忆正文。
- 长期 MemoryEntry、Revision、Topic、Source 和 Overview 均归属于 Space。
- Memory API、后台整理、前台检索和管理 UI 不接受 Workspace owner。
- 旧的 Workspace memory key 不做兼容迁移；当前未发布 v1 通过显式数据重置处理旧开发数据。

### 2. Workspace 是外部资源，不是 Memory owner

Workspace 继续负责：

- filesystem/source identity；
- mountVersion 和重连；
- 文件访问授权与 mutation lock；
- 外部 `AGENTS.md` 规则来源；
- SpaceReference 解析和资源生命周期。

Workspace 不负责：

- Conversation；
- Run；
- MemoryEntry 或 MemorySource 的 owner；
- Space 的长期项目语义。

Workspace 删除不得删除或清理 Space-owned Memory。Workspace 规则仍通过 CollaborationRules 的 workspace scope 访问，但该 scope 不得进入 Memory owner、Conversation owner 或 Run owner。

### 3. MemorySource 的当前范围

v1 的 MemorySource 继续主要来自：

- Space Conversation range；
- 用户显式编辑；
- 宿主发布的 revision/source identity。

Agent 读取 Workspace 文件后形成的长期认识，首先归属于当前 Space Conversation，再通过 Conversation provenance 进入 Memory。当前不把任意 Workspace 文件直接作为 Memory owner 或自动长期来源。

未来如果需要直接引用 Workspace 文件，必须增加独立的 `SpaceReference` 文件来源定位，并保存 referenceId、relativePath、sourceIdentity、mountVersion 和内容指纹；不得恢复 Workspace owner。

## 影响

### 正面影响

- Memory 与 Project Home、Conversation、Knowledge 和 Space 形成单一长期上下文。
- Workspace 重连不会迁移或重命名 Memory。
- Workspace 删除不会误删 Space 的历史认识。
- Memory UI 不再需要维护 Workspace owner 选择和双重权限语义。
- 文件资源安全边界继续由 WorkspaceFeature 负责。

### 代价

- Workspace 作为 Memory owner 的旧开发数据不兼容；v1 不增加迁移链。
- 未来文件直连记忆需要额外的 SpaceReference provenance 设计。
- 旧注释、提示词和测试夹具必须持续避免使用“Space/Workspace 同源 owner”的表述。

## 实施约束

- Memory Application 不接收 Workspace admission 或 Workspace owner existence query。
- Composition Root 不向 Memory 注入 Workspace 生命周期依赖。
- Memory 与 WorkspaceFeature 不直接互相 import；跨能力生命周期由 WorkbenchCoordination 处理。
- 任何新的记忆来源都必须具备结构化 owner、来源身份、可重验版本和删除/退役语义。
- 记忆条目、修订、来源和查询仍沿用 ADR 0019 的 CAS、幂等、预算和 provenance 约束。
