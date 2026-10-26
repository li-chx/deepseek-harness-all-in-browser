/** The workbench owns drafts, reports failed operations and contains late responses after disposal. */
import { describe, expect, it } from 'vitest'
import { WorkbenchController } from '../src/client/controller.ts'
import type { WorkbenchAction } from '../src/client/controller.ts'

const current = { protocol: 1, action: 'status', generation: 'test', root: '/dsh', workspace: '/dsh/workspace', profileDirectory: '/dsh/home/profiles/web', plugins: [], historyPlugins: [] }
const files = { protocol: 1, action: 'projects', projects: [] }
function subject(reply: (action: Record<string, unknown>, signal: AbortSignal) => Response | Promise<Response>) {
  const calls: Record<string, unknown>[] = []
  const controller = new WorkbenchController(async (_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON request body')
    const value: unknown = JSON.parse(init.body)
    if (value === null || typeof value !== 'object' || Array.isArray(value) || init?.signal == null) throw new Error('Invalid test request')
    const action = value as Record<string, unknown>
    calls.push(action)
    if (action.action === 'status') return Response.json(current)
    if (action.action === 'projects') return Response.json(files)
    return reply(action, init.signal)
  })
  return { controller, calls }
}

describe('Worker workbench controller', () => {
  it('retains drafts after conflicts and explicitly discards only the in-memory changes', async (t) => {
    const { controller, calls } = subject(action => action.action === 'read'
      ? Response.json({ protocol: 1, action: 'read', path: '/dsh/workspace/a.ts', text: 'v1', sha256: 'old-hash' })
      : Response.json({ error: { code: 'file-conflict', message: 'Changed elsewhere' } }, { status: 409 }))
    t.onTestFinished(() => { controller.dispose() })
    await controller.refresh()
    await controller.openFile('/dsh/workspace/a.ts')
    controller.edit('v2')
    await controller.save('Saved')
    expect(calls.findLast(call => call.action === 'write')).toEqual({ action: 'write', path: '/dsh/workspace/a.ts', text: 'v2', expectedSha256: 'old-hash' })
    expect(controller.source.getSnapshot().editor?.text).toBe('v2')
    expect(controller.source.getSnapshot().editor?.original).toBe('v1')
    expect(controller.source.getSnapshot().notice?.success).toBe(false)
    controller.discard()
    expect(controller.source.getSnapshot().editor?.text).toBe('v1')
    expect(controller.source.getSnapshot().editor?.sha256).toBe('old-hash')
  })

  it('saves new files without an overwrite hash and advances only the committed draft baseline', async (t) => {
    const { controller, calls } = subject(() => Response.json({ protocol: 1, action: 'write', path: '/dsh/workspace/new.ts', sha256: 'new-hash' }))
    t.onTestFinished(() => { controller.dispose() })
    controller.newFile('/dsh/workspace/new.ts')
    controller.edit('source')
    await controller.save('Saved')
    expect(calls[0]).toEqual({ action: 'write', path: '/dsh/workspace/new.ts', text: 'source' })
    expect(controller.source.getSnapshot().editor).toEqual({ path: '/dsh/workspace/new.ts', text: 'source', original: 'source', sha256: 'new-hash', writable: true })
  })

  it('retains command output for nonzero exit without reporting a successful build', async (t) => {
    const { controller } = subject(() => Response.json({ protocol: 1, action: 'build', cwd: '/dsh/workspace', exitCode: 1, stdout: 'Building\n', stderr: 'Compile failed\n' }))
    t.onTestFinished(() => { controller.dispose() })
    expect(await controller.perform({ action: 'build', directory: '/dsh/workspace' }, 'Built')).toBeUndefined()
    expect(controller.source.getSnapshot().output).toBe('Building\nCompile failed\n\n[exit 1]')
    expect(controller.source.getSnapshot().notice?.success).toBe(false)
    expect(controller.source.getSnapshot().busy).toBe(false)
  })

  it('reports activation failures without a successful restore banner', async (t) => {
    const { controller } = subject(() => Response.json({ protocol: 1, action: 'restore', status: 'activation-failed', message: 'Missing service' }))
    t.onTestFinished(() => { controller.dispose() })
    expect(await controller.perform({ action: 'restore', pluginId: 'local', revision: 'old' }, 'Restored')).toBeUndefined()
    expect(controller.source.getSnapshot().notice?.text).toBe('Missing service')
    expect(controller.source.getSnapshot().notice?.success).toBe(false)
  })

  it('rejects malformed consumed fields and keeps the existing editor', async (t) => {
    const { controller } = subject(() => Response.json({ protocol: 1, action: 'read', path: '/dsh/workspace/a.ts', text: 7, sha256: 'hash' }))
    t.onTestFinished(() => { controller.dispose() })
    controller.newFile('/dsh/workspace/new.ts')
    controller.edit('retained')
    await controller.openFile('/dsh/workspace/a.ts')
    expect(controller.source.getSnapshot().editor?.text).toBe('retained')
    expect(controller.source.getSnapshot().notice?.success).toBe(false)
  })

  it('cancels owned calls and prevents their completion from publishing after disposal', async () => {
    let signal: AbortSignal | undefined
    const reply = Promise.withResolvers<Response>()
    const { controller } = subject((_action, lifetime) => { signal = lifetime; return reply.promise })
    const pending = controller.perform({ action: 'shell', cwd: '/dsh/workspace', command: 'pwd' })
    const before = controller.source.getSnapshot()
    controller.dispose()
    expect(signal?.aborted).toBe(true)
    reply.resolve(Response.json({ protocol: 1, action: 'shell', cwd: '/dsh/workspace', exitCode: 0, stdout: '/dsh/workspace', stderr: '' }))
    await pending
    expect(controller.source.getSnapshot()).toBe(before)
  })
  it('refreshes after an unconfirmed mutation and preserves the editor draft', async (t) => {
    const { controller, calls } = subject(() => { throw new TypeError('Network failed') })
    t.onTestFinished(() => { controller.dispose() })
    await controller.refresh()
    controller.newFile('/dsh/workspace/new.ts')
    controller.edit('unsaved')
    await controller.save('Saved')
    expect(controller.source.getSnapshot().notice?.uncertain).toBe(true)
    expect(controller.source.getSnapshot().editor?.text).toBe('unsaved')
    expect(calls.filter(call => call.action === 'status')).toHaveLength(2)
  })

  it('does not let a read started before a mutation satisfy its post-write refresh', async (t) => {
    const first = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<boolean>()
    let statuses = 0
    const controller = new WorkbenchController(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON body')
      const parsed: unknown = JSON.parse(init.body)
      if (parsed === null || typeof parsed !== 'object' || !('action' in parsed)) throw new Error('Invalid test action')
      const action = parsed.action
      if (action === 'status') {
        statuses++
        if (statuses === 1) { started.resolve(true); return first.promise }
        return Response.json({ ...current, baseUrl: 'http://new' })
      }
      if (action === 'projects') return Response.json(files)
      return Response.json({ protocol: 1, action: 'write', path: '/dsh/workspace/new.ts', sha256: 'hash' })
    })
    t.onTestFinished(() => { controller.dispose() })
    const loading = controller.refresh()
    await started.promise
    controller.newFile('/dsh/workspace/new.ts')
    controller.edit('saved')
    const saving = controller.save('Saved')
    first.resolve(Response.json({ ...current, baseUrl: 'http://old' }))
    await Promise.all([loading, saving])
    expect(statuses).toBe(2)
    expect(controller.source.getSnapshot().status?.baseUrl).toBe('http://new')
  })

  it('moves the observed draft with a renamed directory and clears it after explicit deletion', async (t) => {
    const { controller } = subject(action => action.action === 'read'
      ? Response.json({ protocol: 1, action: 'read', path: '/dsh/workspace/old/a.ts', text: 'v1', sha256: 'hash' })
      : Response.json({ protocol: 1, action: action.action, path: '/dsh/workspace/new' }))
    t.onTestFinished(() => { controller.dispose() })
    await controller.openFile('/dsh/workspace/old/a.ts')
    await controller.perform({ action: 'rename', path: '/dsh/workspace/old', to: '/dsh/workspace/new' })
    expect(controller.source.getSnapshot().editor?.path).toBe('/dsh/workspace/new/a.ts')
    expect(controller.source.getSnapshot().editor?.sha256).toBe('hash')
    await controller.perform({ action: 'delete', path: '/dsh/workspace/new' })
    expect(controller.source.getSnapshot().editor).toBeUndefined()
  })

  it.for<WorkbenchAction>([
    { action: 'restore', pluginId: 'local', revision: 'old' },
    { action: 'remove', pluginId: 'local' },
    { action: 'plugin-import', archive: {} },
  ])('reports applied $action with observer errors as a warning and refreshes current state', async (action, t) => {
    const { controller, calls } = subject(() => Response.json({
      protocol: 1, action: action.action, status: action.action === 'remove' ? 'removed' : 'active', observerErrors: ['Observer failed'],
    }))
    t.onTestFinished(() => { controller.dispose() })
    await controller.refresh()
    const result = await controller.perform(action, 'Success')
    expect(result?.status).toBe(action.action === 'remove' ? 'removed' : 'active')
    expect(controller.source.getSnapshot().notice).toMatchObject({ success: false, observerWarning: true, text: 'Observer failed' })
    expect(controller.source.getSnapshot().output).toBe('Observer failed')
    expect(calls.filter(call => call.action === 'status')).toHaveLength(2)
  })

})


