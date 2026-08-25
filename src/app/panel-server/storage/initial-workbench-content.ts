import type { SpaceReferenceAnnotationInput } from "../../spaces/index.js";

export const DEFAULT_SPACE_ID = "space-default";
export const LEARNING_SPACE_ID = "space-learning";

export type InitialWorkbenchFileDefinition =
  | { readonly relativePath: string; readonly source: "text"; readonly content: string }
  | { readonly relativePath: string; readonly source: "bundled"; readonly assetFileName: string };

export type InitialWorkbenchManagedFolderDefinition = {
  readonly id: string;
  readonly spaceId: string;
  readonly title: string;
  readonly files: readonly InitialWorkbenchFileDefinition[];
  readonly imageCaptions?: Readonly<Record<string, string>>;
};

export type InitialWorkbenchWebReferenceDefinition = {
  readonly id: string;
  readonly spaceId: string;
  readonly title: string;
  readonly url: string;
  readonly annotation?: SpaceReferenceAnnotationInput;
};

export type InitialWorkbenchNoteDefinition = {
  readonly id: string;
  readonly spaceId: string;
  readonly title: string;
  readonly bodyMarkdown: string;
};

export const INITIAL_WORKBENCH_SPACES = [
  { id: DEFAULT_SPACE_ID, title: "我的空间" },
  { id: LEARNING_SPACE_ID, title: "学习空间" },
] as const;

export const INITIAL_WORKBENCH_MANAGED_FOLDERS: readonly InitialWorkbenchManagedFolderDefinition[] = [
  {
    id: "builtin-my-space-getting-started",
    spaceId: DEFAULT_SPACE_ID,
    title: "开始使用",
    files: [
      {
        relativePath: "Synech 快速开始.md",
        source: "text",
        content: `# 欢迎使用 Synech

这里是你的默认空间。这里的文件与之后由你或 Agent 创建的文件完全相同：可以编辑、重命名、移动、收藏到知识库或删除。

## 建议从这里开始

1. 在空间中整理与一个主题相关的文件、网页和工作成果。
2. 从首页选择这个空间开始对话，Agent 会以该空间作为工作位置。
3. 把值得长期保留的文件收藏到知识库，再用主题和链接继续组织。

这些初始内容只在全新安装时创建。修改或删除后，软件不会自动恢复。`,
      },
      {
        relativePath: "随手记模板.md",
        source: "text",
        content: `# 随手记

## 我正在想什么

-

## 下一步

- [ ]

## 相关资料

-
`,
      },
    ],
  },
  {
    id: "builtin-my-space-inspiration",
    spaceId: DEFAULT_SPACE_ID,
    title: "灵感收藏",
    files: [
      { relativePath: "灵感·山.jpg", source: "bundled", assetFileName: "灵感·山.jpg" },
    ],
    imageCaptions: {
      "灵感·山.jpg": "像爬山：看不见顶，但每一步都在升高。",
    },
  },
  {
    id: "builtin-learning-study-materials",
    spaceId: LEARNING_SPACE_ID,
    title: "2026年学习资料",
    files: [
      { relativePath: "PyTorch 入门笔记.pdf", source: "bundled", assetFileName: "PyTorch 入门笔记.pdf" },
      { relativePath: "神经网络结构图.png", source: "bundled", assetFileName: "神经网络结构图.png" },
      { relativePath: "训练损失曲线.png", source: "bundled", assetFileName: "训练损失曲线.png" },
    ],
    imageCaptions: {
      "神经网络结构图.png": "手绘的网络结构与推导草稿",
      "训练损失曲线.png": "第 3 次实验：验证集 loss 在第 12 轮后开始反弹，疑似过拟合",
    },
  },
  {
    id: "builtin-learning-reading-notes",
    spaceId: LEARNING_SPACE_ID,
    title: "阅读笔记",
    files: [
      {
        relativePath: "卡片笔记法完整介绍.md",
        source: "text",
        content: `# 卡片笔记法（Zettelkasten）

卡片笔记法的核心不是“记录”，而是“连接”。每张卡片承载一个原子化的想法，通过链接与其他卡片相连，逐渐长成一张思想网络。

## 三类笔记

- 闪念笔记：随手记下的临时想法，当天处理。
- 文献笔记：读到的内容，用自己的话重写。
- 永久笔记：提炼后的原子想法，进入卡片盒并建立链接。

关键在写永久笔记时强迫自己“用自己的话”。这一步就是主动回忆，也是理解真正发生的地方。`,
      },
      {
        relativePath: "Transformer 精读.md",
        source: "bundled",
        assetFileName: "Transformer 精读.md",
      },
    ],
  },
];

