# ADR 0020：Workspace 从独立产品入口降级为 Space 本地资源

> 状态：Accepted（2026-10-03，未发布 v1）
> 范围：Space/Workspace 产品边界、Conversation/Run owner、SpaceReference membership、Panel UI/API 退役、目标 schema 与开发数据重置
> 相关：ADR 0006（未发布 v1 的目标数据基线）、ADR 0018（统一记忆与协作规则）

## 背景

Synech 当前同时把 Space 与 Workspace 暴露为用户可直接进入的一等工作对象。Workspace 最初按独立产品概念设计，拥有独立入口、列表/详情和部分 owner 语义；Space 可以引用 Workspace，但用户需要理解两套相近的顶层工作模型。

该模型与产品长期定位不一致。Synech 的用户级工作上下文应当是一个可以长期积累对话、知识、记忆、协作规则、预览和项目状态的 Space；本地目录只是这个上下文所依赖的外部资源。继续保留 Workspace 的独立产品身份，会使 UI、Conversation、Run、Memory、规则和 API 长期维护两套平行 owner 语义，并削弱 Space 作为唯一项目入口的连续性。

本 ADR 记录产品与领域收敛决策。第一阶段已移除 Workspace 独立 UI/API；第二阶段已将 Conversation、Run 和 Memory owner 收敛为 Space/global，并保留 Workspace 作为本地资源和外部规则来源。后续只允许清理不再需要的内部兼容字段，不得恢复 Workspace 用户级 owner。

## 决策

### 1. Space 是唯一用户级工作上下文

- 用户创建、打开和恢复的唯一顶层工作对象是 Space。
- Space 代表长期项目与协作上下文，负责组织 Conversation、Knowledge、Memory、CollaborationRules、Preview 以及项目状态。
- Panel 首页、主导航、项目选择和恢复入口不再提供 Space/Workspace 二选一。
- 用户不需要理解或直接管理一个独立的 Workspace 产品。

### 2. Workspace 保留为本地资源身份，不再是独立产品 root

Workspace 不删除，也不把其事实简单复制为 Space 字段。Workspace 继续由 WorkspaceFeature 拥有以下本地文件系统事实：

- `workspaceId`；
- filesystem/source identity；
- `mountVersion`；
- mount/reconnect/invalidation 生命周期；
- 本地目录可访问性与文件 mutation 所需的 admission/锁边界；
- 与已登记根目录关联的外部规则文件来源；
- 预览和 Agent 文件操作所需的真实目录解析。

Workspace 不拥有：

- Space membership；
- Conversation 或 Run 的用户级 owner 身份；
- Space 的长期项目语义；
- 外部目录内文件的所有权或删除权。

在用户界面中，Workspace 可以显示为“本地资源”“项目目录”或“已连接目录”；代码内部继续使用 Workspace 命名，以保持 filesystem identity/mount/lifecycle 的事实边界。

### 3. SpaceReference 负责 membership

- SpaceReferenceItem 是 Space 与 Workspace 之间关系的唯一 membership 身份。
- SpaceReference 负责表达“某个 Workspace 被某个 Space 使用”，不接管 Workspace 自身生命周期。
- Space 可以在未来关联多个本地资源；Workspace 也可以被多个 Space 引用，具体数量限制由后续实现契约决定，不由 UI 隐式假设。
- 跨 Feature 的 attach、reconnect、unlink、删除和恢复由 Application/`app/workbench-coordination` 协调；Route 不直接编排多个 Feature 或访问 Repository。
- 用户动作应表达为“给 Space 添加/重连/移除本地资源”，而不是“创建/删除一个独立 Workspace”。

### 4. Conversation 与 Run 最终只以 Space 为 owner

目标领域模型为：

```text
Conversation.owner = Space
Run.owner = Space
SpaceReferenceItem -> Workspace
Workspace -> filesystem identity / mount lifecycle
```

因此：

- 新建 Conversation 不再接受 Workspace-level owner；
- Ordinary Run 的 durable owner、admission、恢复和删除语义统一以 Space 为根；
- Workspace 仅作为当前 Space 可授权访问的文件资源，不直接创建顶层 Conversation/Run；
- Conversation owner 创建后不可改变；切换当前目录、附件或预览对象不能改变 Space owner；
- 在过渡期保留的 Workspace-owned 历史数据/读取分支必须有明确退役计划，不得成为新的公共入口或隐式兼容层。

