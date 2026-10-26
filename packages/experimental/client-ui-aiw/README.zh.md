---
description: "通过 dsh-aiw 页面管理 Worker 本地插件项目、文件、版本恢复与可导入的备份。"
kind: "package-reference"
---

# `@deepseek-ai/dsh-experimental-client-ui-aiw`

[English](README.md) | 中文

## 概述

打开“插件”下方的 **dsh-aiw**，即可编辑虚拟文件、创建并构建本地插件、恢复历史版本、运行精简命令，以及导入导出工作区或插件备份。源码草稿在页面切换后保留。本页面面向浏览器 Worker 部署，复用已有传输、Forge 安装器和存储提供者。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Worker 镜像包含本包的标记插件，并通过 `dsh.client` 发现 Client 入口。打开左侧栏的 **dsh-aiw** 页面即可使用。本地项目不需要单独启动 Node 应用或发布到 npm。

| 页面 | 操作 |
|---|---|
| 插件 | 创建源码项目、通过 Forge 构建、检查安装状态、恢复或导出历史版本，以及过渡期的 npm 插件安装。 |
| 文件 | 浏览可读取的 VFS 路径、编辑文本、新建文件或目录、重命名与删除。已有文件保存必须提供读取时的哈希；冲突时保留草稿。 |
| 命令行 | 从所选目录运行精简 Worker shell；检查 stdout、stderr 与退出码，也可取消进行中的调用。 |
| 备份 | 下载文件树或插件版本 JSON 归档；文件导入先预览并恢复到空目录，插件导入经确认后交由安装器处理。 |
| 设置 | 配置 Forge 地址，并查看构建代际、工作区和 profile 路径。 |

构建结果仅说明 Host 激活状态。Client 组件需要在运行中的页面另外验证。过渡期内，官方“插件”页面仍保留安装控件；这些控件接入 Worker 安装器后，可移除此处临时的 npm 表单。

关闭浏览器前，请使用页面标题旁的“立即保存”。工作台显示浏览器存储已确认的状态；存储停止及启动失败也会在页面外保持可见。持久化由存储提供者负责；本页面不会将未确认的操作报告为已保存。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 — 点击展开</summary>

Client 注册标准的 `sidebar.panellist`、`main` 与 `shell.overlay` 贡献。插件作用域内的控制器负责取消、查询快照、编辑草稿与通知；组件仅接收渲染器绑定的快照和回调。修改操作调用 Worker 本地 AIW 端点，使构建请求继续使用配置的出站 HTTP 提供者。关闭页面会保留草稿，卸载插件则中止未完成请求并阻止迟到的结果发布。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Worker 运行时](../webworker-runtime/README.zh.md) — 文件访问、历史归档、shell 与安装器行为。
- [VFS 打包器](../webworker-packer/README.zh.md) — Worker 部署组合。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只注册浏览器导航和控件。

#### KV Cache 影响

无直接影响；请求构建以及已安装插件的模型可见效果由各自所属的包负责。

## 已知限制与后续工作
<a id="known-limitations-and-deferred-work"></a>

- 备份仅覆盖选定的可读取文件树或完整的历史插件版本；受保护的凭据文件不会导出，导入不会替换运行中的 profile 或会话库。
- shell 是受限的虚拟命令表，不是系统终端。每次调用从所选目录开始。
- 本地草稿在当前页面的导航切换后保留，但刷新前需要保存。文件冲突会保留草稿，不覆盖其他写入者的结果。

-----

<a id="dev-note"></a>
### 开发备注

无。
