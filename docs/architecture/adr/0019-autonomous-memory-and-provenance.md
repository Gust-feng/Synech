# ADR 0019：自主记忆整理、双入口供给与来源独立生命周期

> 状态：Accepted（2026-10-03），实现已接入独立开发工作区，尚未迁入共享工作区或发布。
> 范围：Memory、Ordinary 上下文与工具装配、会话删除/分支协调、记忆管理呈现。
> 本变更同步替换整文写入契约、SQL 目标定义、数据基线、后台整理、前台读取与管理界面；不兼容旧开发数据库，不在启动时重置。工程验证不等于真实模型记忆质量评测。

## 1. Owner、范围与唯一入口

Memory 唯一拥有 Space 的已发布历史认识；Workspace 只作为外部文件资源和规则来源。Ordinary 唯一保存原始对话，Conversation owner 创建后不可变；CollaborationRules、Knowledge 归属不变。global 只有默认关闭的 enabled 与管理/清除范围，无 global 内容，不跨 owner 学习。背景、FTS、主题索引、检索 DTO 都是同一 Memory 内容的投影。

复用现有 MemoryFeature、MemoryAdminApplication、MemoryDocumentRepository、MemoryControlRepository、后台 job 与 Pi adapter/辅助模型机制，不创建第二运行时、第二 SQL owner 或可独立写入的索引。当前不实施向量、嵌入配置、查询时第二 Agent、查询时模型改写/重排、通用评分、自动过期或复杂分类。

## 2. 最小内容组织

稳定契约位于 `src/app/memory/entry-contracts.ts`，通过 `memory/index.ts` 输出；Repository 接口位于现有 `store/content-repository.ts`。条目方法已并入既有工厂，整文编辑/发布签名已移除，不同时保留两条产品写路径，也不兼容旧开发数据。

- **MemoryEntry**：稳定 entryId、不可变 Space owner、generation、headRevisionId、创建时间。一条可独立理解和修订的认识，正文保留范围、条件、否定与不确定性，不设机械字数上限。
- **MemoryEntryRevision**：不可变 revisionId、entryId、递增 revision、previousRevisionId、origin、正文、适用范围、时间、主题、直接关联与来源身份。另存可变供给状态 `eligible/revoked`；不能通过改写旧正文表达纠正。
- 修订 `initial` 为首次认识；`supplement` 补充条件或细节而未否定旧理解；`change` 是现实状态/决定发生变化，旧内容在原时段仍可成立；`correction` 明确旧理解错误；`withdrawal` 是用户明确撤回而未提供替代正文。correction/withdrawal 必须列出同条目受影响的旧 revisionId，事务核验并撤销其供给及引用它们的概览；不自动认定全部历史错误。
- **时间**：`occurredAt` 表达认识所述事件/状态的时间，可为空，允许带精度的文本（如“2026 年夏季”）；`reportedAt` 是说明该认识的证据消息时间或用户提交时间；`publishedAt` 是宿主发布时钟。三者不互相替代，不按发布时间推断事件先后。变化原因可为空；有原因必须附合法 sourceId，未知不补造。
- **MemoryTopic**：owner 内稳定 topicId、名称与有证据的别名；不另存可编辑主题正文。修订持有 topicIds 和有依据的直接 related entryId/sourceIds；禁止跨 owner、自环和无限遍历。普通读取最多一跳，分页和预算统一限制。
- **MemorySource**：稳定 sourceId、owner、conversation range + sourceRevision + conversationGeneration，或真实 user_edit requestId。修订明确列举实际使用的 sourceIds；不得机械继承前一整文的所有会话。整理读取旧条目作为依据时，宿主展开其真实来源与 revision CAS，不把条目自身伪装成新原文。

条目正文可以为空仅限 withdrawal。UI 新增或修订条目，概览没有独立编辑权。初始发布不需评分/分类配置。

## 3. 来源状态与认识有效性

来源定位内容不可变；来源 `lifecycle=present/deleted`、`branch=selected/superseded` 为独立宿主事实，防止“曾被退役的来源后来被删除”重新成为当前依据。临时 I/O 错误仅为当前读边界的 `temporarily_unavailable`，不持久化成删除。用户编辑来源 `not_applicable` 不伪造可回看会话。

