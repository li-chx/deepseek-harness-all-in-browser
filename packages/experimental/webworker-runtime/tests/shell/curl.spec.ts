/** Plugin Hub curl invocations execute over browser Fetch without OS process access. */
import { afterEach, expect, it, vi } from 'vitest'
import { CURL_EXECUTABLE } from '../../src/shell/process/curl.ts'
import { hostFileSystem } from '../../src/shell/fs-access.ts'
import type { VirtualExecutable } from '../../src/shell/process/virtual-executables.ts'

function context(signal = new AbortController().signal): Parameters<VirtualExecutable['prepare']>[1] {
  return { cwd: '/dsh/workspace', filesystem: hostFileSystem(), env: {}, signal, output() {} }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('fetches the catalog and exposes HTTP probe status', async () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response('{"plugins":[]}', { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  expect(await CURL_EXECUTABLE.prepare(['-sS', '--compressed', '--max-time', '60', 'https://catalog.example/plugins.json'], context()))
    .toMatchObject({ exitCode: 0, stdout: '{"plugins":[]}' })
  expect(await CURL_EXECUTABLE.prepare(['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-r', '0-1023', 'https://catalog.example/'], context()))
    .toMatchObject({ exitCode: 0, stdout: '200' })
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: { Range: 'bytes=0-1023' }, redirect: 'manual' })
})

it('rejects unsupported options and configured proxies without network requests', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const ctx = context()
  expect(await CURL_EXECUTABLE.prepare(['--insecure', 'https://catalog.example/'], ctx)).toMatchObject({ exitCode: 2 })
  expect(await CURL_EXECUTABLE.prepare(['-o', '/tmp/result', 'https://catalog.example/'], ctx)).toMatchObject({ exitCode: 2 })
  expect(await CURL_EXECUTABLE.prepare(['file:///etc/passwd'], ctx)).toMatchObject({ exitCode: 2 })
  const proxy = await CURL_EXECUTABLE.prepare(['https://catalog.example/'], { ...ctx, env: { HTTPS_PROXY: 'http://proxy.example' } })
  expect(proxy).toMatchObject({ exitCode: 2 })
  if (proxy.kind === 'exit') expect(proxy.stderr).toContain('proxy settings')
  expect(fetcher).not.toHaveBeenCalled()
})

it('aborts the owned fetch at its deadline', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn((_url: URL, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
  })))
  const result = CURL_EXECUTABLE.prepare(['--max-time', '1', 'https://catalog.example/'], context())
  await vi.advanceTimersByTimeAsync(1000)
  expect(await result).toMatchObject({ exitCode: 28 })
  expect(vi.getTimerCount()).toBe(0)
})

it('propagates process cancellation to Fetch and reports an unsuccessful exit', async () => {
  const abort = new AbortController()
  let ready!: () => void
  const started = new Promise<void>((resolve) => { ready = resolve })
  vi.stubGlobal('fetch', vi.fn((_url: URL, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
    ready()
  })))
  const result = CURL_EXECUTABLE.prepare(['https://catalog.example/'], context(abort.signal))
  await started
  abort.abort()
  expect(await result).toMatchObject({ exitCode: 130 })
})