Memory、CollaborationRules 以及其他按 owner 隔离的用户级长期事实，随本决策逐步收敛到 Space owner；Workspace 相关内容只保留为本地文件来源或资源级读取事实，不再产生第二套用户级长期上下文。

### 5. 移除引用不删除外部目录

- 从 Space 移除 SpaceReference，只解除 membership。
- 该操作不得删除、移动、清空或覆盖用户外部目录及目录内文件，包括外部 `AGENTS.md`。
- Workspace 登记是否可以在无引用时清理，由 coordinator 根据唯一引用、并发请求、恢复和在途 mutation 统一决定。
- 任何 Workspace 物理登记清理都必须与外部文件删除严格分离，并复用现有 source identity、mountVersion、mutation lock 和迟到请求拒绝语义。

### 6. 独立 UI/API 分阶段退役

退役不是一次性删除 WorkspaceFeature，而是分阶段删除其独立产品身份：

#### 阶段 A：产品入口收敛

- 删除 Workspace 一级导航、独立列表/详情/创建入口和 Workspace owner picker。
- Space 成为唯一首页和恢复入口。
- 在 Space 内提供“添加/重连/移除本地资源”的操作，并以 Space-scoped DTO 呈现资源状态。
- Workspace Feature、Repository、mount 校验和底层资源生命周期暂时保留。
- 旧 Workspace API 可以在过渡期仅供内部装配或迁移使用，但 Panel UI 不得继续依赖其独立产品语义。

#### 阶段 B：应用命令与关系入口收敛

- 将添加、重连、解绑和必要的清理收敛为 Space 作用域的 Application/WorkbenchCoordination command。
- 由统一 command 负责 Space admission、Workspace identity/mount 校验、SpaceReference membership、失败补偿、锁顺序和错误传播。
- 禁止前端或 Route 通过“先创建 Workspace、再添加 SpaceReference”自行组合两个 Feature 写入。

#### 阶段 C：owner 与公共契约收敛

- 删除 Workspace 作为 Conversation/Run 公共 owner 的输入、解析、projection、恢复和删除分支。
- 删除独立 Workspace user-facing list/visibility/CRUD 语义；保留内部资源生命周期所需的最小 Workspace contracts。
- 清理不再使用的独立 Workspace DTO、read model、事件投影和 API 路由；不得以隐藏路由或字符串兼容继续保留第二产品入口。
- 对仍需保留的内部 Workspace API，明确其 internal-only 边界；若无调用者则删除。

#### 阶段 D：目标数据基线与开发数据收口

- 目标 schema 直接维护为最终 owner 结构，不为旧开发数据追加迁移链或兼容读取。
- 在未发布 v1 的前提下，旧 Workspace-owned Conversation/Run 或其他已退役结构不做用户数据迁移；需要清理时使用显式 data-only reset。
- reset 前必须关闭占用 Product Home 的进程并取得 Product Home lease；不得在普通启动时静默删除、重建或掩盖不兼容数据。
- reset 只清理本次收敛涉及的 Synech 产品测试数据及关联生命周期状态，保留 config/凭据、外部目录和共享工作树。

## 不采用的方案

### A. 删除 Workspace 领域实体并把所有字段搬进 Space

不采用。这样会把 filesystem identity、mountVersion、sourceIdentity、重连和 mutation 生命周期隐式复制到 Space，破坏事实 owner，并使未来多资源、重连和权限校验难以维护。

### B. 只删除前端入口，长期保留 Workspace owner/API 双模型

不采用。仅隐藏入口会留下不可见的第二产品模型，继续扩大 Conversation、Run、Memory、规则和 read model 的双重分支。前端入口退役必须最终配合 owner、command、API 和 schema 收敛。

### C. 让 SpaceReference 接管 Workspace 生命周期

不采用。SpaceReference 只拥有 membership；被引用 Workspace 的真实目录身份与 mount 生命周期仍由 WorkspaceFeature 拥有，跨 Feature 生命周期由 coordinator 协调。

## 影响与代价

### 正面影响

- 用户只需要理解 Space 一个长期工作上下文。
- Project Home、Preview、Memory、Knowledge 和 Conversation 可以围绕同一个 owner 形成连续闭环。
- Workspace 的 filesystem 安全边界得到保留，不需要把本地资源事实塞进 Space。
- 后续支持多个本地来源或非代码资料目录时，不必重新设计顶层产品模型。

