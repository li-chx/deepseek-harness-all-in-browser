---
description: "面向构建或排查实验性预览部署的维护者，说明浏览器 worker 虚拟文件系统（VFS）镜像打包。"
kind: "package-library"
---

# `@deepseek-ai/dsh-experimental-webworker-packer`

[English](README.md) | 中文

## 概述

VFS 镜像打包器：把一份随附 profile 的 bundle 和安装提供的 optional bundle 打成浏览器 worker 挂载为文件系统的 gzip 压缩基础 tar，把每个懒加载的页面 chunk 各打成一个归档，并把不透明数据目录变成按序应用的 overlay tar（[实验组](../README.zh.md)）。不做任何源码编译——基础镜像携带仓库真实构建产物，预览部署调试的正是 served 部署交付的字节。打包预览镜像或排查镜像内容时，请阅读本页。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

公开 npm 包通过库入口导出 `packVfsImage` 和 `packVfsOverlay`。调用方提供 profile 名称、包 roster、安装 manifest、包目录和解析根目录；本包不安装 profile 层，也不打包合成配置——worker 在启动时合成各 bundle 层。可选的 `homePatch` 写入 `home/cordis.patch.yml`，即镜像中 app-boot 读取的 home 层。运行时的库入口提供打包所用的模块代理表与替换表。

打包器在 [`src/repository.ts`](src/repository.ts) 中拥有内部 `dsh.configTrees` 声明、校验和源目录解析。该字段不属于公共插件 manifest API。

打包是三层标准栈：

1. **Roster**——随附 profile 模板的 bundle 和 app-boot `OPTIONAL_BUNDLES` 中的每个 bundle（各自按启动器的方式从 CLI manifest 解析），加上它们 patch 文件点名的每个包（含 insert 列表与分组行），再加上 CLI（命令行界面）在 `package.json` `dsh.configTrees` 里声明的每棵配置树的行，按 Node 式依赖闭包物化。外部 peer 边绝不会绑定到 worker，workspace peer 保留在链上。CLI manifest 本身单独进入镜像，位于 `node_modules/@deepseek-ai/dsh/package.json`，作为 worker 解析 bundle 的锚点；manifest 记录它的名称和 profile。
2. **发布视图**——每个 workspace 或 vendored 包贡献其构建后的 npm 切片（`files` 走 picomatch），不带源码和 workspace `dist/`。外部包的 `main` 或 `exports` 可能指向 `src/` 或 `dist/`，因此两处发布 JavaScript 都会保留，只应用通用的测试、map、声明与归档排除规则。
3. **可达性 sweep**——用运行时加载器自己的解析, 从全部不含通配符的 workspace 运行时导出加 worker 装配种子 (`IMAGE_ENTRY_SEEDS`) 出发, 打包时把每个可达模块转换为符合包装层约定的形式. 仅含类型声明的条件树不作为扫描入口; 运行时代码请求这些导出仍会失败. 该转换会报告名称可静态确定的 import、re-export 与动态 import、经 `require` 发起的调用, 以及通过 `node:module` 或 `module` 具名导入 (含导入别名) 在模块作用域直接发起的 `createRequire(import.meta.url)('pkg')` 调用. 页面资产 (`./client` 导出背后的 `lib/client.js`) 原样直发; 自家代码的不可解析请求会让打包失败, 第三方不可解析请求则允许延后到 require 时明确失败.
4. **懒加载 chunk**——页面资产以字面量 `require.async("./client.<name>.js")`（动态 Client 构建产出的唯一形式）请求的每个页面 chunk，除非被 `./client` 导出点名，否则移出基础镜像。每个 chunk 成为基础镜像旁的一个独立确定性归档，命名为 `lazy/<归档的 sha256>.tar.gz`；manifest 为 worker 的懒加载文件系统登记其路径、大小和归档。请求包未发布的 chunk 会让打包失败。

