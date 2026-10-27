/**
 * Worker-preview bootstrap: the one module preview.html adds ahead of the
 * stock entry tag. The runtime's optional source stage owns the pre-Cordis
 * chooser; it holds shell boot before any asynchronous module import. The
 * unchanged Host connector then owns the Worker handshake.
 * Everything after those calls is the served startup chain verbatim.
 */
import { mountAiwPreview } from './aiw-preview.ts'
import { previewPageUrl } from './preview-config.ts'
import DshWorker from '@deepseek-ai/dsh-experimental-webworker-runtime/worker?worker'
import {
  chooseWorkerHostSource, connectWorkerHost, IMAGE_FILE_NAME,
} from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

const page = previewPageUrl(new URL(location.href), {
  'preview-fixture': process.env.DSH_CLIENT_PREVIEW_FIXTURE,
  forge: process.env.DSH_CLIENT_FORGE_URL,
  storage: process.env.DSH_CLIENT_STORAGE,
})
const transportReady = Promise.withResolvers<import('@deepseek-ai/dsh-experimental-webworker-runtime/client').TunnelFetch>()
const disposeAiw = mountAiwPreview(transportReady.promise, page.searchParams.get('forge') ?? undefined)
window.addEventListener('pagehide', disposeAiw, { once: true })

const image = `preview/${IMAGE_FILE_NAME}`
const fixture = page.searchParams.get('preview-fixture')
const source = await chooseWorkerHostSource({ image, ...fixture === null ? {} : { fixture } })
const { mountPreviewStorage, previewStorageOptions } = await import('./preview-storage.ts')
const storage = previewStorageOptions(page, new URL(image, document.baseURI), source.overlays)
const storageUi = storage === undefined ? undefined : mountPreviewStorage()
try {
  const connection = await connectWorkerHost(new DshWorker({ name: 'dsh-host' }), {
    image, overlays: source.overlays, serviceWorker: './preview-service-worker.js',
    ...storage === undefined ? {} : { storage },
  })
  window.addEventListener('pagehide', () => { connection.disposeServiceWorker(); connection.disposeHttp() }, { once: true })
  transportReady.resolve((input, init) => connection.tunnel.fetch(input, init))
  storageUi?.connect(connection)
} catch (error) {
  transportReady.reject(error)
  storageUi?.fail(error)
  throw error
}

if (storageUi) window.addEventListener('pagehide', () => { storageUi.dispose() }, { once: true })
