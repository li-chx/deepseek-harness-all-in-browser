---
kind: upgrade-guide
description: "Worker 预览部署要求安全浏览器上下文及 Service Worker 桥接资源。"
---

# Worker 预览要求安全上下文

[English](guide.md) | 中文

## 变更

`preview.html` 使用 Service Worker 将插件 HTTP 资源请求转发给页面自己的 Host。局域网或 VPN 地址上的普通 HTTP 无法启动桥接。标准 Node Host 托管的 Web 应用不受影响；直接调用 `connectWorkerHost` 的嵌入方通过 `serviceWorker` 选择启用。

## 迁移

1. 本地预览通过 `http://localhost:<port>/preview.html` 或回环地址打开。远程部署使用 HTTPS。
2. 将重新构建的 `preview-service-worker.js`、`preview/static-assets.json` 与 `apps/web/dist` 的其余文件一同部署。桥接脚本应与 `preview.html` 同目录，避免作用域已被其他 Service Worker 占用。
3. 打开预览页，确认其 Service Worker 已控制页面。插件脚本和资源请求应收到 Host 响应，而非静态服务器的 404。
