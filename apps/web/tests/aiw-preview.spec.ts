// @vitest-environment jsdom
/** The sidebar workbench can request Worker data before transport startup settles. */
import { afterEach, expect, it, vi } from 'vitest'
import { mountAiwPreview } from '../src/aiw-preview.ts'

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('waits for the Worker and applies Forge configuration through its request provider', async () => {
  const ready = Promise.withResolvers<import('@deepseek-ai/dsh-experimental-webworker-runtime/client').TunnelFetch>()
  const host = vi.fn(async (_input: string | URL, _init?: RequestInit) => Response.json({ protocol: 1 }))
  vi.stubGlobal('fetch', vi.fn())
  dispose = mountAiwPreview(ready.promise, 'http://forge.example')
  const pending = fetch('/__aiw/status')
  expect(host).not.toHaveBeenCalled()
  ready.resolve(host)
  expect((await pending).ok).toBe(true)
  expect(host.mock.calls).toHaveLength(3)
  expect(host.mock.calls[0]?.[0]).toBe('/__aiw/status')
  expect(host.mock.calls[1]?.[0]).toBe('/__forge/configure')
  expect(String(host.mock.calls[2]?.[0])).toContain('/__aiw/status')
  expect(document.querySelector('button')).toBeNull()
})

it('keeps offline management available after an initial configuration failure', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const host = vi.fn(async (path: string | URL) => String(path).endsWith('/configure')
    ? new Response('invalid address', { status: 400 }) : Response.json({ protocol: 1 }))
  vi.stubGlobal('fetch', vi.fn())
  dispose = mountAiwPreview(Promise.resolve(host), 'invalid')
  expect((await fetch('/__aiw/status')).ok).toBe(true)
  expect(error).toHaveBeenCalledOnce()
})

it('prevents a queued request from dispatching after the page bridge is disposed', async () => {
  const ready = Promise.withResolvers<import('@deepseek-ai/dsh-experimental-webworker-runtime/client').TunnelFetch>()
  const host = vi.fn(async (_input: string | URL, _init?: RequestInit) => Response.json({ protocol: 1 }))
  vi.stubGlobal('fetch', vi.fn())
  dispose = mountAiwPreview(ready.promise)
  const pending = fetch('/__aiw/status')
  dispose()
  ready.resolve(host)
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(host).not.toHaveBeenCalled()
})

it('retains the saved Forge address instead of reapplying the URL seed', async () => {
  const host = vi.fn(async (_path: string | URL, _init?: RequestInit) => Response.json({ protocol: 1, baseUrl: 'http://saved.example' }))
  vi.stubGlobal('fetch', vi.fn())
  dispose = mountAiwPreview(Promise.resolve(host), 'http://seed.example')
  await fetch('/__aiw/status')
  expect(host.mock.calls.some(([path]) => String(path).endsWith('/configure'))).toBe(false)
})
