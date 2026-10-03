# ADR 0001：模型能力事实源从手工表迁移到「pi 生成目录镜像 + 手工差异登记」

> 状态：Superseded（模型目录镜像与差异登记由 ADR 0004/0005 的 Pi 唯一事实源决策替代）
> 日期：2026-09-23
> 影响面：`src/app/model-runtime` 能力解析链；`ModelCapabilities`（只增 `imageInput.source` 一个枚举值）；新增构建期脚本与生成文件；不改任何公共命令/SQLite schema/事件契约
> 本文保留历史决策背景，不是当前实现规范；当前模型事实与协议边界见 ADR 0004/0005。

---

## 1. 背景

### 1.1 现状（已对照工作区代码核对）

模型能力事实的唯一来源是 `src/app/model-runtime/model-capability-definitions.ts`（627 行）：**29 个 `modelPattern` 手工条目**，每条声明 `contextWindowTokens / maxOutputTokens / supportsToolCalling / supportsParallelToolCalls / supportsStructuredOutputs / supportsStreaming / supportsVisionInput / supportsReasoningEffort / supportsReasoningOutput / preferredApiStyle / stability / reasoningControl`，并带 `VERIFIED_AT` 时间戳（`2026-06-28` ~ `2026-07-18`）。

解析链（`model-capability-resolution.ts:20-53`）：

```text
profile.model + providerKind + protocolKind + profileId
  → BUILTIN_MODEL_DEFINITIONS.find(definition.providerProfileId 匹配 && model.includes(pattern))   // 首个命中即用
  → 未命中：PROTOCOL_BASELINE_MODEL_CAPABILITIES  // ctx 256K / max 32,768 / supportsToolCalling=false
  → constrainCapabilitiesToProtocolToolCalling(protocol-capabilities.ts)
  → 用户 override（ModelCapabilityOverrideSettings，ConfigCenter 持久化）
```

即：**已知模型 = 手工事实；未知模型 = 粗糙协议基线；用户可再覆盖。**

### 1.2 已实证的缺陷：手工表与 pi 生成目录实质漂移

`@earendil-works/pi-ai@0.80.10` 自带构建期生成的模型目录 `dist/models.generated.js`（35 个 provider、**1072 个模型**，每个模型带 `contextWindow / maxTokens / reasoning / input / thinkingLevelMap`）。对同一个模型的抽样比对（右列为 pi 目录）：

| 模型 | 手工表 ctx / max | pi 目录 ctx / max | 结论 |
|---|---|---|---|
| `gpt-5.4` | 1,050,000 / 128,000 | **272,000** / 128,000 | 差 3.9× |
| `gpt-5.6-sol` | 1,050,000 / 128,000 | **272,000** / 128,000 | 差 3.9× |
| `gpt-5.4-mini` | 400,000 / 128,000 | 400,000 / 128,000 | 一致 |
| `deepseek-v4` | 1,000,000 / 384,000 | 1,000,000 / 384,000 | 一致 |
| `kimi-k3` | 1,048,576 / 128,000 | 1,048,576 / 131,072 | max 差 2.4% |
| `glm-4.7` | 200,000 / 128,000 | 204,800 / 131,072 | 差 2.4% |
| `glm-5.2` | 1,000,000 / 128,000 | 1,000,000 / 131,072 | max 差 2.4% |
| `minimax-m3` | 1,000,000 / 524,288 | 1,000,000 / **128,000** | max 差 4.1× |

6 个有手工条目的模型家族里 3 个实质分歧，幅度最大 4 倍，且**方向不定**（有大有小）。这不是文案问题：

- `contextWindowTokens` 决定压缩阈值 `shouldCompact(contextTokens, model.contextWindow)`（`src/adapters/intelligence/session-context-compaction.ts:55`）与 composer 上下文环。`gpt-5.4` 被低估 3.9× ⇒ 提前压缩、上下文环虚高。
- `maxOutputTokens` 直接进请求。`minimax-m3` 被高估 4× ⇒ 可能被 provider 拒绝。

手工表的维护方式（人工核对 vendor 页面 + `verifiedAt`）没有任何机制能发现这类漂移，而 pi 目录是上游构建期生成、随版本更新。

## 2. 决策

### 2.0 第一事实源（2026-09-23 收口决策）

**对四个镜像字段（`contextWindowTokens` / `maxOutputTokens` / `supportsReasoningOutput` / `supportsVisionInput`），pi 生成目录是第一事实源；全部按 pi 收敛。**

理由：

