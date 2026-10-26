/** Same-origin preview resources reach the Host owned by their requesting page; static files stay on the server. */
import { PortHttpTransport } from './transport/http-port.ts'

declare const self: ServiceWorkerGlobalScope

const base = new URL(self.registration.scope)
const preview = new URL('preview.html', base)
/** Resolve the deployed static files independently of the Service Worker script version. */
async function loadStaticFiles(): Promise<Set<string>> {
  const response = await fetch(new URL('preview/static-assets.json', base), { cache: 'no-store' })
  if (!response.ok) throw new Error(`Worker static asset catalog returned HTTP ${response.status}`)
  const value: unknown = await response.json()
  if (!Array.isArray(value) || !value.every((path): path is string => typeof path === 'string')) {
    throw new Error('Worker static asset catalog must contain file paths')
  }
  return new Set(value.map(path => new URL(path, base).pathname))
}

let staticFiles = loadStaticFiles()

self.addEventListener('install', (event) => { event.waitUntil(staticFiles.then(() => self.skipWaiting())) })
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })

/** Close a request's dedicated port when its response body finishes or is cancelled. */
function releaseResponse(response: Response, close: () => void): Response {
  if (response.body === null) { close(); return response }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const next = await reader.read()
        if (next.done) { output.close(); reader.releaseLock(); close() }
        else output.enqueue(next.value)
      } catch (error) { output.error(error); reader.releaseLock(); close() }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } finally { reader.releaseLock(); close() }
    },
  })
  return new Response(body, response)
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== base.origin) return
  if (event.request.mode === 'navigate') {
    if (url.pathname === preview.pathname) {
      staticFiles = loadStaticFiles()
      event.waitUntil(staticFiles)
    }
    return
  }
  event.respondWith((async () => {
    const files = await staticFiles
    const client = await self.clients.get(event.clientId)
    if (client === undefined || new URL(client.url).pathname !== preview.pathname
      || files.has(url.pathname) || url.pathname.startsWith(new URL('preview/', base).pathname)) {
      return fetch(event.request)
    }
    const channel = new MessageChannel()
    const http = new PortHttpTransport(channel.port1)
    try {
      client.postMessage({ t: 'dsh-worker-host-request' }, [channel.port2])
      return releaseResponse(await http.fetch(event.request), () => { http.close() })
    } catch (error) {
      http.close()
      console.error('Worker Host request failed', error)
      return new Response('Worker Host request failed; reload the preview to reconnect.', { status: 502 })
    }
  })())
})
