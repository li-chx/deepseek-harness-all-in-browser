/** Page Fetch forwarding for Host-owned HTTP namespaces in a Worker preview. */
import type { TunnelFetch } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

/**
 * Forward same-origin Host API and marketplace HTTP routes through the existing Worker carrier.
 * @param hostFetch - Worker HTTP transport; route errors remain its responses without a network retry.
 * @returns Cleanup that disables forwarding and preserves fetch wrappers installed by later consumers.
 */
export function forwardWorkerHostRequests(hostFetch: TunnelFetch): () => void {
  const previous = globalThis.fetch
  let active = true
  const forwarded: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), document.baseURI)
    const hostRoute = url.origin === location.origin
      && (url.pathname.startsWith('/api/') || url.pathname === '/dsh-plugin-hub' || url.pathname.startsWith('/dsh-plugin-hub/'))
    if (!active || !hostRoute) return previous(input, init)
    const request = new Request(input instanceof Request ? input : url, init)
    request.signal.throwIfAborted()
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
    request.signal.throwIfAborted()
    return hostFetch(request.url, {
      ...init, method: request.method, headers: request.headers, body: body ?? null, signal: request.signal,
    })
  }
  globalThis.fetch = forwarded
  return () => {
    active = false
    if (globalThis.fetch === forwarded) globalThis.fetch = previous
  }
}
