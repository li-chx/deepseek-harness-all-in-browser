---
kind: upgrade-guide
description: "Worker preview deployments require a secure browser context and the Service Worker bridge assets."
---

# Worker preview requires a secure context

English | [中文](guide.zh.md)

## Change

`preview.html` uses a Service Worker to forward plugin HTTP resources to its page-owned Host. Plain HTTP on LAN or VPN addresses cannot start the bridge. The standard Node-hosted Web application is unaffected; direct `connectWorkerHost` embeddings opt in with `serviceWorker`.

## Migration

1. Open local previews through `http://localhost:<port>/preview.html` or a loopback address. For remote deployments, serve the preview over HTTPS.
2. Deploy the rebuilt `preview-service-worker.js` and `preview/static-assets.json` together with the rest of `apps/web/dist`. Keep the bridge beside `preview.html` and avoid a scope already owned by another Service Worker.
3. Open the preview and confirm its Service Worker controls the page. Plugin script and asset requests should receive the Host's responses rather than static-server 404s.
