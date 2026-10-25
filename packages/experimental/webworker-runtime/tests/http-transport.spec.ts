/** Outbound transport ownership, module isolation and real transferable-stream messages. */
import { afterEach, expect, it, vi } from 'vitest'
import { WorkerHttpTransport, httpModuleGlobal } from '../src/transport/http-transport.ts'
import { PortHttpTransport, serveHttpTransport } from '../src/transport/http-port.ts'
import { WorkerModuleLoader } from '../src/module-system/module-loader.ts'
import { MemoryVfs } from '../src/storage/memory.ts'
import { createHttpsModule } from '../src/node/builtin_modules/implemented/https.ts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

it('isolates module fetch and global aliases while allowing local fetch declarations', async () => {
  const native = globalThis.fetch
  const vfs = new MemoryVfs()
  vfs.seed('/dsh/test.js', 'module.exports = () => Promise.all([fetch("https://test/a"),globalThis.fetch("https://test/b"),global.self.globalThis.fetch("https://test/c")]).then(xs=>Promise.all(xs.map(x=>x.text())))')
  vfs.seed('/dsh/local.js', 'const fetch = () => 42; module.exports = fetch()')
  const one = new WorkerModuleLoader({ vfs, staticModules: {}, httpFetch: async () => new Response('one') })
  const two = new WorkerModuleLoader({ vfs, staticModules: {}, httpFetch: async () => new Response('two') })
  const first = one.requireFrom('/dsh')('./test.js') as () => Promise<string[]>
  const second = two.requireFrom('/dsh')('./test.js') as () => Promise<string[]>
  expect(await first()).toEqual(['one', 'one', 'one'])
  expect(await second()).toEqual(['two', 'two', 'two'])
  expect(one.requireFrom('/dsh')('./local.js')).toBe(42)
  expect(globalThis.fetch).toBe(native)
  const proxy = httpModuleGlobal(async () => new Response())
  expect(proxy.globalThis).toBe(proxy)
  expect(proxy.URL).toBe(URL)
  expect(proxy.atob('YQ==')).toBe('a')
})

it('cancels unread provider bodies on host close and rejects future requests', async () => {
  const cancelled = Promise.withResolvers<undefined>()
  const http = new WorkerHttpTransport({
    fetch: async () => new Response(new ReadableStream({ cancel() { cancelled.resolve(undefined) } })),
  })
  cleanup.push(() =>{  http.close() })
  const result = await http.fetch(new Request('https://test/'))
  const read = result.body!.getReader().read()
  http.close()
  await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  await cancelled.promise
  await expect(http.request('https://test/')).rejects.toMatchObject({ name: 'AbortError' })
})

it('streams uploads and responses through a real MessageChannel without native fetch', async () => {
  const channel = new MessageChannel()
  const body = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
  const provider = vi.fn(async (request: Request) => {
    expect(request.method).toBe('POST')
    expect(request.headers.get('x-test')).toBe('yes')
    expect(await request.text()).toBe('upload')
    return new Response(new ReadableStream<Uint8Array>({ start(output) { body.resolve(output) } }), { status: 201 })
  })
  const dispose = serveHttpTransport(channel.port1, { fetch: provider })
  const http = new PortHttpTransport(channel.port2)
  cleanup.push(dispose, () =>{  http.close() })
  const result = await http.fetch(new Request('https://test/stream', { method: 'POST', body: 'upload', headers: { 'x-test': 'yes' } }))
  expect(result.status).toBe(201)
  const reader = result.body!.getReader()
  const output = await body.promise
  output.enqueue(new TextEncoder().encode('first'))
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
  output.enqueue(new TextEncoder().encode('second'))
  output.close()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('second')
  expect((await reader.read()).done).toBe(true)
  expect(provider).toHaveBeenCalledOnce()
})

it('relays abort after response headers and closes an active provider body', async () => {
  const channel = new MessageChannel()
  const aborted = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<undefined>()
  cleanup.push(serveHttpTransport(channel.port1, { fetch: async (request) => {
    request.signal.addEventListener('abort', () =>{  aborted.resolve(undefined) }, { once: true })
    return new Response(new ReadableStream({ cancel() { cancelled.resolve(undefined) } }))
  } }))
  const http = new PortHttpTransport(channel.port2)
  cleanup.push(() =>{  http.close() })
  const controller = new AbortController()
  const result = await http.fetch(new Request('https://test/', { signal: controller.signal }))
  const reading = result.text()
  controller.abort()
  await expect(reading).rejects.toBeDefined()
  await aborted.promise
  await cancelled.promise
})

it('rejects malformed replies and premature end without leaving pending requests', async () => {
  for (const malformed of [{ t: 'end', id: 1 }, { t: 'response', id: 1, status: 204, statusText: 'No Content',
    headers: [], body: new ReadableStream(), url: 'https://test/', type: 'default', redirected: false }]) {
    const channel = new MessageChannel()
    const http = new PortHttpTransport(channel.port2)
    cleanup.push(() =>{  http.close() }, () =>{  channel.port1.close() })
    channel.port1.addEventListener('message', () => {
      channel.port1.postMessage(malformed, 'body' in malformed ? [malformed.body] : [])
    }, { once: true })
    channel.port1.start()
    await expect(http.fetch(new Request('https://test/'))).rejects.toThrow()
  }
})

it('injects HTTPS without intercepting platform fetch', async () => {
  const fetcher = vi.fn(async () => new Response('registry'))
  const https = createHttpsModule(fetcher)
  const result = await new Promise<string>((resolve, reject) => {
    https.get('https://test/', (response) => {
      let text = ''
      response.on('data', (chunk) => { text += String(chunk) })
      response.on('end', () =>{  resolve(text) })
      response.on('error', reject)
    }).on('error', reject)
  })
  expect(result).toBe('registry')
  expect(fetcher).toHaveBeenCalledOnce()
})

it('rejects already cancelled requests and disposes provider requests before headers', async () => {
  const channel = new MessageChannel()
  const entered = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const provider = vi.fn((request: Request) => new Promise<Response>((_resolve, reject) => {
    request.signal.addEventListener('abort', () => { aborted.resolve(undefined); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    entered.resolve(undefined)
  }))
  const dispose = serveHttpTransport(channel.port1, { fetch: provider })
  const http = new PortHttpTransport(channel.port2)
  cleanup.push(dispose, () => { http.close() })
  await expect(http.fetch(new Request('https://test/', { signal: AbortSignal.abort() }))).rejects.toThrow()
  expect(provider).not.toHaveBeenCalled()
  const pending = http.fetch(new Request('https://test/'))
  await entered.promise
  dispose()
  await expect(pending).rejects.toThrow('closed')
  await aborted.promise
})
