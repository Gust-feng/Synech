# ADR 0006：未发布 v1 的目标数据基线

> 状态：Accepted（2026-09-30）
> 日期：2026-09-30
> 影响面：SQLite 启动身份校验、owner schema、数据基线门禁和开发数据恢复

## 1. 背景

Synech 尚未发布 v1，没有需要兼容的已发布用户数据。此前将开发期
`synech/v1-baseline-5` 描述为已发布 v1.0.1，并保留精确 ledger 自动升级、
跨 Git 历史不可变 checksum 和 research/1..4 的演进链，形成了不必要的兼容义务。

数据格式身份、SQLite owner 版本、备份 manifest 和上游 Pi transcript 版本是不同事实，
不能为了收敛开发数据基线而统一重编号。

## 2. 决策

- 产品数据身份保持 `synech/v1`。未发布阶段每个 SQLite owner 只定义一个完整目标
  version 1；结构调整直接更新该定义和 `data-baseline.json`，不为旧开发数据追加迁移。
- 删除 `synech/v1-baseline-5` 的自动升级入口，不保留 ledger adoption、表重建兼容链或
  启动时身份改写。未知 namespace、旧格式、旧 owner 版本或不匹配 checksum 明确失败。
- Git 历史中的开发期 checksum 不是兼容承诺。架构门禁检查当前 `synech/v1` 的
  owner/version/checksum 目标形态；fresh Product Home 必须精确匹配当前数据基线。
  已有库仍由 SQLite adapter 校验 owner 版本与 SQL checksum，不跳过完整性校验。
- research/1..4 合并为最终结构的 research/1。此切片保留全部 18 张表、列顺序、
  约束和索引，不恢复研究功能、不增加读写入口；保留这些表不构成永久兼容承诺。
- 启动失败必须关闭 SQLite 连接，并保留原有身份、ledger 和内容。启动不得删除、
  重建、降级或 reset Product Home；数据重置仅由用户显式维护命令执行。
- Backup manifest 保持 version 3 和现有三个 durable root。恢复仍精确校验 schema
  fingerprint 与 ledger，旧开发基线的备份不会因为 manifest 版本相同而被接受。
- Pi 原生 JSONL V4 由 Pi 拥有，本决策不修改其格式、版本或读写规则。
- 正式发布前另行冻结用户数据兼容政策；不能把当前开发期规则当作发布后的迁移规则。

## 3. 影响与备选

旧开发库可能仍标记为 `synech/v1`，但 research/4 或旧 research/1 checksum 会被明确
拒绝。没有自动转换或自动重置。需要保留的材料由用户先单独保存，再决定是否显式重置。

SQLite schema fingerprint 包含 `sqlite_master.sql` 原文。直接建表替代历史 ALTER/RENAME
可能改变 SQL 文本哈希，即使实际结构完全等价；因此应更新 fingerprint，而不是人为
维持历史 SQL 排版或新增 fingerprint 兼容层。其他 owner 的 checksum 不变。

不采用继续追加 research/5 或保留 v1.0.1 升级：两者都将未发布开发历史变成长期兼容负担。
不在本切片删除 research 表：这属于另一次目标结构变化，不能混入结构等价的收敛。

## 4. 验证

- 对旧 research/1..4 和新 research/1 在内存库中比较表、列顺序、默认值、空值约束、
  主键、唯一键、CHECK、外键、索引和 STRICT 属性，证明最终结构等价。
- 通过正式启动入口创建隔离的临时 fresh Product Home，生成并检查当前数据基线。
- 最小核心数据库场景覆盖 fresh 库重开、旧格式/namespace 和旧 ledger/checksum
  拒绝后身份、schema、ledger 与内容保持不变。
- 不读取或重置实际 Product Home，不修改备份 manifest 或 Pi transcript 格式。