| 操作 | 必须执行的目标语义 |
| --- | --- |
| 普通 Conversation 删除 | prepare 先 durable fence 并推进会话 generation，阻断接单、原文读取与所有引用该会话的新发布；删除前已发布的合法认识保留。finalize 标来源 deleted，删除该会话原文索引/coverage、全部辅助 summary/FTS、进度和 job；只保留 sourceId、owner、conversationId、range、revision/generation 与时间，删除缓存标题、摘要、原文摘录。重试幂等，tombstone 保留防回填。 |
| 暂时读取失败 | 返回 temporarily_unavailable；不判 deleted、不否定认识。共享数据库完整性错误继续上抛。 |
| clearMemory | 保持既有 allocated ordinal 高水位排除 → fence → purge → 恢复参与顺序；删除范围内条目、修订、主题、关系、来源、概览与全部索引/summary/job，保留排除边界与必要控制事实，不清 enabled。迟到候选不得复活。 |
| owner delete | durable owner fence/tombstone 后清理其全部内容，不改归属或变成 global；不删除外部用户文件。 |
| 用户 correction/withdrawal | 精确目标 entryId + head CAS；撤销明确受影响 revision 的供给，保留审计历史；概览引用受影响版本则整快照停止供给，无自动换绑。 |

来源 deleted 不撤销已发布认识，不授权用已删除的原文/summary 继续补记。候选引用旧条目时，若展开来源包含 deleted/superseded 会话，不得将其作为新候选唯一依据；必须有本批合法新证据或用户提交。发布事务检查所有本任务读取/使用的来源世代，不只主会话；删除与多来源后台读取交错也不能补记。

## 4. 分支替换的可实现策略

沿 Ordinary 现有会话锁、checkpoint 和分支意图 journal，经 `workbench-coordination/conversation-branch-memory` 调用 Memory 生命周期口。Memory 不解析 Pi tip/branch ID。

1. 输入为真实 owner、conversationId、retainedThroughOrdinal。先 fence/推进 conversationGeneration，使旧任务与旧原文读取失效；相同操作重试不能解除更新的 fence。
2. 同会话且 `toOrdinal > retainedThroughOrdinal` 的来源标为 superseded（跨边界来源整段保守退役，不重新拆造证据）；完整保留前缀来源不变。缺少精确分支范围时退役该会话全部来源，明确这是保守供给暂停，不是反证。
3. 修订仍 `eligible`，但只要有依据处于 superseded 分支，当前搜索/背景暂不使用该修订，历史读取标 `historical`。条目没有逐句独立支持结构，无法证明剩余来源支持完整正文，混合来源采用同样保守策略；这是供给暂停而非事实反证。全部依据均为 selected（包括后来 deleted 的来源）或真实用户来源时，head 才可作为当前认识供给；来源删除绝不表示重新核实。
4. 旧 head 失去当前支持时条目不回退为较早 head，不自动创建 correction，也不认为全部事实被反证。更晚合法证据通过 supplement/change/correction 修订恢复当前认识。
5. 概览引用失去当前支持的修订则整快照不可供给；不删旧正文，不把 old branch 当前化。新 head 概览由后续合法发布重建。
6. 清理/重建 selected transcript 索引并删除受影响辅助 summary/job，保留只进不退的 excluded 水位；新任务只读取合法且未被排除的新证据。恢复选择旧分支不自动将已 superseded 来源复活；已有来源可作为历史查看，新认识须重新经当前合法证据发布。

不沿用 `clearConversationMemory` 的“删除认识”含义；目标以 `supersedeConversationSources` 替换该分支入口。普通删除与分支退役使用不同 Repository 方法与状态。

## 5. 概览与固定绑定

复用现有 MemoryOwnerDoc 为派生概览，不新建第二套 overview owner。概览不可变正文及 revision，附准确的 `{entryId, revisionId}` 依赖，和条目修订、来源、summary、进度、job 同事务发布。普通模型发布不撤销旧概览、不自动换绑；已有 `revisionId + generation` binding 可继续使用其固定正文。

`getSupplyableMemoryRevision` 为最终原子核验入口，核验 enabled/rollout、owner generation/fence、概览 validity、依赖修订是否 revoked 及是否失去 selected 支持，并投影**当前**来源状态。deleted 来源不阻断供给；superseded 唯一依据或用户撤销的依赖阻断整快照。来源状态作为独立结构化注释每次读取，不重写绑定正文，不用缓存隐藏删除/退役，也不把状态说明固化到不可变概览正文。

用户编辑写条目并由宿主确定性重建有预算的概览（不调用模型、不让 UI 提交概览正文）。普通新增/supplement/change 保持旧绑定；correction/withdrawal 撤销受影响旧供给。当前 detailed query 可以新于固定 overview，返回自身时间/revision/current head，不声称同一时点。

## 6. 前台查询与后台整理

