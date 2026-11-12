# Synech

**Local-first Agent Workspace · 本地优先的 AI Agent 工作台**

让 AI 对话、工具执行、文件与知识在同一个工作台中协作。

[在线体验](https://gust-feng.github.io/Synech/) · [下载 Windows 版本](https://github.com/Gust-feng/Synech/releases/latest) · [反馈问题](https://github.com/Gust-feng/Synech/issues)

![GitHub Release](https://img.shields.io/github/v/release/Gust-feng/Synech?label=Release)
![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078D4)
![Electron](https://img.shields.io/badge/Electron-36-47848F)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6)

## 关于 Synech

Synech 是一款面向个人使用的本地优先 AI Agent 工作台。它尝试将原本分散的模型对话、工具调用、项目资料和知识整理放到同一个桌面环境中，让 AI 能够围绕具体任务与长期上下文工作。

在 Synech 中，你可以配置自己的模型服务、与 Agent 对话并授权其使用工具，也可以通过 **Space（空间）** 管理文件、笔记和相关资料，逐步积累可再次利用的知识。

> **本地优先不等于完全离线。** 工作空间和主要应用数据由本机管理；连接云端模型或外部服务时，相关请求仍会发送至你配置的服务提供方。

## 主要功能

| 功能 | 说明 |
| --- | --- |
| **多模型连接** | 配置不同模型服务；支持原生服务接入，以及自定义 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 兼容接口。 |
| **Agent 对话与工具执行** | 在对话中使用文件读取、搜索、编辑、命令执行等工具；相关操作受权限与确认策略约束。 |
| **Space 工作空间** | 按项目或主题组织对话、笔记、本地目录及其他参考资料；将真实文件夹关联到空间，而不必将文件迁入应用。 |
| **知识管理** | 整理笔记、页面、主题与关联链接，支持浏览、检索和关联阅读。 |
| **能力扩展** | 支持 MCP 服务、Skills 和 Sub-Agents，将外部工具与专门任务能力接入 Agent 工作流。 |
| **记忆与协作规则** | 提供可管理的记忆功能与全局 / Space 级规则；记忆功能默认关闭，由用户决定是否启用。 |
| **Windows 桌面体验** | 基于 Electron，提供桌面窗口、安装程序和通过 GitHub Releases 分发的更新机制。 |

部分能力依赖模型本身、外部服务配置以及相应的本机权限。

## 在线体验

**[打开 Synech Demo](https://gust-feng.github.io/Synech/)**

在线 Demo 用于体验工作台的界面和基本交互，使用演示数据。

**它不是完整的云端运行版：** 真实模型调用、本地文件操作及部分桌面能力需要使用桌面应用。

## 下载与安装

目前提供 **Windows x64** 安装包：

**[前往 GitHub Releases 下载](https://github.com/Gust-feng/Synech/releases/latest)**

发布页面包含两种安装程序：

- `Synech-Installer-*.exe`：带有定制安装界面的安装程序。
- `Synech-Setup-*.exe`：标准 Windows 安装程序。

安装完成后，在应用设置中添加模型服务，配置所需的 API Key 或使用相应服务支持的登录方式，再选择模型开始使用。

> 使用第三方模型 API 时，可能需要自行准备账号、额度或订阅；Synech 不附带通用的模型调用额度。

## 本地开发

### 环境要求

- **Node.js** >= 22.19.0
- **pnpm** 11.7.0
- Windows 桌面环境（运行 Electron 桌面版）

### 启动开发环境

```bash
git clone https://github.com/Gust-feng/Synech.git
cd Synech

pnpm install
pnpm panel:desktop:dev
```

如需只启动 Panel 的开发模式：

```bash
pnpm panel:dev
```

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm build` | 构建应用代码与 Panel |
| `pnpm test` | 执行核心测试 |
| `pnpm check:baseline` | 检查架构基线及模块依赖 |
| `pnpm typecheck:panel` | 检查 Panel 的 TypeScript 类型 |
| `pnpm panel:desktop` | 构建并运行 Electron 桌面版 |
| `pnpm dist:desktop:win` | 构建 Windows 安装程序（需要对应构建工具链） |

## 技术栈

- **桌面端：** Electron
- **界面：** React、TypeScript、Vite、Tailwind CSS
- **Agent 运行层：** 基于 pi-agent / pi-ai 的适配层
- **工具扩展：** Model Context Protocol（MCP）、Skills、Sub-Agents
- **本地持久化：** SQLite 与文件系统

代码以领域职责分层，区分产品能力、运行适配、界面呈现和基础设施。架构约束和设计决策记录在 [`docs/architecture`](https://github.com/Gust-feng/Synech/tree/main/docs/architecture) 中。

## 数据与权限

Synech 优先管理本机数据与真实工作目录。关联外部文件夹并不意味着应用取得了该目录的所有权；从空间中解除关联不会因此删除原始文件。

Agent 的文件和命令操作受运行时授权与工具确认策略约束。使用外部模型、MCP 服务或网络搜索时，请自行确认相应服务的数据处理政策。

项目仍在持续开发。升级或尝试开发版本前，建议自行备份重要数据；不同开发阶段的数据结构可能不兼容。

## 参与开发

欢迎通过 [Issues](https://github.com/Gust-feng/Synech/issues) 反馈问题或提出建议，也欢迎通过 Pull Request 交流实现。

提交涉及架构、数据生命周期或运行时行为的改动前，建议先阅读 [架构基线](https://github.com/Gust-feng/Synech/blob/main/docs/architecture/%E6%9E%B6%E6%9E%84%E5%9F%BA%E7%BA%BF.md) 与 [开发维护规则](https://github.com/Gust-feng/Synech/blob/main/docs/architecture/%E5%BC%80%E5%8F%91%E7%BB%B4%E6%8A%A4%E8%A7%84%E5%88%99.md)。

---

*Synech — Build a workspace where context stays connected.*