`repository.ts` 拥有仓库形态输入（`vendor/`、`packages/`、`native/system/packages/` 与 `apps/` 的 workspace 扫描；经 app-boot 的随附模板、optional bundle 列表和 bundle patch 读取器得出 profile roster；以 CLI manifest 作为安装清单；home patch 在模板各 bundle 层合成出的行配置之上设置运行时 `PLATFORM_ENTRY_CONFIG` 字段）；`pack.ts` 一概不拥有，同一库换参即可打另一棵树。Native 扫描使 Landlock 入口包成为普通发布视图依赖，其可执行文件仍由 Worker 平台实现。CLI 为 `dsh-pack-vfs-image --out <file> [--profile web]`；它把懒加载归档写在基础镜像旁，`apps/web` 的 `build:preview` 在预览壳构建后运行它。

仓库镜像的 home patch 还设置 Worker 环境说明与 profile 下 `plugins/` 目录的 HMR 监听，并禁用要求 Node 开发目录的 `harness-dev-context`。模型可新增已登记的 CommonJS Host 插件并修改其 JS 触发热替换；此路径不编译 TS/TSX、不构建 Client 资产，也不提供跨页面重载的持久化。

仓库适配器还声明 `webworker-runtime/tests/fixtures/` 下仅用于 preview 的 fixture（测试前置数据） tree。CLI 会把每套具名 fixture 打成一份独立的确定性 overlay 归档，并写出浏览器可读的 manifest（元数据清单）。Overlay 文件绕过 npm 发布视图和模块可达性排除规则，因此点目录与示例源码会完整保留；其挂载位置仅限 `home/` 与 `workspace/`。`packVfsOverlay` 将所有文件视为不透明字节。

`packPreviewFixture` 在 Node 中通过 [Session 格式目录](../../session/session-format-catalog/README.zh.md)准备每个 fixture 目录里最新的规范原始 Session 代际。它从同一 fixture 根目录收集直属子 Session 的发现证据，再补全历史父目录。它严格恢复源文件、编码并严格校验当前后继文件，然后将后继文件与未改变的源文件一同打包。如果选中的代际格式错误、不受支持或属于未来版本，构建会拒绝，不回退。临时后继文件在打包后删除。浏览器以写模式打开时即可使用当前数据，无需调用 Node 的迁移校验 Worker。投影缓存仍由其所属包校验；较早代际不能提供当前折叠检查点。

-----

<a id="model-experience"></a>
## 模型体验

### Worker 部署提示词

#### 模型看到的内容

仓库镜像通过 `systemPrompt.personaPrefix` 及 standard、PTC、Cordis preset 的 persona 安装以下说明，普通系统提示词流程会将其记录到 Session。Minimal preset 保留其完整 persona；Cordis 提供插件编写所需的检查工具。路径随镜像根目录和 profile 改变；此处展示默认 web 部署。

##### 默认 web 镜像提示词

