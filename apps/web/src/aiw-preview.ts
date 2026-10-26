/** Worker request forwarding and initial Forge configuration for the dsh-aib page. */
import type { TunnelFetch } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
import { forwardWorkerHostRequests } from './worker-host-fetch.ts'

/**
 * Install request forwarding before the application can mount its saved panels.
 * @param transport - Worker transport, resolved after its boot handshake.
 * @param serverUrl - Optional Forge seed when no saved endpoint exists; offline file management needs none.
 * @returns Cleanup that detaches the page's forwarding wrapper.
 */
export function mountAiwPreview(transport: Promise<TunnelFetch>, serverUrl?: string): () => void {
  const lifetime = new AbortController()
  const configured = transport.then(async (hostFetch) => {
    if (serverUrl !== undefined) {
      try {
        lifetime.signal.throwIfAborted()
        const status = await hostFetch('/__aiw/status', { signal: lifetime.signal })
        const saved: unknown = await status.json()
        if (!status.ok || typeof saved !== 'object' || saved === null || !('protocol' in saved) || saved.protocol !== 1) {
          throw new Error('The Worker returned an invalid workbench status')
        }
        if ('baseUrl' in saved && typeof saved.baseUrl === 'string') return hostFetch
        lifetime.signal.throwIfAborted()
        const response = await hostFetch('/__forge/configure', {
          signal: lifetime.signal, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseUrl: serverUrl }),
        })
        if (!response.ok) throw new Error(await response.text())
      } catch (error) {
        // The settings page remains available to correct an unavailable or invalid endpoint.
        if (!lifetime.signal.aborted) console.error('dsh-aib: could not apply the initial Forge address', error)
      }
    }
    return hostFetch
  })
  // A failed boot is reported by the startup owner even when no page request awaits transport.
  void configured.catch(() => {})
  const release = forwardWorkerHostRequests(async (input, init) => {
    const hostFetch = await configured
    init?.signal?.throwIfAborted()
    lifetime.signal.throwIfAborted()
    return hostFetch(input, init)
  })
  return () => { lifetime.abort(); release() }
}
