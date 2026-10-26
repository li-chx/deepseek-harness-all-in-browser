// @vitest-environment jsdom
/** Durable status reflects acknowledged commits and leaves failures visible. */
import { afterEach, expect, it, vi } from 'vitest'
import { WorkerTunnel, type WorkerHostConnection, type VfsPersistenceStatus } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
import { mountPreviewStorage, previewStorageOptions, type PreviewStorageUi } from '../src/preview-storage.ts'

let ui: PreviewStorageUi | undefined
afterEach(() => { ui?.dispose(); ui = undefined; vi.restoreAllMocks() })
const page = new URL('http://preview.test/preview.html?preview-fixture=none&forge=http://forge.test')
const image = new URL('preview/base.tar.gz', page)

it('isolates source overlays and deployment paths while retaining data after the Forge URL changes', () => {
  const selected = previewStorageOptions(page, image, [])
  expect(selected?.kind).toBe('indexeddb')
  const otherForge = new URL(page)
  otherForge.searchParams.set('forge', 'http://offline.test')
  expect(previewStorageOptions(otherForge, image, [])).toEqual(selected)
  expect(previewStorageOptions(page, image, [new URL('fixture.tar.gz', page)])).not.toEqual(selected)
  expect(previewStorageOptions(new URL('/other/preview.html?forge=x', page), image, [])).not.toEqual(selected)
  const temporary = new URL(page)
  temporary.searchParams.set('storage', 'none')
  expect(previewStorageOptions(temporary, image, [])).toBeUndefined()
  temporary.searchParams.set('storage', 'typo')
  expect(() => previewStorageOptions(temporary, image, [])).toThrow('unknown storage mode')
})

function connection(): { value: WorkerHostConnection; status(status: VfsPersistenceStatus): void; worker: Worker } {
  const worker = Object.assign(new EventTarget(), {
    postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onmessageerror: null, onerror: null,
  })
  const tunnel = new WorkerTunnel(worker)
  return { worker, value: { worker, tunnel, disposeHttp() {}, loadBundle: async () => {} },
    status: (status) => { worker.dispatchEvent(new MessageEvent('message', { data: { t: 'storage-status', status } })) },
  }
}

it.each(['en-US', 'zh-CN'])('leaves routine saving to the workbench in %s', (language) => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language)
  ui = mountPreviewStorage()
  const host = connection()
  host.status({ kind: 'pending', revision: 0, pending: 0 })
  ui.connect(host.value)
  expect(document.querySelector('[data-worker-storage]')).toBeNull()
  host.status({ kind: 'saved', revision: 1, pending: 0 })
  expect(document.querySelector('[data-worker-storage]')).toBeNull()
  expect(document.body.hasAttribute('data-preview-storage-layout')).toBe(false)
  host.status({ kind: 'pending', revision: 1, pending: 1 })
  expect(document.querySelector('[data-worker-storage]')).toBeNull()
})

it('preserves visible conflict details and blocks another save after a stale write', () => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
  ui = mountPreviewStorage()
  const host = connection()
  ui.connect(host.value)
  host.status({ kind: 'failed', revision: 1, pending: 1, error: { code: 'STORAGE_CONFLICT', message: '<img src=x>' } })
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Another tab saved changes')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('<img src=x>')
  expect(document.querySelector('img')).toBeNull()
  expect(document.querySelector('button')?.textContent).toBe('Reload')
  expect(document.querySelector('button')?.disabled).toBe(false)
  ui.dispose()
  expect(document.querySelector('[data-worker-storage]')).toBeNull()
  expect(document.body.hasAttribute('data-preview-storage-layout')).toBe(false)
})

it('shows failed boot before a connection exists without suggesting local data was saved', () => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
  ui = mountPreviewStorage()
  ui.fail(new Error('Invalid saved catalog'))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Startup failed. Local data was not cleared.')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Invalid saved catalog')
  expect(document.querySelector('button')?.textContent).toBe('Reload')
  expect(document.querySelector('button')?.disabled).toBe(false)
})


it('keeps a stopped Worker visible even when the workbench is unavailable', () => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
  ui = mountPreviewStorage()
  const host = connection()
  ui.connect(host.value)
  host.worker.dispatchEvent(new ErrorEvent('error', { message: 'Worker crashed' }))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('The Worker stopped')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Worker crashed')
})