export const INITIAL_WORKBENCH_NOTES: readonly InitialWorkbenchNoteDefinition[] = [
  {
    id: "builtin-note-notebook-start",
    spaceId: LEARNING_SPACE_ID,
    title: "从记事本开始",
    bodyMarkdown: `> 起步于微末之处，不惧其浅陋；

> 迭代于寸进之中，自有其峥嵘。

任何系统性的理解，都不是直接生成的终态，而是在大量局部判断的反复修正中逐步拼合而成。这些判断往往是临时的、不完整的，甚至会在之后被推翻，但正是由它们所构成的中间过程，使认知得以从不确定中逐渐走向稳定。对这些过程的记录，其意义并不在于确认当下的结论，而在于保留理解如何形成与变化的轨迹。

从这一角度看，学习并不只是信息的累积，更是一种持续调整认知结构的活动。新的输入不断改变既有判断的相对位置，引发重组、修正与取舍，使原本看似清晰的理解再次接受检验。当这些变化被保留下来，理解便不再停留于瞬时状态，而成为一个可以回顾、比较与重新建构的对象。

因此，记录并非学习之外的附属行为，而是其中自然的一部分。它使认知的发展不必依赖记忆的偶然性，而能够在反复回溯与修订中逐步收敛。当理解被允许在时间中展开时，学习本身也随之呈现为一个持续成形的过程，而非一次性的完成。`,
  },
];

export const INITIAL_WORKBENCH_WEB_REFERENCES: readonly InitialWorkbenchWebReferenceDefinition[] = [
  {
    id: "builtin-learning-cs231n",
    spaceId: LEARNING_SPACE_ID,
    title: "CS231n 课程主页",
    url: "https://cs231n.stanford.edu",
    annotation: {
      markdown: `# CS231n：面向视觉识别的卷积神经网络

这门课深入讲解深度学习在计算机视觉中的应用，尤其是图像分类。课程从最近邻、线性分类器讲起，逐步过渡到神经网络与卷积神经网络。

## 核心主题

- 反向传播与计算图：理解梯度如何在网络中流动
- 卷积网络架构：卷积层、池化层、批归一化
- 训练技巧：初始化、优化器选择、正则化与 dropout
- 迁移学习：如何复用预训练模型

作业围绕从零实现这些组件展开——先手写，再用框架，理解会深得多。`,
      keyPoints: ["从最近邻到卷积网络的完整路径", "反向传播与计算图是理解主线", "作业要求先手写再框架实现"],
      tags: ["CS231n", "计算机视觉", "卷积网络"],
    },
  },
  {
    id: "builtin-learning-distill",
    spaceId: LEARNING_SPACE_ID,
    title: "Distill：特征可视化",
    url: "https://distill.pub/2017/feature-visualization",
    annotation: {
      markdown: `# 特征可视化（Feature Visualization）

神经网络学到了什么？一种回答方式是：通过优化输入，找出能最大激活某个神经元的图像。

从单个神经元，到通道，再到整层，可视化让我们得以“看见”网络内部的表示。越深的层，越倾向于表示越抽象、越语义化的概念。

这类交互式文章的价值在于：把抽象的高维表示，翻译成人能直接看的图。`,
      keyPoints: ["通过优化输入观察神经元激活", "从神经元到通道和整层逐步观察表示", "把抽象的高维表示翻译成可观察的图"],
      tags: ["特征可视化", "神经网络", "Distill"],
    },
  },
] as const;

export const INITIAL_KNOWLEDGE_COLLECTIONS = [
  { key: "inspiration", referenceId: "builtin-my-space-inspiration", relativePath: "灵感·山.jpg" },
  { key: "pytorch", referenceId: "builtin-learning-study-materials", relativePath: "PyTorch 入门笔记.pdf" },
  { key: "network-diagram", referenceId: "builtin-learning-study-materials", relativePath: "神经网络结构图.png" },
  { key: "loss-curve", referenceId: "builtin-learning-study-materials", relativePath: "训练损失曲线.png" },
  { key: "card-notes", referenceId: "builtin-learning-reading-notes", relativePath: "卡片笔记法完整介绍.md" },
  { key: "transformer", referenceId: "builtin-learning-reading-notes", relativePath: "Transformer 精读.md" },
] as const;

export const INITIAL_KNOWLEDGE_THEMES = [
  { id: "builtin-theme-transformer", name: "Transformer", color: "#6865a7", origin: "agent" as const },
  { id: "builtin-theme-training", name: "训练与实践", color: "#c07a55", origin: "agent" as const },
  { id: "builtin-theme-method", name: "读书与方法", color: "#6f8778", origin: "agent" as const },
  { id: "builtin-theme-inspiration", name: "灵感与杂谈", color: "#8a6aa0", origin: "agent" as const },
] as const;

export const INITIAL_KNOWLEDGE_ASSIGNMENTS = [
  { collectionKey: "transformer", themeId: "builtin-theme-transformer" },
  { collectionKey: "pytorch", themeId: "builtin-theme-training" },
  { collectionKey: "network-diagram", themeId: "builtin-theme-training" },
  { collectionKey: "loss-curve", themeId: "builtin-theme-training" },
  { collectionKey: "card-notes", themeId: "builtin-theme-method" },
  { collectionKey: "transformer", themeId: "builtin-theme-method" },
  { collectionKey: "inspiration", themeId: "builtin-theme-inspiration" },
] as const;

export const INITIAL_KNOWLEDGE_LINKS = [
  { fromCollectionKey: "transformer", toCollectionKey: "card-notes" },
  { fromCollectionKey: "loss-curve", toCollectionKey: "pytorch" },
  { fromCollectionKey: "network-diagram", toCollectionKey: "pytorch" },
] as const;
