/**
 * Worker-preview bootstrap: the one module preview.html adds ahead of the
 * stock entry tag. The runtime's optional source stage owns the pre-Cordis
 * chooser; the unchanged Host connector then owns the Worker handshake.
 * Everything after those calls is the served startup chain verbatim.
 */
import DshWorker from '@deepseek-ai/dsh-experimental-webworker-runtime/worker?worker'
import {
  chooseWorkerHostSource, connectWorkerHost, IMAGE_FILE_NAME,
} from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

const { mountPreviewStorage, previewStorageOptions } = await import('./preview-storage.ts')

const image = `preview/${IMAGE_FILE_NAME}`
const source = await chooseWorkerHostSource({ image })
const storage = previewStorageOptions(new URL(location.href), new URL(image, document.baseURI), source.overlays)
const storageUi = storage === undefined ? undefined : mountPreviewStorage()
try {
  const connection = await connectWorkerHost(new DshWorker({ name: 'dsh-host' }), { image, overlays: source.overlays, ...storage === undefined ? {} : { storage } })
  storageUi?.connect(connection)
} catch (error) {
  storageUi?.fail(error)
  throw error
}

const forge = new URL(location.href).searchParams.get('forge')
if (forge) {
  const { mountForgePreview } = await import('./forge-preview.ts')
  const transport = (globalThis as typeof globalThis & {
    __DSH_TRANSPORT__?: { fetch: import('@deepseek-ai/dsh-experimental-webworker-runtime/client').TunnelFetch }
  }).__DSH_TRANSPORT__
  if (transport) {
    const presentation = storageUi === undefined ? undefined : { launcherParent: storageUi.actions, persistentStorage: true }
    const dispose = mountForgePreview(forge, transport.fetch, undefined, presentation)
    window.addEventListener('pagehide', dispose, { once: true })
  }
}

if (storageUi) window.addEventListener('pagehide', () => { storageUi.dispose() }, { once: true })