### 代价与风险

- 这是 owner、公共命令、API、删除语义和目标 schema 的跨层收敛，不是单纯的导航删除。
- 需要处理 Workspace-owned 历史开发数据、恢复分支、投影和测试夹具；未发布 v1 可以显式 reset，但必须避免启动时静默清理。
- 阶段 A 与阶段 C 之间会存在短暂过渡状态，必须明确哪些接口 internal-only，避免新功能继续依赖退役入口。
- 基线与 Handbook 中现有的 Space/Workspace owner 表述在实现完成前仍是当前事实，不能通过本 ADR 假装已经完成代码收敛。

## 实施约束

- 先更新稳定 contracts 和唯一 command，再删除 adapter；不要让 Route、PanelHost 或 UI 复制跨 Feature 编排。
- 每个阶段都检查 staged file list，不能把本次收敛与其他 dirty worktree 的修改混入同一提交。
- 涉及 Conversation/Run owner、删除、权限、并发或 schema 时，补充保护真实不变量的最小验证；低风险文案和导航调整不新增镜像测试。
- 实现完成后运行项目要求的 `pnpm check:baseline`、相关 Panel typecheck/build、`git diff --check`，并按改动范围执行 `pnpm verify`。
- 现有架构基线必须在实现同一逻辑切片中同步更新；本 ADR 不代替基线更新，也不授权直接修改现有基线文件。

## 需要整合到架构基线的变更点

实现完成后，至少需要在[架构基线](../架构基线.md)中同步以下事实：

1. 产品与领域事实表：Space 改为唯一用户级工作上下文；Workspace 改为真实目录的本地资源身份；Conversation/Run 不再声明为 Space 或 Workspace 二选一 owner。
2. SpaceReference 规则：明确 SpaceReferenceItem 负责 membership，Workspace 仍拥有被引用对象的 filesystem identity/mount/lifecycle。
3. owner 规则：Conversation、Run 以及按用户级项目隔离的 Memory/CollaborationRules 目标 owner 收敛为 Space；Workspace 仅作为本地来源和受授权文件边界。
4. 分层与唯一入口：添加/重连/解绑本地资源由 Space 作用域 Application/WorkbenchCoordination command 拥有，Route 只调用一个 command，Feature 不互相直接 import。
5. 删除语义：移除 SpaceReference 不删除外部目录；无引用 Workspace 的内部清理由 coordinator 决定，不能扩大为外部文件删除。
6. UI/显示基线：删除 Workspace 一级入口、owner picker 和独立列表；Space 内以本地资源呈现 Workspace 状态，字符串 label 不承担程序分支。
7. 数据基线与恢复：目标 schema 直接调整；旧开发数据通过显式 reset 清理，普通启动不得静默迁移、删除或重建；同步 `docs/architecture/data-baseline.json` 及相关 schema fingerprint/ledger。
8. 变更等级与完成定义：把本次 owner、公共 API、删除语义和 schema 收敛列为必须更新基线并做最小高风险验证的变更。

## 验证重点

实现阶段至少验证以下长期不变量：

- Space 是所有新建 Conversation/Run 的唯一用户级 owner；Workspace-level owner 入口被拒绝或已删除。
- SpaceReference attach/reconnect/unlink 的正常、失败、重试、并发和恢复路径使用同一协调策略。
- unlink 不删除外部目录及外部规则文件；迟到的旧 Workspace 请求不能在移除引用后继续写入。
- Workspace 的 source identity、mountVersion、mutation lock 和重连生命周期仍然有效。
- 目标 schema 与 fresh Product Home 基线一致；不兼容旧开发数据由显式 reset 处理，而不是启动时静默修复。

## 当前状态

已完成：

- Workspace 独立 Panel UI/API 已退役；
- Space 内本地资源添加、展示和重连已成为用户入口；
- Conversation / Run owner 已收敛为 Space；
- Memory owner 已收敛为 global/Space；
- Workspace CollaborationRules scope 仍保留，用于外部 `AGENTS.md`，不再作为 Conversation、Run 或 Memory owner；
- Workspace mount、source identity、mutation lock、SpaceReference membership 和外部文件保护仍由原有 owner 负责。

后续清理应以本 ADR 和已更新架构基线为约束，不得恢复 Workspace 的用户级 owner 或独立产品入口。