- pi 的目录是**构建期生成**的单源（上游 `scripts/generate-models.ts`，从 provider 数据源刷新后随包发布），规模 1072 模型 / 35 provider，且被大量下游复用；本地人工核对（`VERIFIED_AT 2026-06-28`）无法跟进。
- 漂移报告实测：手工表与 pi 在**已抽样模型上 3/6 实质分歧，幅度最大 4 倍**，且方向不定（详见 1.2 与第 8 节收编记录）。
- 方向性偏误上，pi 的价值也优于本地猜测：上下文低估只会导致提前压缩（安全），高估会直到爆上下文才报错（不安全）；maxOutput 高估会被 provider 拒绝，低估只截断输出。

因此手工层对这四个字段的角色收缩为：**仅当 pi 目录没有该模型条目时，才作为唯一来源**（例：`glm-4.5v`、`deepseek-chat`、`deepseek-reasoner`、id 含 `vision` 的自定义模型）。

### 2.1 分层与优先级

模型能力事实变为三层，**优先级从高到低**：

```text
1. 用户 override         （已存在，ConfigCenter 持久化，能力最强，不动）
2. 手工定义层             （model-capability-definitions.ts，保留，但收缩为「登记处」）
3. pi 生成目录镜像        （新增：src/app/model-runtime/model-capability-definitions.generated.ts）
4. 协议基线兜底           （PROTOCOL_BASELINE_MODEL_CAPABILITIES，未知模型最后兜底，不动）
```

**关键取舍：生成层只作为「精确 model id 的兜底层」，手工 pattern 层保持优先。** 理由：

- 本次变更不应同时翻转全部已知模型的能力事实——那会让改动的影响面变成「所有模型」，且无法逐条判定谁对。
- 生成层的第一阶段收益在**当前掉到粗糙协议基线的模型**上：没有手工 pattern 的新模型（例如 `gpt-5.3-codex`、`deepseek-v4-pro` 之外的变体、Moonshot/GLM 的下一个版本）今天拿到的是 ctx 256K / 不支持工具调用，接入后拿到真实事实。
- 分歧通过「漂移报告」逐条显式化，再决定是否收编进手工层（收编时更新 `lastVerifiedAt`）。手工表因此**随时间收缩**，而不是一次性大翻转。

### 2.2 生成层内容（镜像哪些字段）

只镜像 pi 目录中 Synech 解析链直接消费的字段：

| 镜像字段 | 来源 | 说明 |
|---|---|---|
| `contextWindowTokens` | `model.contextWindow` | |
| `maxOutputTokens` | `model.maxTokens` | |
| `supportsReasoningOutput` | `model.reasoning` | |
| `supportsVisionInput` | `model.input.includes("image")` | 最终 gate 仍是 pi 的 `model.input`（见 `model-provider-binding.ts:158`） |
| `providerProfileId` | pi provider id 映射（见 2.4） | |

**不镜像（明确排除，各自有单独决策点）**：

- **定价 `cost`**：映射成本与 UI 展示是独立决策（当前已决定暂不做），不在本变更范围。
- **`thinkingLevelMap`**：请求期的推理档位映射由 `openai-compatible-chat-protocol.ts` 的方言层承载，接入它会改变 5 家 vendor 的实际请求字段。单独切片。
- `supportsParallelToolCalls / supportsStructuredOutputs / supportsStreaming`：pi 无非等价标志，继续由协议层推导（`protocol-capabilities.ts`）。
- `stability`：pi 目录无此概念，手工层保留。

### 2.3 生成方式

- 新增 `scripts/generate-model-capabilities.mjs`：**构建期**读取本仓库安装的 `@earendil-works/pi-ai` 的 `dist/models.generated.js`，过滤 Synech 支持的 provider（见 2.4），按规范化 model id（小写）输出生成文件。
- 输出为 **TypeScript 模块**（`model-capability-definitions.generated.ts`），不引入 JSON import（`tsconfig.json` 为 `NodeNext`，无 `resolveJsonModule`），也不新增依赖。
- 生成文件是**纯静态数据**：运行期解析链不 import pi 的任何内部路径；`pnpm check:baseline` 看到的是一个普通源文件。
- 生成文件头部带 `piAiVersion` 与 `generatedAt`。`build:node` 前若检测到版本戳与已安装 `@earendil-works/pi-ai` 版本不一致，则重新生成（或直接由 `generate-model-capabilities` 纳入既有脚本链）。
- 生成必须幂等、无网络访问、不读任何密钥。

### 2.4 provider 映射

pi provider id → 应用 `ProviderProtocolProfileId`（`domain/config/model-settings.ts:9-15` 的闭联合）：

| pi provider | 应用 profileId |
|---|---|
| `openai` | `openai` |
| `deepseek` | `deepseek` |
| `moonshotai`、`moonshotai-cn` | `moonshot` |
| `minimax`、`minimax-cn` | `minimax` |
| `zai`、`zai-coding-cn` | `glm` |
| 其余全部 provider | **不镜像**（`openai_compatible` profile 的用户自带端点无 vendor 事实可用；镜像只会制造噪声） |