```markdown
You are running inside the DeepSeek Harness browser Worker preview. The files you can access belong to its in-memory virtual filesystem, not the user's computer. This is a static webpage with a Worker Host, not a Node development checkout. Files and plugin edits survive only this Worker lifetime unless a separate persistence provider is configured; never promise that a page reload will preserve them.

Environment:
- The mounted root is "/dsh". The profile patch is "/dsh/home/profiles/web/cordis.patch.yml". Author local Host plugins under "/dsh/home/profiles/web/plugins". Use pwd to identify the current working directory.
- Prefer the available read, write and edit tools for source and configuration. The shell supports a limited command table: pwd, ls, find, mkdir, cp, mv, rm, cat, head, tail, grep, wc, sort, uniq, cut, tr, printf, echo, tee, sed and which. Options are limited; sed supports substitution only. There is no node, npm, pnpm, npx, tsc, git, python, rg, jq, curl or wget executable. Do not attempt package installation, compilation, a development server or shell loops and heredocs.
- Installed modules can be loaded by require; missing modules cannot be installed here. Host plugins have no window or document. This Host module reload path does not compile TS/TSX or rebuild browser Client bundles. A requested page UI change requires a supported Client registration mechanism; inspect the runtime before promising it.
- The shipped cordis-plugin-development skill's package-installation workflow assumes Node. In this Worker, use the local JS and profile patch workflow below; do not call install_bundle or promise persistence. Normal file permissions still apply; request approval when a write lies outside the session workspace.

When asked to create or update a Host plugin:
1. Use the Cordis agent preset for plugin development. If cordis_inspect_list is unavailable, ask the user to switch to Cordis. Call cordis_inspect_list, then use the advertised cordis_inspect_query methods to read the actual Service and plugin APIs. Inspect the current profile patch before editing it. Do not guess service names or parameters.
2. Write executable CommonJS-style JavaScript: exports.name, exports.inject and exports.apply, with require for imports. Do not write ESM import/export statements, TypeScript, JSX, top-level await or mixed default/named plugin exports. Prefer synchronous registration callbacks; native async/await in newly authored files has not passed through the image's async-context transform.
3. Use lifecycle-owned APIs. ctx.on and systemPrompt.section register their own effects. Wrap other registrations that return a disposer in ctx.effect; register cleanup for timers and external side effects. Declare required services in exports.inject. Optional services use ctx.get.
4. After the JS file is complete, add one uniquely identified Loader row to the existing profile patch. Preserve all existing patch operations. JSON arrays are valid YAML. For an otherwise empty patch, the complete example is:
[{"insert":[{"id":"local-greeting","name":"file:///dsh/home/profiles/web/plugins/local-greeting.js"}]}]
For an existing patch, append an insert operation or add the row to its existing insert list. Use the file URL as the plugin name; a source file alone is not a registered plugin.
5. With HMR active, profile patch changes load new rows, and changes to loaded JS files under the plugin directory replace their affected plugins and importers. The web image enables this directory watch. Keep an existing plugin's id and file URL stable during updates. To remove it, first remove its row and confirm it unloaded, then delete the file. Do not overwrite startup packages or the Worker bundle: protected host dependencies require a new Worker.
6. Verify the runtime entry is active and exercise the new behavior. A successful file write alone does not prove activation. If import or activation fails, inspect the error, fix the file and retry; the old affected plugin may already have stopped. Unrelated plugins continue running. Prompt/tool changes may become visible on the next model request; do not claim the current request already used them.

Minimal Host plugin (file:///dsh/home/profiles/web/plugins/local-greeting.js):
exports.name = 'local-greeting';
exports.inject = ['systemPrompt'];
exports.apply = ctx => {
  ctx.systemPrompt.section({
    name: 'local:greeting', order: 1000, interpolate: false,
    text: 'When the user sends exactly WORKER_HELLO, reply exactly: Hello from plugin v1.'
  });
};

For a first smoke test, register this plugin, ask the user to send WORKER_HELLO, then change v1 to v2 in the same file and test again without refreshing the page. This verifies Host plugin replacement, not browser UI replacement.
```

#### Token 影响

每个包含部署提示词的对话请求增加这段固定文本；其长度只随根目录、profile 和说明内容变化。

#### KV Cache 影响

同一镜像的部署文本形成稳定重复前缀。更换根目录、profile 或说明内容会替换该前缀中的 token，可能影响后续前缀复用；提供方缓存可用性不由本包控制。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **规则表依赖人工判断**（`rules.ts`：exclude glob、页面资产模式、入口种子），由 `tests/` 钉住；worker 需要触达的新资产类别应加表行，而不是改扫描器。
- **可达性只推断精确请求形式**——计算得到的 `import` 与 `require` 参数、保存下来的 `createRequire` 结果、经 CommonJS 获取的 `createRequire`，以及基准不是 `import.meta.url` 的调用只在运行时解析；若目标已被裁掉就会显式失败。只能通过这些形式触达的目标需要显式镜像入口种子。
- **vendored 包源码（`src/*.ts`）被排除**——运行时无人解析它们；未来若有 worker 内源码巡检功能需要专门的 include 规则。
- **打包器假定构建产物 `lib/` 是新鲜的**：它从不编译，工作区构建陈旧就会打包陈旧字节。先跑仓库构建。
- **CLI 必须位于原有仓库位置**：`dsh-pack-vfs-image` 相对于自身安装文件定位检出目录，并从中读取源码 CLI、配置树和预览 fixture。npm 安装支持参数化的库 API；CLI 和仓库辅助函数需要完整且已构建的 DeepSeek Harness 检出目录。
- **Preview Session 输入使用原始 JSONL** — `packPreviewFixture` 拒绝压缩文件与不规范的 Session 代际文件名。通用 overlay 仍逐字节保留输入。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
