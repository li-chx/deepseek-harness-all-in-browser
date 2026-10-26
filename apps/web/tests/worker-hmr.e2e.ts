/** Same-document Host module replacement through VFS watches, profile HMR and the shipped Worker. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { packRepositoryImage } from '@deepseek-ai/dsh-experimental-webworker-packer'
import { workerAuthoringPrompt } from '@deepseek-ai/dsh-experimental-webworker-packer/src/worker-authoring.ts'
import { packTar } from '@deepseek-ai/dsh-experimental-webworker-runtime'
import { compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { workerHmrFiles } from './fixtures/worker-hmr.ts'

interface ProbeState {
  boot: number
  rows: Record<string, string>
  events: string[]
}

async function probe<T = ProbeState>(page: Page, action = 'status'): Promise<T> {
  return page.evaluate(async (action) => {
    const transport = (globalThis as typeof globalThis & {
      __DSH_TRANSPORT__?: { fetch(path: string, options: RequestInit): Promise<Response> }
    }).__DSH_TRANSPORT__
    if (transport === undefined) throw new Error('Worker transport not ready')
    const response = await transport.fetch(`/hmr-probe/${action}`, { method: action === 'status' ? 'GET' : 'POST' })
    if (!response.ok) throw new Error(`Probe returned ${String(response.status)}`)
    return response.json() as Promise<T>
  }, action)
}

it('replaces shared Host code, removes and adds an entry, and recovers from a failed replacement without restarting', async () => {
  const packed = packRepositoryImage(process.cwd(), 'web')
  expect(packed.missing).toEqual([])
  const assets = new Map<string, Uint8Array>([
    ['/preview/vfs-image.tar.gz', packed.image],
    ...packed.lazyArchives.map(archive => [`/preview/${archive.name}`, archive.image] as const),
    ['/preview/hmr.tar.gz', gzipSync(packTar(Object.fromEntries(
      Object.entries(workerHmrFiles()).map(([name, source]) => [name, new TextEncoder().encode(source)]),
    )))],
    ['/preview/fixtures.json', new TextEncoder().encode(JSON.stringify({
      version: 1, defaultFixture: 'hmr', fixtures: [{
        id: 'hmr', label: 'Worker HMR test', description: 'Local test plugins', overlays: ['hmr.tar.gz'],
      }],
    }))],
  ])
  const dist = resolve('apps/web/dist')
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const filename = resolve(dist, '.' + path)
    const mime: Record<string, string> = {
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
      '.svg': 'image/svg+xml', '.gz': 'application/gzip', '.woff2': 'font/woff2',
    }
    void (async () => {
      try {
        if (!filename.startsWith(dist + sep)) throw new Error('outside static root')
        const body = assets.get(path) ?? await readFile(filename)
        res.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' })
        res.end(body)
      } catch (_error) {
        // Static misses remain visible as 404 responses.
        res.writeHead(404); res.end()
      }
    })()
  })
  server.listen(0, '127.0.0.1')
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('No HTTP port')
    browser = await chromium.launch({
      headless: true,
      ...(process.env['DSH_HMR_CHROME'] === '1' ? { channel: 'chrome' } : {}),
    })
    const page = await browser.newPage({ locale: 'en-US' })
    const logs: string[] = []
    page.on('console', (message) => { logs.push(message.text()) })
    page.on('pageerror', (error) => { logs.push(error.message) })
    let workers = 0
    page.on('worker', () => { workers++ })
    try {
      await page.goto(`http://127.0.0.1:${String(address.port)}/preview.html`)
      await page.getByRole('button', { name: 'Start Preview' }).click()
      await expect.poll(async () => {
        try { return (await probe(page)).rows } catch { return undefined }
      }, { timeout: 120_000 }).toEqual({ a: 'v1', b: 'v1', unrelated: 'stable' })
      const initial = await probe(page)
      const origin = await page.evaluate(() => performance.timeOrigin)
      await probe(page, 'v2')
      await expect.poll(async () => (await probe(page)).rows, { timeout: 15_000 })
        .toEqual({ a: 'v2', b: 'v2', unrelated: 'stable' })
      await probe(page, 'remove')
      await expect.poll(async () => (await probe(page)).rows, { timeout: 15_000 })
        .toEqual({ a: 'v2', unrelated: 'stable' })
      await probe(page, 'add')
      await expect.poll(async () => (await probe(page)).rows, { timeout: 15_000 })
        .toEqual({ a: 'v2', b: 'v2', unrelated: 'stable' })
      await probe(page, 'broken')
      await expect.poll(async () => (await probe(page)).rows, { timeout: 15_000 })
        .toEqual({ unrelated: 'stable' })
      await probe(page, 'v3')
      await expect.poll(async () => (await probe(page)).rows, { timeout: 15_000 })
        .toEqual({ a: 'v3', b: 'v3', unrelated: 'stable' })
      const guidance = workerAuthoringPrompt('/dsh', 'web')
      const greetings: string[] = []
      for (const version of ['v1', 'v2']) {
        await probe(page, `authoring-${version}`)
        const greeting = `When the user sends exactly WORKER_HELLO, reply exactly: Hello from plugin ${version}.`
        await expect.poll(async () => (await probe<{ greeting?: string }>(page, 'authoring-status')).greeting,
          { timeout: 15_000 }).toBe(greeting)
        const request = await probe<{ system: string; logged: string[]; tools: string[] }>(page, 'authoring-request')
        expect(request.system).toContain(guidance)
        expect(request.system).toContain(greeting)
        expect(request.system).not.toContain('pnpm run dev:web')
        expect(request.system).not.toContain('Use the grep tool — not shell grep or rg')
        expect(request.tools).toEqual(expect.arrayContaining(['read', 'write', 'bash']))
        expect(request.tools).not.toContain('grep')
        expect(request.tools).not.toContain('glob')
        expect(request.logged).toContain(request.system)
        greetings.push(greeting)
      }
      await compareOrRefreshGolden(resolve('apps/web/tests/expected/worker-hmr/authoring-prompt.expected.md'),
        `${guidance}\n\nObserved plugin instructions across two recorded requests:\n${greetings.join('\n')}`, webSnapshotMode())
      const protectedResult = await probe<{ pending: { url: string; reason: string }[] }>(page, 'protected')
      expect(protectedResult.pending).toContainEqual({
        url: 'file:///dsh/node_modules/%40deepseek-ai/dsh-app-boot/lib/index.js', reason: 'host-module',
      })
      const final = await probe(page)
      expect(final.boot).toBe(initial.boot)
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin)
      expect(workers).toBe(1)
      expect(final.events.filter(event => event.includes('unrelated'))).toEqual(['start:unrelated:stable'])
      const counts = Object.fromEntries([...new Set(final.events)].sort().map(event => [event,
        final.events.filter(value => value === event).length]))
      await compareOrRefreshGolden(resolve('apps/web/tests/expected/worker-hmr/lifecycle.expected.md'),
        JSON.stringify({ rows: final.rows, events: counts, workerStarts: workers, documentPreserved: true }, null, 2),
        webSnapshotMode())
    } catch (error) {
      console.error(logs.join('\n'))
      throw error
    }
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  }
})