### 2.5 解析顺序（实现约束）

按 2.0 的第一事实源决策，实际实现是**逐字段合并**，而不是「整层替换」：

```text
model = profile.model.toLowerCase()
生成层命中（精确 id，按 providerProfileId）→ 四个镜像字段优先取生成值
手工 layer 命中                        → 补 app-only 字段（reasoningControl / stability /
                                        preferredApiStyle / supportsToolCalling / …），
                                        并对四个镜像字段做「pi 没有该模型时」的兜底
都不命中                              → 协议基线（PROTOCOL_BASELINE_MODEL_CAPABILITIES）
用户 override                         → 仍然最强（ConfigCenter，不改）
```

- 手工 `.find` 的 `model.includes(pattern)` 语义不变，家族模式继续承担「任意自定义 id」的识别。
- `imageInput.source` 标记事实来源：`pi_catalog` / `registry` / `protocol_default` / `override`，使面板与漂移报告可区分。

## 3. 影响面

### 3.1 文件

| 文件 | 变化 |
|---|---|
| `scripts/generate-model-capabilities.mjs` | 新增：读 pi 目录、过滤、规范化、写生成文件；`--report` 输出漂移报告；默认模式写入生成文件（挂进 `build:node`） |
| `src/app/model-runtime/model-capability-definitions.generated.ts` | 生成数据 + `PI_MODEL_CATALOG_VERSION` / `GENERATED_AT` 戳；**已 gitignore**（构建期产物） |
| `src/app/model-runtime/model-capability-definitions.ts` | `ModelDefinition.capabilities` 改为 `ModelDefinitionCapabilities`（四个镜像字段变可选）；**删除 94 条已被 pi 覆盖的镜像字段声明**，保留 16 条（仅 pi 缺失的 4 个模式） |
| `src/app/model-runtime/model-capability-resolution.ts` | 逐字段合并 + 生成层兜底与来源标记 |
| `package.json` | `build:node` 前置 `generate:model-capabilities` |
| `src/domain/config/model-settings.ts` | `imageInput.source` 增加 `"pi_catalog"`（只增枚举值，见 3.2） |

**不变**：`protocol-capabilities.ts`、用户 override 层、`model-provider-binding.ts`、Session/压缩链、Panel DTO、SQLite schema、事件契约、公共命令。

### 3.2 契约变化（最小且只增）

`ModelCapabilities.imageInput.source` 由 `"registry" | "override" | "protocol_default"` 增至四值（加 `"pi_catalog"`）。该字段只携带 provenance，不参与程序分支（`status` 才是分支依据），符合架构基线错误码/结构字段与展示字段分离的规则。

### 3.3 不需要新增测试

依据仓库测试做减法原则：本变更不触及数据持久化、权限、删除、并发或发布阻断路径；能力解析是纯函数，且已有 `tests/` 覆盖核心链路。验证手段是**漂移报告**（下节）与既有构建/类型/基线检查。

## 4. 备选方案（已评估，不采用）

| 方案 | 不采用的原因 |
|---|---|
| 维持手工表 | 已实证漂移 3.9×/4.1×，无任何自动发现机制 |
| 运行期直接 import pi 的 `models.generated.js` | 把 pi 内部实现细节变成运行期依赖；升级 pi-ai 会**静默**改变线上能力事实，无法对账；且 `check:baseline` 之下等于跨包数据耦合 |
| 直接用生成表**替换**手工表 | 一次性翻转所有已知模型的能力来源，影响面不可控；且手工表持有生成表没有的事实（`reasoningControl`、`stability`、参数风险策略、`verifiedAt`） |
| 用 pi 的 `Models.refresh()` / `models-store` 动态刷新 | 那是 provider 自定义目录的运行时缓存，Synech 的模型是用户在设置里填的；且 OpenAI 兼容 `/models` 不返回能力字段。已核实无适用面 |
| 顺手把 `cost` 一起镜像 | 涉及价目 owner 与 UI 决策，当前已决定暂缓，混入会使本 ADR 的边界失焦 |

## 5. 后果与风险

**正面**

- 未知模型不再拿到「256K/不支持工具调用」的粗糙基线；新模型（无手工 pattern）自动获得真实上下文与视觉能力。
- 手工表漂移由漂移报告持续暴露，可逐条收敛；漂移成为可见的、可审阅的工件，而非隐性风险。
- 为后续 Anthropic 等协议扩张提供能力事实供给（Claude 的 ctx/max/视觉/推理可由同一生成链产出），不必再手抄第二条表。

**负面 / 风险**

