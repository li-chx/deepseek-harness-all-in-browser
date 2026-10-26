/** Bind Service Worker resource requests to this page's dedicated Host tunnel. */
import { serveHttpTransport } from '../transport/http-port.ts'
import type { TunnelFetch } from './client.ts'

/**
 * Claim this preview page before its Host startup scripts execute.
 * @param script Service Worker module served beside preview.html.
 * @param fetch Host tunnel belonging only to this page.
 * @returns Cleanup aborting bridge requests and detaching its page listener; shared registration stays installed.
 * @throws When the page is insecure, another application owns the scope, or registration fails.
 */
export async function connectServiceWorker(script: string | URL, fetch: TunnelFetch): Promise<() => void> {
  if (!isSecureContext || !('serviceWorker' in navigator)) {
    throw new Error('Worker resource bridging requires HTTPS or http://localhost')
  }
  const scriptUrl = new URL(script, document.baseURI)
  const scope = new URL('.', scriptUrl)
  if (scriptUrl.origin !== location.origin || new URL('preview.html', scope).pathname !== location.pathname) {
    throw new Error('Worker resource bridge must be served beside the same-origin preview.html page')
  }
  const existing = await navigator.serviceWorker.getRegistration(scope.href)
  if (existing !== undefined && [existing.active, existing.waiting, existing.installing]
    .some(worker => worker !== null && worker.scriptURL !== scriptUrl.href)) {
    throw new Error(`A different Service Worker already owns ${scope.href}`)
  }
  const requests = new Set<() => void>()
  const receive = (event: MessageEvent<unknown>): void => {
    if (!(event.source instanceof ServiceWorker) || event.source.scriptURL !== scriptUrl.href
      || typeof event.data !== 'object' || event.data === null || !('t' in event.data)
      || event.data.t !== 'dsh-worker-host-request' || event.ports.length !== 1) return
    const port = event.ports[0]
    if (port === undefined) return
    const dispose = serveHttpTransport(port, {
      fetch: request => fetch(request.url, { method: request.method, headers: request.headers,
        body: request.body, signal: request.signal }),
    }, () => { requests.delete(dispose) })
    requests.add(dispose)
  }
  navigator.serviceWorker.addEventListener('message', receive)
  const dispose = (): void => {
    navigator.serviceWorker.removeEventListener('message', receive)
    for (const close of requests) close()
    requests.clear()
  }
  try {
    const registration = await navigator.serviceWorker.register(scriptUrl.href, { type: 'module', scope: scope.href, updateViaCache: 'none' })
    if (registration.installing === null && registration.waiting === null && registration.active === null) {
      throw new Error('Worker resource bridge registration has no active or installing worker')
    }
    if (navigator.serviceWorker.controller?.scriptURL !== scriptUrl.href) {
      await new Promise<void>((resolve, reject) => {
        const installing = registration.installing ?? registration.waiting
        const cleanup = (): void => {
          navigator.serviceWorker.removeEventListener('controllerchange', changed)
          installing?.removeEventListener('statechange', changed)
        }
        const changed = (): void => {
          if (installing?.state === 'redundant') {
            cleanup()
            reject(new Error('Worker resource bridge failed to activate; inspect the Service Worker console'))
            return
          }
          if (navigator.serviceWorker.controller?.scriptURL !== scriptUrl.href) return
          cleanup()
          resolve()
        }
        navigator.serviceWorker.addEventListener('controllerchange', changed)
        installing?.addEventListener('statechange', changed)
        changed()
      })
    }
    return dispose
  } catch (error) { dispose(); throw error }
}
