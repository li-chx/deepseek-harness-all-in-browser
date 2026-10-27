---
description: "面向构建或排查实验性 Web 预览运行时的维护者，说明浏览器 worker 中的 harness 托管。"
kind: "package-library"
---

# `@deepseek-ai/dsh-experimental-webworker-runtime`

[English](README.md) | 中文

## 概述

浏览器 worker 宿主：整棵 harness 插件树跑在一个 dedicated Web Worker 里，用于预览部署与打包回归（[实验组](../README.zh.md)）。worker 边下载边解压打包好的 VFS 镜像并挂载进内存，经 CommonJS 包装加载器装载模块，并通过一条讲纯 HTTP 的 postMessage 隧道服务页面。当预览需要在没有 Node 宿主的环境中运行已打包 harness 时，请使用它。

## 目录

- [使用本包](#use-this-package)
- [AIB 工作台](#aiw-workbench)
- [浏览器持久化](#browser-persistence)
- [Forge 插件更新](#forge-plugin-updates)
- [出站 HTTP 提供器](#outbound-http-providers)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

公开 npm 包在根入口导出运行时库，通过 `./worker` 提供自包含的浏览器 Worker，通过 `./client` 提供页面连接器，通过 `./service-worker` 提供资源桥接。部署方通过 [打包器](../webworker-packer/README.zh.md) 单独提供和托管 VFS 镜像；安装此库不会增加 profile 层。根入口还导出打包器所用的模块代理表与替换表。

嵌入方可以向 `chooseWorkerHostSource` 传入 `fixture`，在不修改浏览器 URL 的情况下选择 `none` 或内置 fixture ID。省略时读取页面 URL 的 `preview-fixture` 参数，或打开来源选择器。仓库预览页的[构建环境默认值](../../../README.zh.md#run-the-browser-preview)会先处理 URL 覆盖，再传入选择结果并配置 Forge 与持久化。

一条 tsdown 管线产出四个构建产物；另有一层由源码维护的进程实现：

- **`lib/index.js`（装配库）**——`createWorkerHost`/`startWorkerHost` 挂载基础镜像和按序排列的数据 overlays（`storage/`）、登记镜像的懒加载归档、安装模块加载器（`module-system/`）与 `process` shim、经镜像自带的 `dsh-app-boot` 启动插件树，并把服务 seam 交给隧道。Overlay 只能替换 `home/` 与 `workspace/` 下的文件，不能替换基础 manifest 或模块。镜像布局契约（`image-layout.ts`：虚拟根、manifest 路径、懒加载归档目录、空目录）与 manifest（`image-manifest.ts`：profile、安装清单、`lowered` 包装契约门、懒加载归档）与 packer 共享。Worker 按启动器的方式启动 manifest 指定的随附 profile：镜像里的 app-boot 用随附模板初始化 `home/profiles/<profile>/`，从镜像单独携带的安装 manifest 解析 bundle，并合成各 bundle 层、profile patch 与 home patch。profile 上下文、启动环境快照，以及不带运行时 resolution 的 `PluginPackages` 服务都按启动器的方式提供；模块解析由 Worker 加载器负责。profile 上下文不带命令行 overlay；packer 按 `PLATFORM_ENTRY_CONFIG` 写入镜像的 home patch（`home/cordis.patch.yml`），使 JSONL Session 日志保持明文。ConfigEditor 将覆盖值持久化到 profile patch，协调每次写入，Loader 提交实时值。Worker 在隧道开始服务后提交 `appReady`。其 `hmrModules` provider 将 Worker 模块缓存接入 [profile HMR](../../boot/hmr/README.zh.md)，使配置和已加载代码的变化共用现有重载队列。插件管理可以列出并开关安装提供的 optional bundle，其包操作会因 `execa` 拒绝而失败。未接入持久化控制器时，配置修改在当前 Worker 生命周期内有效。
- **懒加载归档**——manifest 按路径和大小登记 packer 移出基础镜像的每个页面 chunk，并给出相对镜像 URL 的归档名。存在性、stat 和目录列表立即作答；第一次异步读取（`fs.promises.readFile`、`fs.promises.open`、`fs.createReadStream`、`fs.promises.cp`）为所有等待中的读取方只拉取并解压一次该归档，按登记内容校验后挂载其文件，不发布 mutation。拉取失败时本次读取被拒绝，文件保持登记状态，下次读取会重新拉取。在此之前，对已登记文件的同步读取、写入、追加、截断、chmod、rename 和 link 会以 `ERR_DSH_VFS_DEFERRED` 失败，错误中写明归档名；unlink 和递归删除会移除登记，再次 seed 该路径会替换登记。归档名由内容摘要派生，拉取时只校验登记的路径和大小，不校验摘要。登记了懒加载归档的镜像必须以 URL 传入。
- **`lib/worker.js`（worker 束）**——装配库加本包的 Node 兼容层，合成一个自含 ES module。模块代理表（`module-proxies.ts`）是唯一平台叉口：`node:*` 内建走 VFS、隧道和浏览器原语，浏览器做不到的走结构化 stub（调用即在 console 报错并抛出），native/binary 包则替换执行后端。`node:module` 在镜像 package 根之上提供 `createRequire().resolve` 与 `.resolve.paths()`，使未修改的包无需执行目标模块即可发现 manifest。`node-addon-require-builtin` 应答 vendor Loader、app-boot 和 HMR 在没有 `--expose-internals` 时读取的 Node v24.18.0 internal 模块：cascaded ESM loader 的 `resolveSync` 和 `import` 经 Worker 加载器完成，失败时带 Node 的 `ERR_MODULE_NOT_FOUND` 与 `ERR_PACKAGE_PATH_NOT_EXPORTED` 错误码，`loadCache` 为空；HMR 会替换的 CommonJS loader、package reader、`modules` binding 与 resolve cache 成员被调用时拒绝。`process.versions.node` 报告 `24.18.0`，因此 `ModuleLoader.fromInternal()` 和 Loader 的 `internal` 拿到的是这个 cascaded loader。`node:path.win32.isAbsolute` 与 `node:util.inherits` 与 Node 一致，其余 `win32` 成员抛出。`node:util` 的 JSON 数据比较器检查可枚举的自有属性，使 `__proto__` 等记录字段的准入判定与 Node 一致。全局 `process` shim 带有包括 `title` 在内的 Node 环境识别字段，避免 Worker 执行误入仅适用于 DOM 的分支。pack 期解析器会把名称静态可知的模块请求报告给 packer 的可达性遍历，其中包括通过 `node:module` 或 `module` 具名导入在模块作用域直接发起的 `createRequire(import.meta.url)('pkg')` 调用。保存、经 CommonJS 获取或另设基准的 `createRequire` 调用需要镜像入口种子。VFS mutation 驱动 `node:fs` 的 callback、polling 和 promise watcher，监听回调运行在创建 watcher 时的异步上下文中，而不是写入方代码的上下文中；打开的 descriptor 在 rename、replacement 和 unlink 后仍保留文件身份与访问模式，只要文件名仍指向该文件，`FileHandle.stat({ bigint: true })` 报告的 device 与 inode 身份就与路径 stat 相同，`FileHandle.chmod()` 则更新打开文件身份的权限；`readable-stream` 提供 `node:stream/promises` 的完成等待与管道方法，以及文件流以及 Chokidar、readdirp 等未修改镜像包所用的流状态机。`node:string_decoder` 使用维护中的 npm 解码器，在流分块之间保留未完整接收的 UTF-8 和 UTF-16 字符。AsyncLocalStorage 经 pack 时降低注入的 snapshot/restore 面在 `await` 间携带同步栈因果。worker 不带编译器：packer 未降低的镜像在挂载时被拒。回调式 `fs.realpath.native` 别名在已挂载的 VFS 内解析路径，并支持 `util.promisify`。同步 SHA-1/SHA-256/SHA-512 哈希和 HMAC 使用 Noble；等长字节比较会访问每个字节，但 JavaScript 不提供原生计时保证。
- **`src/shell/`（worker 自己的进程层）**——浏览器 worker 无法 fork，所以 `node:child_process` 不是 stub 而是实现：`spawn` 把命令放进它自己的 Web Worker——就是这同一个束，由首帧告诉它「你是 shell 进程」——并以 subprocess 服务消费的 `ChildProcess` 面报告结果。命令不占宿主线程，`SIGKILL` 不管它在干什么都能终止它，文件系统及已登记宿主命令的请求通过消息到达宿主。取消后，shell 等待已接受的宿主操作结束才报告退出。Worker 平台 executable 在不替换 JavaScript 包、也不把具体实现耦合进 `node:child_process` 的情况下保持 Landlock 等 native 包协议；`xdg-open` 把一个 VFS 文本文件交给页面的只读查看器，因此 **打开配置文件** 等桌面打开操作会在页面内显示该文件；普通命令使用本包的求值器与 coreutils 命令表。语法来自 `@yarnpkg/parsers` 的 `parseShell`，而 `execSync`/`fork` 依然拒绝，因为它们需要真进程。
- **`lib/service-worker.js`（资源桥接）**——部署方通过 `connectWorkerHost(worker, { serviceWorker })` 启用，并将该模块托管在 `preview.html` 同目录。预览页要求 HTTPS 或 `http://localhost`（回环地址同样适用）。连接器在执行 Host 索引注入前等待 Service Worker 控制页面。来自 `preview.html` 的同源脚本、图片、音频和 Fetch 请求到达该页面自己的 Worker；生成的 `preview/static-assets.json` 清单内文件、`/preview/` 下载、导航和其他页面仍访问静态服务器。每次导航到预览页都会刷新清单，使新部署的静态分块在 Host 连接前仍可加载。桥接不缓存响应，Host 拒绝请求后也不回退。每个请求使用独立的可转移通道，各标签页保留各自的 Host。Host 在内部将启动令牌换成带签名的浏览器会话 cookie；凭据留在 Worker 内，路由照常鉴权。`disposeServiceWorker()` 中止正在转发的请求并移除页面监听器，保留共享注册；调用方另外关闭自己的 Worker。部署时应连同页面提供桥接脚本和静态清单；已有其他 Service Worker 占用作用域时启动失败。
- **`lib/client.js`（页面半）**——启动分为相互独立的两段。`chooseWorkerHostSource({ image?, fixtureManifest? })` 可选地拥有 boot barrier 与 fixture manifest：没有 `preview-fixture` 时停在来源选择面板，合法 query 则直接选择；两条路径都返回按序排列的 overlays。`connectWorkerHost(worker, { image?, overlays? })` 仍是公开的基础运行态连接器；调用方跳过选择器时 overlay 列表为空。`apps/web` 调用这两段并提供静态打包的 Worker。开局 `init` 帧携带基础镜像与按序排列的 overlay URL，boot 载荷送达结构化 index 注入表，`applyIndexInjections` 在壳入口运行前逐行执行。脚本 preload 行只是提示，因此会被跳过：`/plugins` 资源只能经 tunnel 解析，`loadBundle` 会在首次需要时获取 combo、把仅 tunnel 可达的 sourcemap 内嵌为 Base64 data URL，再以 Blob 执行脚本。worker 主动发出的 `view-text` 帧会打开页面的模态文本查看器。Tunnel 还暴露 fetch 形式的传输、独立文件上传载体和 API 客户端。请求帧通过结构化克隆保留 Blob 请求体，并转移 `ReadableStream<Uint8Array>` 的所有权。Host Worker 将两种请求体都逐块送入路由，因此通用文件上传不会在任何浏览器线程创建完整字节数组。Remote 流的上行以 `stream-uplink-item` / `stream-uplink-end` 帧进入没有上限的 `TunnelUplink`，`end` 之后到达的项被丢弃：页面与其 worker 是同一个可信的同源边界，Host 的 inbox 上限在此不适用。

在显式根上下文中登记的回调和定时器保留其空 store，避免继承无关事务。

验收在 `apps/web/tests/preview-boot.e2e.ts`：静态服务真实构建页面，在 headless Chromium 里驱动 pre-boot 选择面板与 Worker 激活。空白选择验证首次启动；`vfs-example` overlay 提供普通 workspace 文件与明文 persistence 产物，无需模型请求即可验证 Workspace/Session 冷发现、工具呈现、subagent 导航和历史分页。showcase 混排空字符串、纯空白与非空推理块，并包含多行长命令和父路径文件链接；这些是人工构造的 fixture，不是真实模型输出。[打包器](../webworker-packer/README.zh.md)在 Node 中根据已提交的历史日志准备当前代后继文件；这些源日志在 overlay 中逐字节保持不变。fixture 生成器负责验收测试的当前投影缓存。选择面板为 WebFS 保留独立的用户授权来源；该 provider 不读取内置 fixture。

[已构建 bundle 导入检查](tests/compile/transform-corpus-check.ts)在库构建后检查裸 Node 导入。Dockkit 例外接受 Node 针对任意样式表报告的未知 `.css` 扩展名错误，而不限定某一固定路径；其他扩展名、错误码或消息，以及意外成功的豁免导入，仍然报错。

-----

<a id="aiw-workbench"></a>
## AIB 工作台

Worker 本地的 `/__aiw/status` 与 `/__aiw/action` 端点支持 AIB 管理页面。文件和源码项目保留在 VFS 中。覆盖已有文件前，文本编辑必须提供上次读取内容的摘要；新文件写入不会替换已有文件。编辑器支持最大 1 MiB 的 UTF-8 文件。应用 profile、Session 文件、凭据路径、不可变产物及内部历史库不能通过这些操作修改。基础包可只读浏览。文件操作与简易命令行共用这些访问规则；硬链接别名会被拒绝。

插件安装在替换或垃圾回收前保留已验证、按内容寻址的产物字节，包括经现有 CLI 发起的安装和卸载。源码构建还会保留准确的选定源码及规范化描述符。历史通过现有 home 目录持久化 provider 保存。修订单独记录实际的 Host 激活结果；保留代码不表示 Client 已激活。恢复经过普通完整性校验、安装器及 HMR 队列，可以在 Forge 离线时工作。工作台历史建立之前安装的插件没有更早的源码快照；替换或卸载前会捕获其当前产物。

文件备份保留原始二进制字节及目录，在修改前验证每个路径与摘要，并仅导入空的工作区子目录。插件备份包含清单、已验证的产物对象及可选源码；源码文件与目录冲突会在修改历史记录或安装状态前被拒绝。导入的插件源码写入新的工作区目录，不覆盖已有项目。备份上限为 1,000 个文件及 32 MiB；受保护的凭据文件和内部缓存被排除。这些备份覆盖选定文件或插件项目，不提供运行中的完整 profile 或 Session 状态恢复。

命令行运行现有 VFS shell 及虚拟 `dsh`，没有 OS 进程或 Node 包管理器。每个请求从选定工作目录开始，具有 30 秒期限及 1 MiB 输出上限，工作台关闭时会取消。命令可能在成功的 HTTP 响应中返回非零退出码。保存文件或恢复插件本身不确认浏览器持久化；关闭页面前使用存储刷新操作。

<a id="browser-persistence"></a>
## 浏览器持久化

预览在加载存储 UI 模块前建立 shell 启动屏障；shell 等待 Worker 注入完成后才读取模块加载器入口。Forge 预览默认启用 IndexedDB 存储；`?storage=none` 选择临时 Worker，不清除已保存的数据。dsh-aib 页面标题区报告文件系统的待保存、已保存或失败状态，并提供“立即保存”。启动失败及存储停止也会在全局保持可见。页面传输通过 `WorkerStorageControls` 提供状态订阅及显式刷新。显式保存操作先通过已挂载的 Session 持久化服务排空缓冲事件，再等待浏览器存储；Session 刷新失败会停止确认。自动文件系统状态本身不确认该服务仍在缓冲的事件。已保存表示存储事务已完成；同步文件系统写入成功本身不确认持久化。页面卸载不作为保存保证。写入保存后，刷新页面会在 Cordis 启动前恢复插件安装、原生启停选择、配置、Session 文件和工作区文件。

`VfsPersistenceController` 将 VFS mutation sink 接入可替换的 `VfsPersistenceProvider`。仅 `home/` 和 `workspace/` 下的运行时变更进入存储；基础镜像模块与未修改的模板文件仍由静态镜像提供。`IndexedDbVfsProvider` 分开存储节点元数据和 64 KiB 文件块。后续追加只写变化的尾块及新增块，删除记录则确保从基础镜像重建时不会复活已删除文件。权限与已记录的修改时间会恢复；硬链接的 inode 身份不跨 Worker 生命周期保留。Session 日志格式不变。恢复仍会在 RAM 中重建这些文件；此提供者不会将 VFS 改为磁盘后端。正在执行的请求、插件变量和临时 DOM 修改不会恢复。

存储命名空间包含存储结构版本、内嵌 Forge 代际、部署和所选镜像及 overlay 来源。浏览器 Origin 另外隔离各自的数据库。其他代际或来源选择独立命名空间，旧数据保留；不自动迁移，也不跨版本加载插件。提供者应用操作组前，以原子方式比较修订号。过期标签页以 `STORAGE_CONFLICT` 停止镜像，保留较新的已提交数据。存储失败时，当前内存中的改动仍可用，但未获确认；错误提醒持续可见，控制器不会隐式重试。无效的存储快照或 Forge 清单会阻止启动，并保留原数据，不以默认值覆盖。已保存的不可变 `.forge/packages` 产物必须保持记录中的哈希；直接编辑其字节会阻止清单恢复。

Forge 清单记录已应用的 manifests 和保留产物的所有权，与激活结果独立。安装在等待 Cordis 协调前，将代码、生成的包元数据、Profile 注册及清单纳入一次同步持久化批次。删除先取消选择并卸载插件，再将文件回收与清单删除组合提交。新 Worker 在 Profile 合成前校验已保存产物并恢复按引用方解析的映射，随后由原生 Loader 状态决定激活结果。因此已安装包可在不联系 Forge 的情况下启动；基础镜像与页面仍需各自的静态资源。对应操作由 [forge/catalog.ts](src/forge/catalog.ts) 和 [storage/persistence.ts](src/storage/persistence.ts) 中的清单与控制器实现负责。

当前提供者使用浏览器本地存储，不实现原生 RPC 存储、云端同步或跨标签页合并。文件及插件归档操作由 [AIB 工作台](#aiw-workbench)负责。清除站点数据会删除存储，配额和存储回收由浏览器管理。`createWorkerHost` 调用方通过 `persistence` 传入控制器来启用；未传入时，宿主保持临时模式。控制器拥有提供者直至释放，在宿主销毁后结算排队写入并关闭提供者。

-----

<a id="forge-plugin-updates"></a>
## Forge 插件更新

预览页面通过 `?forge=<HTTP 服务地址>` 打开可选控制面板。**DSH Forge** 将本地 Host/Client 插件源码或 npm 包规格提交给该服务，并通过运行中的 Worker 应用编译清单。rc.2 前端内嵌 `FORGE_GENERATION = 'dsh-worker-rc2-8'`，在下载或写入前拒绝其他代际的产物。服务必须面向同一代际以及基础镜像提供的准确宿主包版本。核心包和共享宿主模块由前端构建提供。目标单独声明 `clientPackages`，在应用 overlay 前从可信基础镜像捕获；页面共享包的准确版本用于满足 Client 依赖，不授予 Host 导入能力。缺失或不匹配的 Client 依赖，以及替换共享 Client 包的尝试，均在文件写入前拒绝。带有受支持的单入口 `dsh.bundle` patch 的发布包可以携带现成的 Client bundle；包元数据和资源进入普通 Client 图及 HMR 路径。

安装器在修改文件前校验完整清单、受支持的 bundle patch 和缺失产物的字节。支持的 bundle patch 必须只包含一次自包 `insert`，条目仅含 `id`、`name` 及可选的 JSON 兼容字面量 `config`（对象、数组、标量或 null），配置结构由插件自行校验。同一 patch 还可用唯一 `id` 覆盖已有根条目的字面量 `config`、`disabled`（布尔值或 null）或两者。覆盖不能指向自身插入条目，也不能改变拓扑；原生 Cordis 合成应用这些覆盖，不改变核心包版本。安装器保留原始 patch 字节及顺序；插入条目的额外字段（包括 `disabled`）、覆盖条目的额外字段、非有限数字、YAML 别名和非 JSON 标签均在写入前拒绝。发布的 bundle 使用 profile 原生的 `dsh.profile.bundles` 选择及其原始 patch id；更新会删除旧的 Forge 注册行，使原生控制和 Forge 共用一个实例。更新保留原生禁用选择并报告 `disabled`；已安装状态查询读取当前选择和实时 Loader 条目。原生禁用条目仅在 fiber 不活跃后报告 `disabled`；启用但导入失败的条目仍报告激活失败。不含 bundle 元数据的插件使用 Forge 管理的 profile patch 行。无关的 profile 字段和 patch 行保持不变。

目标必需的 `sharedPackages` 列表将前端拥有的 DSH/Cordis 包、Client 平台包及静态运行时替身，与 `hostPackages` 中的普通库区分开。构建插件前，须用匹配代际重新生成 Forge 目标。普通依赖使用从其安装树解析的私有包，即使宿主库存存在兼容版本；peer 要求仍校验实际提供者版本。私有传递依赖可以与普通宿主库同名，但根插件名不能与任何宿主包或 Client 包冲突。每个包记录自身的 `hostDependencies`；计划级 `hostPackages` 清单校验版本，不向其他包授予导入能力。按引用方解析的映射提供这些 Host 要求、私有依赖与自身引用，在保留独立版本和固定共享实例的同时无需文件系统软链接。路径稳定的入口包装文件引用当前不可变包，由 Cordis HMR 检测文件变更。不可变包保留发布入口及资源的相对路径，使 `import.meta.url` 能在该包中定位相邻的 skill 和数据。Host 包子路径请求解析到不可变包，并共享其模块缓存；裸包根入口保留路径稳定的 HMR 包装文件。公开镜像提供 Client 和资源文件；更新在成功激活后删除过期的镜像资源，卸载时目录回收也通过同一套 VFS 和批次通知报告。协调过程要求所选 bundle 的真实条目 id，并确认实时激活。失败时保留包文件及诊断，但不保证恢复旧实例。删除先取消选择并卸载插件，再回收无共享引用的文件；卸载失败时保留其依赖声明和文件。

Forge 准备声明的依赖包，并交付逐文件转换的模块，保留包内相对名称和扩展名。加载器别名、计算参数的 `require()`、`require.resolve()` 和计算参数的 `import()` 在运行时选择这些已准备的文件；仅解析路径不会执行模块。首次加载执行模块、缓存其导出，并记录真实文件依赖供 HMR 使用。包内 CommonJS 循环使用缓存中的部分导出；Forge 包产物之间的循环仍不受支持。运行时选择不会下载缺失包，也不会提供缺失的 Node 操作。缺失文件、未声明的包及不可用操作在请求时失败，因此编译成功不代表激活或命令执行成功。即使从未执行，文件仍在安装时下载到 VFS；这不提供延迟下载，也不减少其 RAM 占用。

配置后的 Worker 通过 `node:child_process` 提供限定于当前 profile 的虚拟 `dsh plugin --profile <profile> add|update|remove <npm-package>` 命令，模型的 Bash shell 也可调用。shell 进程只能调用启动时公布的宿主命令名；请求保留其工作目录、环境、管道输入、文件系统与取消信号。宿主命令输出缓冲至完成后，再按普通 shell 管道与重定向传递。安装在 Forge 编译、文件校验应用和 Host 协调完成后才报告成功。同步调用可以检查本地命令和版本元数据，但不能执行远程工作。预览页面将同源 `/api/` 和 `/dsh-plugin-hub` Fetch 请求转给 Worker，包括发布插件直接调用的 Host 路由。查询字符串、方法、头部、请求体和取消均保留；同源 Origin 头与合成 Host 一起转换。静态资源、外域和相似路径名使用原页面 Fetch。路由错误不会重试静态服务器。合成请求的异步迭代和 `data`/`end`/`error` 监听共享同一个兼容 Node 的 Readable 请求体，`setEncoding()` 保留跨分块的字符序列。取消交换或完成响应会取消未读输入。

所有文件变更均使用普通 VFS mutation。`ForgeInstaller.subscribe()` 提供文件应用和激活的批次通知，VFS 订阅者则观察单个写入和删除。两种通知都不确认持久化完成。Forge 将已安装根包映射到 profile 的 `node_modules`；`createRequire(anchor).resolve.paths()` 提供锚点的各级父目录包搜索路径，使标准 bundle 清单无需 `./package.json` 导出即可发现这些包。未接入持久化提供者时，安装状态仅在当前 Worker 生命周期内有效；使用[浏览器持久化](#browser-persistence)时，已应用产物和所有权会在启动前恢复。[安装器](src/forge/installer.ts) 负责这些操作，[协议校验器](src/forge/protocol.ts) 负责清单准入。

### 构建本地插件

在已配置的 Worker 预览中，将源码文件与 `forge.json` 写入会话工作区，然后运行：

```sh
dsh plugin --profile web build ./greeting-source
```

目录相对于 shell 当前工作目录解析。其 `forge.json` 声明 `id`、npm 包 `name`、准确 `version`、相对 Host `entry` 及包含入口的相对源码路径数组 `files`。可选的 `dependencies` 与 `peerDependencies` 映射缺省为空对象；`peerDependenciesMeta` 可声明可选 peer。命令通过调用方 shell 的文件系统读取选定的 JS、JSX、TS、TSX 和 JSON 文件，将内容提交给 Forge 的 `/v1/builds`，校验产物并通过既有安装器应用。HTTP 请求沿用 npm 安装的同一可替换提供者。此 Worker 兼容命令不调用本地 Node 编译器，也不发布 npm 包。Host 代码在 Worker 中运行，没有浏览器 DOM API。

要构建 Client 半，添加 `"client": { "entry": "client.tsx", "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }`，并将该入口及其本地导入文件加入根 `files`。`client.files` 列出仅供浏览器使用的文件，缺省为 `[client.entry]`，必须包含该入口，且必须是根 `files` 的子集，不能包含 Host 入口。其余提交文件仍作为 Host 编译输入，包括通过计算得到的 require 路径加载的模块；浏览器代码也可导入共享输入。`client.inject` 列出 Client 包依赖图中的依赖，缺省为 `[]`；Client 源码导出的 `inject` 则另行声明 `slots` 等 Cordis 服务。可选的 `client.dependencies` 与 `client.peerDependencies` 缺省为 `{}`，用于声明额外浏览器依赖，不会让 Host 代码获得这些包；根依赖声明仍用于 Host 编译。同一包在根和 Client 中的声明必须使用相同的版本范围文本。源码按常规导出 Client 的 `apply`/`inject`；Forge 生成浏览器工厂以及 `dsh.client`、`./client` 元数据。安装器将该产物镜像到普通 Client 依赖图中，以完成加载和热替换。根 `package.json` 仍由服务生成，不能作为源码提交。构建命令成功只报告 Host 激活，不确认 Client 组件已挂载；须另行检查 Client 注册并实际验证其可见行为。 在 preview 中，同源 `/api/` Fetch 请求经由 Worker carrier。其 direct 通道增量传输 `text/event-stream`，其他响应类型则缓冲到结束；实时 Host 更新使用 SSE，有限快照使用 JSON。

更新时保持插件 `id` 与包 `name` 不变。修改源码后重新运行构建命令；仅修改源文件不会重建已安装产物。安装器负责 Loader 登记与热替换。源码校验、下载或编译失败会保留已安装版本；激活失败返回非零退出码，不承诺恢复旧实例。禁用的插件保持禁用，命令成功不确认持久化完成。验证行为后，刷新前使用页面的显式保存操作；工作区源码与安装产物保存在不同的 VFS 路径中。[forge/commands.ts](src/forge/commands.ts) 和 [forge/source.ts](src/forge/source.ts) 负责命令解析与源码收集。

-----

<a id="outbound-http-providers"></a>
## 出站 HTTP 提供器

`createWorkerHost({ httpTransport })` 接收实例拥有的提供器，其方法为 `fetch(request: Request): Promise<Response>`。镜像和延迟归档下载、Forge 构建和产物、虚拟 `curl`、`node:https.get`，以及 VFS 模块中的 Fetch 调用（包括模型提供器和插件的 `globalThis.fetch`）均经过它。省略时使用平台 Fetch。模块的全局别名解析到同一个加载器代理，真实 Worker 全局保持不变。这是依赖注入，不是不可信 JavaScript 的沙箱。

提供器在页面中实现时，将其传给 `connectWorkerHost(worker, { httpTransport })`。独立 MessageChannel 传输请求与响应字段及 ReadableStream，并转发取消；函数保留在页面中。传输失败和 opaque 响应明确报错，不退回整包缓冲。返回的 `disposeHttp()` 取消并解除此提供器，Worker 和隧道仍由调用者管理。直接嵌入 Worker 时，调用者负责销毁提供器，并通过 `host.stop()` 取消活动 HTTP。提供器必须遵守 `Request.signal`，包括尚未读完的响应体；宿主关闭也会取消未读响应流。

AIB 构建请求使用 Worker 配置的提供者。该提供者不会拦截来源选择器请求、页面静态资源、WebSocket 或在其他 JavaScript realm 中创建的代码。同源插件资源使用上文说明的可选 Service Worker 桥接。默认提供者仍受浏览器 CORS 约束；原生 RPC 提供者可提供自己的 HTTP 实现，而无需修改插件请求调用。

-----

<a id="model-experience"></a>
## 模型体验

无：本包只在浏览器 worker 里承载插件树并应答它的 `node:*` 调用；所有面向模型的注册都属于它启动的那些插件。

#### KV Cache 影响

无：本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **worker 组合写明文会话日志**（镜像 home patch 中的 `compression: 'none'`；ConfigEditor 会拒绝修改这一行的配置）：不带 Zstandard 编解码器，导出日志是 `.jsonl`，不会是 `.jsonl.zstd`。
- **内置模块提供不同程度的能力**：`implemented/` 提供 Worker 行为；`optional/` 允许导入，但不可用操作抛出 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`；`mock/` 提供结构占位。Forge 模块文件在执行时解析导入，因此交付成功不代表内置命名空间或操作可用。`node:dns` 和 `node:dns/promises` 是可选命名空间：导入静默，设置或读取结果顺序及地址查询则在控制台报告不可用操作并抛错。插件可捕获错误后继续运行；这里不提供 DNS 查询、结果顺序修改或假成功的空操作。`node:v8` 也属于可选模块：可导入 `getHeapStatistics`，调用时则报告并抛出同一类平台不可用错误。这里不提供同步堆统计或虚构内存数值，插件须自行处理统计不可用的情况。`node:vm`、`node:net`、`node:sqlite` 和 `node:worker_threads` 仍是结构占位。
- **`node:assert/strict` 仅支持真值断言**：对于假值，可调用的默认导出和 `ok` 使用传入的消息或通用文本抛出 `ERR_ASSERTION`，或原样抛出传入的 Error。其他断言 API 未提供。
- **网络兼容能力使用配置的 HTTP 提供器**：`node:https.get` 支持 registry 元数据响应，虚拟 `curl` 支持 Plugin Hub 目录和探测使用的参数。默认提供器遵守浏览器 CORS 规则；进程代理设置、自定义 TLS 选项和同步网络请求不受支持。
- **原生响应原型补丁不影响隧道**：合成响应不继承 `http.ServerResponse.prototype`；插件在此原型上安装的 gzip 或 Brotli 压缩补丁不会压缩隧道响应。
- **原生 TLS 监听器需要 Node Host**：worker 的 `node:https.createServer` 会拒绝激活，不会替换成明文。预览内部的 HTTP 隧道不绑定套接字；面向浏览器的 HTTPS 由部署服务器提供。
- **桌面产品埋点不可用**：`got.post` 明确报告 worker host 不支持该调用。浏览器镜像不包含 Got 及其 Node HTTP 依赖；预览组合不启用桌面上报。
- **包命令仅支持 Forge 插件操作**：Worker 不运行 pnpm、全局 npm 安装、Git 安装或任意 Node 子进程。`execa` 仍不可用。[Forge](#forge-plugin-updates) 在服务端解析和编译受支持的 npm 插件。
- **pi-ai 模型请求不可用**：替代实现暴露已安装提供方标识的固定子集，不包含模型，使适配器能够注册配置元数据。升级 pi-ai 时必须保持这些标识有效；推理入口明确报告 worker host 不支持该调用。
- **PTC Node 程序不可用**：process shim 用 `/dsh/bin/node` 表示可执行文件身份，使 provider 能够激活，但 Worker 既没有 Node 可执行文件，也没有 `stripTypeScriptTypes`。程序执行会在启动子进程前失败。
- **Office 转换需要 Node Host**：LibreOffice kit 的替代模块以 `unavailable` 拒绝创建转换器。浏览器镜像排除 kit 及其引擎依赖；Office 预览提示转换不可用。
- **Host HMR 需要可执行的 JavaScript**：loader 记录文件依赖，包括缓存命中和延迟执行的 require，并在替换时清除模块记录和包元数据。配置 HMR 监听根目录后，VFS 编辑会自动触发重载；profile 重新组合也会检查已加载文件。启动模块及其依赖需要新建 Worker，Worker bundle 或静态模块代理的变化也如此。TS/TSX 编译、包安装、Client bundle 替换和持久保存属于独立能力。[可使用 Chrome 的生命周期测试](../../../apps/web/tests/worker-hmr.e2e.ts) 验证共享依赖、条目删除和重新加入、导入失败及恢复，期间不替换 Worker。
- **Node internal 模块只提供 HMR 会替换的成员**：CommonJS loader、package reader、`modules` binding 与 `getOrCreateModuleJob` 被调用时拒绝；Worker 自己的 `require` 不经过 CommonJS loader，因此替换 `Module._resolveFilename` 或 `Module._load` 不会改变 Worker 的解析。
- **CommonJS 的 `require('stream')` 返回模块命名空间，而不是 Node 的 `Stream` 构造函数**：把它传给 `util.inherits` 的代码会在加载时失败。
- **懒加载提供的文件在其归档到达前不能同步读取**：使用方必须先异步读取一次；Host 的按需 Client chunk 路由就是这样做的。
- **文件 watcher 只能观察已挂载的 VFS**：镜像 seed 不产生事件，VFS 也没有符号链接或外部写入方。`persistent`、`ref()` 和 `unref()` 保留 Node API，但浏览器没有引用计数事件循环，因此这些接口不能控制 dedicated Worker 的生存期。
- **Worker confinement 是 VFS 边界，不是内核 Landlock**：`read-only` 和 `workspace-write` 运行未经修改的 `@deepseek-ai/node-addon-system/landlock-run` JavaScript 与 launcher argv，进程层则实现逻辑 `landlock-run` 可执行文件，并在 shell 的每次文件系统请求上执行其授权。`full` 仅覆盖 Worker 命令表和已挂载 VFS，不表示能够执行任意 native 进程，也不表示 Linux 内核隔离。已登记宿主命令可执行插件安装等 profile 操作；路径授权适用于其源码读取，不构成已激活 JavaScript 的沙箱。
- **worker 束钉住了 `@yarnpkg/parsers` 的包内路径**——构建解析到该包自己的 `lib/shell.js` 而非包根，因为包根 barrel 还 re-export 了 Syml 解析器，会把 js-yaml 拖进一个从不解析该格式的束（约 175 kB，外加 worker 启动时的模块体求值）。该路径由包 manifest 派生，包内布局一变即构建期失败、不会静默退回 barrel；升级这个依赖时须复核 shell 解析器是否仍在那里。
- **这个 shell 不是 bash**：没有循环、函数、`case`、作业控制或进程替换——语法止步于管道、`&&`/`||`、子 shell、group、重定向与展开。`&` 会就地把命令跑完，`sed` 只接受替换脚本，模式是 JavaScript 正则，命令表只有 coreutils（没有 `git`，没有网络工具）。
- **shell 进程没有同步文件面**：它靠消息读写宿主的 VFS，因为阻塞等待回帧需要 `SharedArrayBuffer`，而那要求 GitHub Pages 给不了的跨源隔离。因此目录遍历类命令每个条目一次往返，并发的两条命令写入可以交错。
- **transport、worker-host、页面半的覆盖需要浏览器级 harness**——这些模块未达 per-file 覆盖门；单测覆盖 storage、ALS、transform 与 stub 契约。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
