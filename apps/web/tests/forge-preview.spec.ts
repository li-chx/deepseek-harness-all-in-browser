// @vitest-environment jsdom
/** Preview controls keep build failures separate from unconfirmed Worker mutations. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountForgePreview } from '../src/forge-preview.ts'

const response = (value: object, status = 200): Response => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
})
const target = { protocol: 1, generation: 'dsh-worker-rc2-6', hostPackages: {} }
const dialogMethods = ['showModal', 'close'] as const
const originalDialogMethods = dialogMethods.map(key => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, key))
let dispose: (() => void) | undefined

beforeEach(() => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
  for (const key of dialogMethods) {
    Object.defineProperty(HTMLDialogElement.prototype, key, { configurable: true,
      value: function (this: HTMLDialogElement) { this.open = key === 'showModal' },
    })
  }
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  dialogMethods.forEach((key, index) => {
    const descriptor = originalDialogMethods[index]
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, key)
  })
})

function click(text: string): void {
  const button = [...document.querySelectorAll('button')].find(element => element.textContent === text)
  if (!button) throw new Error(`Missing button: ${text}`)
  button.click()
}

function open(): void { click('DSH Forge') }
function outcome(): string { return document.querySelector('[role="status"]')?.textContent ?? '' }

it('keeps installed plugins and drafts visible when the server targets another generation', async () => {
  const runtime = vi.fn(async (path: URL | string) => response(String(path).endsWith('/target') ? target : {
    ...target, plugins: [{ pluginId: 'existing', revision: 'abcd', status: 'active' }],
  }))
  const network = vi.fn(async () => response({ ...target, generation: 'other' }))
  vi.stubGlobal('fetch', network)
  dispose = mountForgePreview('http://localhost:36936', runtime)
  open()
  await vi.waitFor(() => { expect(outcome()).toBe('Ready') })
  click('Build and install')
  await vi.waitFor(() => { expect(outcome()).toContain('different build generation') })
  expect(document.querySelector('ul')?.textContent).toContain('existing')
  expect(document.querySelector('textarea')?.value).toContain('test v1')
  expect(network).toHaveBeenCalledTimes(1)
  expect(runtime.mock.calls.some(([path]) => String(path).endsWith('/install'))).toBe(false)
})

it('reports runtime activation failure and observer errors without presenting installation success', async () => {
  let mutation: object | undefined
  const runtime = vi.fn(async (path: URL | string, init?: RequestInit) => {
    if (String(path).endsWith('/target')) return response(target)
    if (String(path).endsWith('/install')) {
      if (typeof init?.body !== 'string') throw new Error('Missing request body')
      mutation = JSON.parse(init.body) as object
      return response({ protocol: 1, pluginId: 'forge-test', revision: 'revision1', status: 'activation-failed',
        downloadedFiles: 1, writtenFiles: 2, observerErrors: ['sink unavailable'], message: 'missing service' })
    }
    return response({ ...target, plugins: [] })
  })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => response(path.endsWith('/target') ? target : { ...target, revision: 'revision1' })))
  dispose = mountForgePreview('http://localhost:36936', runtime)
  open()
  await vi.waitFor(() => { expect(outcome()).toBe('Ready') })
  click('Build and install')
  await vi.waitFor(() => { expect(outcome()).toContain('Activation failed') })
  expect(outcome()).toContain('missing service')
  expect(outcome()).toContain('sink unavailable')
  expect(mutation).toEqual({ manifest: { ...target, revision: 'revision1' }, baseUrl: 'http://localhost:36936' })
  click('Close')
  open()
  await vi.waitFor(() => { expect(outcome()).toBe('Ready') })
  expect(document.querySelector('textarea')?.value).toContain('test v1')
})

it('blocks duplicate mutations and reports an unconfirmed removal without clearing installed rows', async () => {
  let rejectRemoval: ((error: Error) => void) | undefined
  const runtime = vi.fn(async (path: URL | string) => {
    if (String(path).endsWith('/remove')) return new Promise<Response>((_resolve, reject) => { rejectRemoval = reject })
    return response({ ...target, plugins: [{ pluginId: 'forge-test', revision: 'abcd', status: 'active' }] })
  })
  dispose = mountForgePreview('http://localhost:36936', runtime)
  open()
  await vi.waitFor(() => { expect(outcome()).toBe('Ready') })
  click('Remove plugin')
  click('Remove plugin')
  expect(runtime.mock.calls.filter(([path]) => String(path).endsWith('/remove'))).toHaveLength(1)
  rejectRemoval?.(new Error('Worker stopped'))
  await vi.waitFor(() => { expect(outcome()).toContain('could not be confirmed') })
  expect(document.querySelector('ul')?.textContent).toContain('forge-test')
})

it('configures the Worker on mount and installs a published npm package through the Forge service', async () => {
  const runtime = vi.fn(async (path: URL | string) => {
    if (String(path).endsWith('/target') || String(path).endsWith('/configure')) return response(target)
    if (String(path).endsWith('/install')) return response({ protocol: 1, pluginId: 'forge-test', revision: 'npm-revision',
      status: 'active', downloadedFiles: 2, writtenFiles: 4, observerErrors: [] })
    return response({ ...target, plugins: [] })
  })
  const network = vi.fn(async (path: string) => response(path.endsWith('/target') ? target : { ...target, revision: 'npm-revision' }))
  vi.stubGlobal('fetch', network)
  dispose = mountForgePreview('http://localhost:36936', runtime)
  open()
  await vi.waitFor(() => { expect(outcome()).toBe('Ready') })
  expect(runtime.mock.calls.some(([path]) => String(path).endsWith('/configure'))).toBe(true)
  click('Install npm package')
  await vi.waitFor(() => { expect(outcome()).toContain('Active') })
  expect(network).toHaveBeenCalledWith('http://localhost:36936/v1/packages/builds', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: 1, generation: target.generation, pluginId: 'forge-test', spec: 'dsh-plugin@2.2.1' }),
  })
})

it('refuses mismatched Client platform versions before submitting a build or installation', async () => {
  const runtime = vi.fn(async (path: URL | string) => response(String(path).endsWith('/target')
    ? { ...target, clientPackages: { react: '18.3.1' } } : { ...target, plugins: [] }))
  const network = vi.fn(async () => response({ ...target, clientPackages: { react: '19.0.0' } }))
  vi.stubGlobal('fetch', network)
  dispose = mountForgePreview('http://localhost:36936', runtime)
  open()
  await vi.waitFor(() => { expect(outcome()).toBe('Ready') })
  click('Build and install')
  await vi.waitFor(() => { expect(outcome()).toContain('different shared package versions') })
  expect(network).toHaveBeenCalledTimes(1)
  expect(runtime.mock.calls.some(([path]) => String(path).endsWith('/install'))).toBe(false)
})

it.each([
  { language: 'en-US', ready: 'Ready', action: 'Build and install', status: 'Installed (disabled)' },
  { language: 'zh-CN', ready: '就绪', action: '构建并安装', status: '已安装（已禁用）' },
])('preserves disabled package feedback in $language after updating its files', async ({ language, ready, action, status }) => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language)
  const runtime = vi.fn(async (path: URL | string) => {
    if (String(path).endsWith('/target') || String(path).endsWith('/configure')) return response(target)
    if (String(path).endsWith('/install')) return response({ protocol: 1, pluginId: 'forge-test', revision: 'disabled-revision',
      status: 'disabled', downloadedFiles: 1, writtenFiles: 2, observerErrors: [] })
    return response({ ...target, plugins: [{ pluginId: 'forge-test', revision: 'disabled-revision', status: 'disabled' }] })
  })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => response(path.endsWith('/target') ? target : { ...target, revision: 'disabled-revision' })))
  dispose = mountForgePreview('http://localhost:36936', runtime)
  open()
  await vi.waitFor(() => { expect(outcome()).toBe(ready) })
  expect(document.querySelector('ul')?.textContent).toContain(status)
  click(action)
  await vi.waitFor(() => { expect(outcome()).toContain(status) })
  expect(document.querySelector('ul')?.textContent).toContain(status)
})