- 引入「pi 目录可能本身错」的风险。按 2.0 的决策，pi 值即为生效事实；若发现 pi 错，正确做法是**提交上游修正 + 本地用户 override**，而不是在手工层重新声明镜像字段（那会重新制造漂移）。
- 新增构建期步骤与生成文件；升级 pi-ai 后需重跑 `generate:model-capabilities`（已挂进 `build:node`）。升级即能力事实更新，这是刻意选择：让上游成为事实的传播路径。
- `pi_missing` 的 4 个模式（`glm-4.5v`、`deepseek-chat`、`deepseek-reasoner`、`vision`）是手工层必须保留的部分；上游覆盖它们之后，对应条目应删除。

## 6. 实施顺序（已完成）

1. **切片 1：生成脚本 + 漂移报告**（无行为变化）。产出 `--report`：对 5 家 vendor 的 pi 目录 id 与手工 pattern 逐条比对，输出「一致 / 分歧（精确 / 家族）/ 手工缺失 / pi 缺失」。首轮报告：67 镜像模型 / 28 模式 → 一致 31、分歧 31（精确 11、家族 20）、手工缺失 5、pi 缺失 4。
2. **切片 2：解析链接入生成层**：逐字段合并（2.5）、`imageInput.source = "pi_catalog"`、`build:node` 前置生成步骤、生成文件 gitignore。
3. **切片 3：按「pi 第一事实源」收敛**：删除 94 条已被 pi 覆盖的镜像字段声明，保留 16 条（仅 pi 缺失的 4 个模式：`deepseek-reasoner`、`deepseek-chat`、`vision`、`glm-4.5v`）。

## 7. 验证

- 仓库验证清单：`pnpm check:baseline`、`pnpm typecheck:panel`、`pnpm build:panel`、`pnpm check:whitespace` 全部通过。
- `pnpm test:core`：**139/139 通过**（本工作树从 `main` 干净切出；主工作树那 2 个 schema 哈希失败源于该树的脏改动，与本变更无关）。
- 行为核对（一次性脚本，未入库）：20 个用例逐条比对 `resolveModelCapabilities` 结果——pi 覆盖的模型取 pi 值且 `imageInput.source = "pi_catalog"`；pi 缺失的 4 个模式取手工值且为 `registry`；完全不认识的 id 落 `protocol_default`。结果 20/20 符合预期。
- 已知上游断裂（与本变更无关，HEAD 即存在）：`pnpm build:node` 在 `src/app/panel-demo/panel-demo-transport.ts` 报 `@panel-api/workbench` 解析错误，导致 `pnpm build` / `pnpm test` 无法整链跑通；本变更是用 `tsc -p tsconfig.json` 直跑验证 emit 的。

## 8. 收编记录（切片 3 的实际后果）

| 模型 / 模式 | 旧值（手工） | 新值（pi） | 影响 |
|---|---|---|---|
| `gpt-5.4` / `gpt-5.5` / `gpt-5.6-sol|terra|luna` | ctx 1,050,000 | **272,000** | 压缩阈值下调，上下文环校正 |
| `gpt-5-chat-latest` / `5.1` / `5.2` / `5.3` `-chat-latest` | ctx 400,000 | **128,000**，且 `reasoning=false` | chat 变体不再按推理模型处理 |
| `gpt-4o-2024-05-13` | maxOutput 16,384 | **4,096** | 该快照的真实上限 |
| `gpt-4`（精确 id） | 无条目 → 基线 256K | **8,192** | 旧版 8K 上下文模型不再被高估 |
| `o3-mini` | 视觉=true | **false** | 不再对文本模型发图 |
| `kimi-k2.7-code` / `kimi-k2.6` / `kimi-k2.5` | ctx 256K / max 32K | **262,144 / 262,144** | 长输出不再被截断 |
| `kimi-k2-0711-preview` | ctx 256K | **131,072** | |
| `kimi-k3` | max 128,000 | **131,072** | |
| `glm-4.7` | 200K / 128K | **204,800 / 131,072** | |
| `glm-5-turbo` / `glm-5v-turbo` | ctx 128K，`reasoning=false` | **200,000**，`reasoning=true`（5v 视觉=true） | |
| `minimax-m2.7*` | max 204,800 | **131,072** | |
| `minimax-m3` | max 524,288 | **128,000** | 高估 4 倍的字段收敛 |
| `gpt-4`、`gpt-4-turbo`、`gpt-realtime-2.1`、`o1`、`o1-pro` | 基线 256K/32K | 真实值（如 `o1-pro` 200K/100K） | 切片 2 的补缺收益 |
| `glm-4.5v`、`deepseek-chat`、`deepseek-reasoner`、id 含 `vision` 的自定义 id | 手工值 | **仍取手工值**（pi 无条目） | 证明手工层不可删 |
