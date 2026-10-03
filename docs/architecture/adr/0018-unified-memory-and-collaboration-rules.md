# ADR 0018：统一记忆与协作规则，退役 Agent 笔记和路径依赖

> 状态：Accepted（2026-10-02，未发布 v1）
> 范围：Memory、CollaborationRules、Ordinary 装配、Panel 与开发数据维护

## 决策

- AgentNotes 与 PathDependency 完全退役：删除独立文件、工具、目录注入、Run 笔记版本、读取/应用记账和 UI；不保留中间引用态。Knowledge 用户笔记和现有 Skills 不变，不新增自动技能发布。
- 协作规则是用户明确确立的长期协作依据，可以包含要求与项目背景；模型只在用户明确委托时修改。全局和 Space 规则由 Product Home 管理，Workspace 根 AGENTS.md 是唯一项目规则源，不复制为内部 RULES.md。根文件缺席视为未设置；不支持嵌套继承。
- Workspace 规则读写复用现有 owner admission、来源身份和共享 mutation lock；锁内重验 mountVersion/sourceIdentity 与预期内容版本。Workspace 登记删除永不删除外部 AGENTS.md。Space 引用项目的规则按相关项目材料读取，不全量成为 Space 每轮默认规则。
- Agent 规则工具只能选择当前 owner 或明确授权的 global；owner 与真实文件由宿主绑定。用户授权语义由提示词与既有工具权限政策表达，不建立新的自然语言权限判定器。
- Memory 是历史认识，只有稳定合法对话能触发后台整理。保留会话总结、可选长期更新、来源、不确定性、FTS、任务恢复、原子提交、每次请求供给复核与固定会话版本绑定；不建立第二条 Agent 长期文档写入链。
- Memory 支持 Space/Workspace，严格按固定 owner 隔离；全局仅为总开关和管理范围，不进行跨项目自动学习。用户只有 enabled 全局开关，默认关闭；删除 space_participation 政策及公共入口。内部 rollout/health 只用于装配和开发者诊断。
- enabled=false 阻断采集、整理结果发布、查询和背景供给，存储保留。开启前写已分配 ordinal 排除边界，覆盖 Space/Workspace 与排队/未稳定轮次；重复设置同值不重新排除。清除以 generation/fence/policy revision 拒绝迟到结果，保留关闭/清除排除边界。规则、Skills 和原始对话不属于记忆清除。
- 公共命令收敛为 setEnabled、clearMemory、updateMemory、getMemoryView 和 getStatus，编辑/视图使用结构化 owner；global 可用于状态和全局清除，不保存 global 长期文档。开发者 setRollout 保留。
- 长期表及 Repository 命名从 Space 泛化为 owner；直接更新 memory/1 目标定义和 data-baseline.json，不追加开发数据迁移，不递增应用/产品格式版本。原有业务 revision/generation 正常推进。
- 全局/Space 规则维持现有小文档限制；Workspace AGENTS.md 预算为 8,000 tokens，超限明确报错，禁止静默截断。文本是指导而不是文件权限，当前请求优先于长期默认要求。

## 开发数据切换

用户明确确认当前均为可丢弃测试数据。旧笔记和路径依赖不迁移。通过显式维护模式，在停服并取得 Product Home lease 后清理产品 data 及关联生命周期状态，保留 config/模型凭据、Skills 来源、外部项目和共享工作树。普通启动不做 reset/格式兼容。已有 schema checksum 不匹配仍明确失败。

## 实施与验证

先固定契约，再并行修改 Memory、规则与 Panel；共享 Host/Ordinary/生命周期装配由主实现整合。复用核心测试，仅增加 Workspace 隔离、开关/清除交错与根规则文件身份/CAS/删除边界场景；完成当前数据基线检查和 pnpm verify。正常 Product Home 最终运行当前 Electron 构建，不用真实外部模型请求代替工程验证。

## 授权边界修正（2026-10-03）

- 原文索引与后台总结共同遵守启用/清除排除边界；关闭前已获准索引的轮次保留，关闭期间不回填。历史原文工具只读取已获准索引的轮次，并在分页中跳过授权空隙；原始对话的 UI 阅读不变。
- 证据读取后的索引写入与任务登记分别在自己的同步 SQLite 事务中重验 policy revision、owner/conversation generation、fence 和排除边界。清除即使发生在两个发布步骤之间，后一步也不得重建旧任务。
- 背景供给在来源查询完成后，以单一事务快照复核政策、版本有效性、generation 与来源 fence，再返回正文。关闭/清除/用户纠正期间，旧快照不再作为供给许可。
- 本次只收紧既有不变量，不修改持久化 schema、公共命令或版本号，不引入迁移与启动重置。

## 设置空状态投影

- `getStatus` 增加只读 `hasContent`：查询范围内有非空的当前有效长期文档或有效会话总结时为 true；全局查询汇总所有 owner。开关关闭不代表内容为空，待处理任务、原文索引和排除进度不作为已形成的记忆展示。
- 空状态与清空入口消费该投影，不按 enabled 或当前会话是否打开推测存储状态。不新增持久化字段、业务命令或删除语义；清空仍调用既有范围化命令。
