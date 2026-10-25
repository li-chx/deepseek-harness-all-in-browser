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

const image = `preview/${IMAGE_FILE_NAME}`
const source = await chooseWorkerHostSource({ image })
await connectWorkerHost(new DshWorker({ name: 'dsh-host' }), { image, overlays: source.overlays })

const forge = new URL(location.href).searchParams.get('forge')
if (forge) {
  const { mountForgePreview } = await import('./forge-preview.ts')
  const transport = (globalThis as typeof globalThis & {
    __DSH_TRANSPORT__?: { fetch: import('@deepseek-ai/dsh-experimental-webworker-runtime/client').TunnelFetch }
  }).__DSH_TRANSPORT__
  if (transport) {
    const dispose = mountForgePreview(forge, transport.fetch)
    window.addEventListener('pagehide', dispose, { once: true })
  }
}
