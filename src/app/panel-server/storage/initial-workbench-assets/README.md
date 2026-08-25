# 内置初始文件

本目录保存全新安装时复制到普通 Space 托管文件夹的初始资产源文件。三张图片与历史 demo 数据使用同一 Unsplash 图片来源；复制完成后，文件与用户创建或添加的文件使用相同的存储、预览、编辑、收藏和删除路径。

- `灵感·山.jpg`：摄影作品，来源于 [Unsplash 图片 CDN](https://images.unsplash.com/photo-1611572789411-6240f6cea970)，作为“我的空间”的默认灵感图片。
- `神经网络结构图.png`：摄影作品，来源于 [Unsplash 图片 CDN](https://images.unsplash.com/photo-1588561181397-fed38f837e17)，桌面上摊开的学习笔记与草图，caption 为“手绘的网络结构与推导草稿”。
- `训练损失曲线.png`：摄影作品，来源于 [Unsplash 图片 CDN](https://images.unsplash.com/photo-1551288049-bebda4e38f71)，屏幕上的性能分析折线图，caption 为“第 3 次实验：验证集 loss 在第 12 轮后开始反弹，疑似过拟合”。
- `PyTorch 入门笔记.pdf`：原项目创建的中文入门学习笔记，覆盖张量与基础运算、自动求导、训练循环骨架三部分。
- `Transformer 精读.md`：原项目创建的 Transformer 论文中文精读笔记。

CS231n 与 Distill 的外部网址通过普通 `web_page` 引用保存，原型中的本地摘要进入 Space annotation，不把第三方网页正文伪装成本地来源。所有这些文件不得被运行时直接修改；初始化只把它们复制到用户的本地数据目录。