describe('workbench explicit saving', () => {
  it('waits for commit acknowledgement and prevents duplicate save requests', async (t) => {
    const reply = Promise.withResolvers<import('@deepseek-ai/dsh-experimental-webworker-runtime/client').VfsPersistenceStatus>()
    let calls = 0
    const controller = new WorkbenchController(fetch, { subscribe: () => () => {}, flush: () => { calls++; return reply.promise } })
    t.onTestFinished(() => { controller.dispose() })
    controller.updateStorage({ kind: 'pending', revision: 1, pending: 1 })
    const pending = controller.flushStorage()
    await controller.flushStorage()
    expect(calls).toBe(1)
    expect(controller.source.getSnapshot().flushing).toBe(true)
    expect(controller.source.getSnapshot().storage?.kind).toBe('pending')
    reply.resolve({ kind: 'saved', revision: 2, pending: 0 })
    await pending
    expect(controller.source.getSnapshot().flushing).toBe(false)
    expect(controller.source.getSnapshot().storage).toEqual({ kind: 'saved', revision: 2, pending: 0 })
  })

  it('retains an unconfirmed save failure and does not retry it implicitly', async (t) => {
    let calls = 0
    const controller = new WorkbenchController(fetch, { subscribe: () => () => {}, flush: () => { calls++; return Promise.reject(new Error('Connection lost')) } })
    t.onTestFinished(() => { controller.dispose() })
    controller.updateStorage({ kind: 'saved', revision: 1, pending: 0 })
    await controller.flushStorage()
    expect(controller.source.getSnapshot().storageError).toBe('Connection lost')
    expect(controller.source.getSnapshot().flushing).toBe(false)
    await controller.flushStorage()
    expect(calls).toBe(1)
  })

  it('keeps a terminal storage conflict when an earlier flush reply arrives', async (t) => {
    const reply = Promise.withResolvers<import('@deepseek-ai/dsh-experimental-webworker-runtime/client').VfsPersistenceStatus>()
    const controller = new WorkbenchController(fetch, { subscribe: () => () => {}, flush: () => reply.promise })
    t.onTestFinished(() => { controller.dispose() })
    controller.updateStorage({ kind: 'saved', revision: 1, pending: 0 })
    const pending = controller.flushStorage()
    controller.updateStorage({ kind: 'failed', revision: 1, pending: 1, error: { code: 'STORAGE_CONFLICT', message: 'Another tab wrote' } })
    reply.resolve({ kind: 'saved', revision: 1, pending: 0 })
    await pending
    expect(controller.source.getSnapshot().storage?.kind).toBe('failed')
  })
})