沿现有 `search_history/read_history` 统一工具链扩展 MemoryEntryQueryPort 的 `searchEntries/readEntry`；工具参数增加 entry 与 summary/transcript 分支，不新增第二套查询业务引擎。Memory owner 由 Host 真实调用会话注入，模型不得选 owner。当前认识为默认；历史命中必须给出 role、currentRevisionId（无当前供给时 null）和时间，旧版本不可冒充现状。FTS5/BM25 只选候选，owner/topic/conversation 条件在 LIMIT 前过滤，最后权威回读。自然语言只作词法查询，不发起模型调用。默认一页最多 8 个结果、总 4000 tokens；读取最多 6000 tokens、一跳关联；包装与来源也计预算，可用 opaque cursor 续读。

后台保留既有 MemoryMaintenanceModelPort.generate 与 `memory_consolidation` 辅助通道。最小实现由宿主给相关条目及合法证据初始输入；模型可返回有界 read requests，由宿主 MemoryConsolidationReadPort 读取再续用同一 generate，最终返回候选。只允许 search_entries/read_entry/read_evidence，限任务 owner、已授予范围和共享 token/deadline/read-call 预算；无任意文件、shell、网络、MCP、写工具或委托。最多 2 轮补充读取（每轮最多 4 个请求）+ 1 次格式修复，具体预算由 maintenance-limits 统一持有。这是现有整理循环的有限 continuation，不新建通用 Agent 引擎。

MemoryDocumentRepository 唯一事务重验 job claim、policy revision、owner/conversation generation、排除范围、overview/summary/entry head CAS、主题/关联/来源 owner 和 provenance；批次任一冲突则整批 discarded。source identity、来源状态、发布时钟、id、revision、generation 由宿主发放，模型只能提供认识候选及允许的证据引用。无新合法证据不改条目；用户编辑是例外。后台调用取消/停机与 scheduler release 必须沿既有 runtime 完成。

## 7. 用户编辑、错误与实施顺序

目标 `UpdateMemoryEntryInput` 为 owner、requestId、显式 create/revise 操作：create 指定新 entryId 且 expectedRevisionId=null；revise 必须 entryId 和非空 expectedRevisionId，并指定 supplement/change/correction/withdrawal。revision CAS 与 requestId 幂等内容校验同事务；requestId 重用且 payload 不同拒绝。更新失败不回落整文写入；不提供概览独立编辑或隐式细粒度永久遗忘。withdrawal 不等于 clear：后续新合法证据可再次形成认识，必须如实说明。

结构错误追加 entry_not_found、source_unavailable、invalid_edit、request_conflict，复用 revision_stale、generation_fenced、capacity_exceeded。普通 UI 编辑管理可以在 enabled=false 时执行；后台/前台工具/自动背景仍遵循参与政策，编辑不能解除 fence。

存储/lifecycle、整理、查询/背景和 admin/UI 共用已接入的产品契约及唯一发布事务。目标 `memory/1` SQL 与数据基线已同步，旧整文接口已移除。只维护当前 synech/v1，不改 package/data version，不追加迁移链；旧 checksum 明确拒绝，数据清理仍须显式维护操作。

核心验证覆盖来源删除保留、在途多来源 fence、分支历史供给及恢复排除水位、精确纠正撤销、条目 CAS/幂等、备份恢复、正常关服排空和预算分页。查询投影分别分页正文、适用范围、原因与来源，避免来源增长让合法条目无法读取。每条修订最多 4 个主题和 3 个直接关联，主题最多 4 个别名；当前不支持无限关系展开。

## 8. 可选增强与实验范围

当前记忆是无需嵌入模型的完整能力。稳定条目/修订身份、owner、内容版本和统一查询入口为后续检索适配提供边界；索引只作可重建投影，不拥有正文或独立写权限。现在不加入向量依赖、模型下载/配置入口、索引占位表或待办任务，也不冻结向量库和 provider。未来如实施增强，后台从仍获准保留的已发布内容构建索引，并与词法候选融合；未开启或暂不可用时，词法能力继续工作，增强状态如实报告。更换嵌入模型须重建，迟到索引任务不得复活已清除的内容。

查询时委托记忆 Agent 仅保留为实验方向，未实现。候选是受限检索 Agent 汇总证据后交给前台，复用既有运行时，不产生永久记忆写入、不扩大 owner、不得递归委托。只有直接检索确实不能满足实际任务时，再比较证据支持、误召回、延迟和成本；不以工具数量或模型调用率作为质量指标。

工程验证使用临时 Product Home 和可控模型替身，不调用真实模型 API，不证明内容提炼的生产准确率。本机正常 Product Home 未因开发验证被修改。
