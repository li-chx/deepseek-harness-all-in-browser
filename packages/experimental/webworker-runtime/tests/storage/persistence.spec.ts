/** Atomic overlay storage, append deltas and terminal write-behind failures. */
import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { IndexedDbVfsProvider, vfsPersistenceNamespace } from '../../src/storage/indexeddb.ts'
import { VfsPersistenceController } from '../../src/storage/persistence.ts'
import type { VfsPersistenceProvider, VfsStorageOperation, VfsStorageSnapshot } from '../../src/storage/persistence.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const namespace = vfsPersistenceNamespace({ generation: 'generation', source: '/preview', deployment: 'local' })
function provider(indexedDB = new IDBFactory(), root?: string) {
  return new IndexedDbVfsProvider({ namespace, indexedDB, ...root ? { root } : {} })
}
function image(sink?: VfsPersistenceController, root = '/dsh') {
  const vfs = new MemoryVfs(sink ? { sink } : {})
  vfs.seed(`${root}/home/base.txt`, 'base')
  vfs.seed(`${root}/home/deleted/child.txt`, 'do not resurrect')
  vfs.seed(`${root}/workspace/project.txt`, 'project')
  vfs.seed(`${root}/node_modules/core.js`, 'core')
  return vfs
}
async function mounted(storage: VfsPersistenceProvider, root = '/dsh') {
  const controller = new VfsPersistenceController(storage, { root })
  const vfs = image(controller, root)
  await controller.hydrate(vfs)
  return { controller, vfs }
}

it('empty hydration stores no base files and only mirrors mutable roots', async () => {
  const storage = provider()
  try {
    const { controller, vfs } = await mounted(storage)
    await controller.flush()
    expect(await storage.load()).toEqual({ revision: 0, records: [] })
    vfs.writeFileSync('/dsh/node_modules/core.js', 'ignored')
    vfs.writeFileSync('/dsh/home/new.txt', 'kept')
    await controller.flush()
    expect(controller.status()).toEqual({ kind: 'saved', revision: 1, pending: 0 })
    const restored = await mounted(storage)
    expect(restored.vfs.readFileSync('/dsh/home/new.txt', 'utf8')).toBe('kept')
    expect(restored.vfs.readFileSync('/dsh/node_modules/core.js', 'utf8')).toBe('core')
    expect((await storage.load()).records.map(entry => entry.path)).toEqual(['/dsh/home/new.txt'])
  } finally { await storage.close() }
})

it('append writes use small deltas after first materialization and restore chunk-spanning JSONL', async () => {
  const storage = provider()
  const calls: VfsStorageOperation[][] = []
  const wrapped: VfsPersistenceProvider = {
    load: () => storage.load(),
    apply: (revision, operations) => { calls.push([...operations]); return storage.apply(revision, operations) },
  }
  try {
    const { controller, vfs } = await mounted(wrapped)
    const large = 'x'.repeat(65535)
    vfs.writeFileSync('/dsh/home/log.jsonl', large)
    await controller.flush()
    vfs.appendFileSync('/dsh/home/log.jsonl', '\n{"event":1}\n')
    vfs.appendFileSync('/dsh/home/log.jsonl', '{"event":2}\n')
    await controller.flush()
    expect(calls[1]!.map(operation => operation.kind)).toEqual(['append', 'append'])
    expect(calls[1]!.map(operation => 'bytes' in operation ? operation.bytes.length : 0)).toEqual([13, 12])
    const restored = await mounted(storage)
    expect(restored.vfs.readFileSync('/dsh/home/log.jsonl', 'utf8')).toBe(large + '\n{"event":1}\n{"event":2}\n')
    vfs.appendFileSync('/dsh/home/base.txt', ' plus')
    await controller.flush()
    expect(calls.at(-1)![0]!.kind).toBe('write')
    expect((await mounted(storage)).vfs.readFileSync('/dsh/home/base.txt', 'utf8')).toBe('base plus')
  } finally { await storage.close() }
})

it('directory rename is one atomic transaction and tombstones survive recreation', async () => {
  const storage = provider()
  const groups: VfsStorageOperation[][] = []
  try {
    const { controller, vfs } = await mounted({
      load: () => storage.load(),
      apply: (revision, operations) => { groups.push([...operations]); return storage.apply(revision, operations) },
    })
    vfs.renameSync('/dsh/home/deleted', '/dsh/home/moved')
    await controller.flush()
    expect(groups).toHaveLength(1)
    expect(groups[0]!.map(operation => operation.kind)).toEqual(['remove', 'mkdir', 'write'])
    let restored = await mounted(storage)
    expect(restored.vfs.existsSync('/dsh/home/deleted')).toBe(false)
    expect(restored.vfs.readFileSync('/dsh/home/moved/child.txt', 'utf8')).toBe('do not resurrect')
    vfs.mkdirSync('/dsh/home/deleted')
    vfs.writeFileSync('/dsh/home/deleted/new.txt', 'new')
    await controller.flush()
    restored = await mounted(storage)
    expect(restored.vfs.existsSync('/dsh/home/deleted/child.txt')).toBe(false)
    expect(restored.vfs.readFileSync('/dsh/home/deleted/new.txt', 'utf8')).toBe('new')
  } finally { await storage.close() }
})

it('base file and directory chmod materialize permissions and file modification time', async () => {
  const storage = provider()
  try {
    const { controller, vfs } = await mounted(storage)
    vfs.chmodSync('/dsh/home/base.txt', 0o600)
    vfs.chmodSync('/dsh/workspace', 0o700)
    const mtime = vfs.statSync('/dsh/home/base.txt').mtimeMs
    await controller.flush()
    const restored = await mounted(storage)
    expect(Number(restored.vfs.statSync('/dsh/home/base.txt').mode) & 0o777).toBe(0o600)
    expect(Number(restored.vfs.statSync('/dsh/workspace').mode) & 0o777).toBe(0o700)
    expect(restored.vfs.statSync('/dsh/home/base.txt').mtimeMs).toBe(mtime)
  } finally { await storage.close() }
})

it('two tabs race the same revision and exactly one commit wins', async () => {
  const factory = new IDBFactory()
  const first = provider(factory); const second = provider(factory)
  try {
    const left = await mounted(first); const right = await mounted(second)
    left.vfs.writeFileSync('/dsh/home/left.txt', 'left')
    right.vfs.writeFileSync('/dsh/home/right.txt', 'right')
    await Promise.all([left.controller.flush(), right.controller.flush()])
    const states = [left.controller.status(), right.controller.status()]
    expect(states.map(state => state.kind).sort()).toEqual(['failed', 'saved'])
    expect(states.find(state => state.kind === 'failed')!.error!.code).toBe('STORAGE_CONFLICT')
    expect((await first.load()).records).toHaveLength(1)
    const loser = states[0]!.kind === 'failed' ? left : right
    loser.vfs.writeFileSync('/dsh/home/later.txt', 'memory only')
    await loser.controller.flush()
    expect(loser.vfs.readFileSync('/dsh/home/later.txt', 'utf8')).toBe('memory only')
    expect((await first.load()).revision).toBe(1)
  } finally { await Promise.all([first.close(), second.close()]) }
})

it('a late transaction error rolls back earlier operations and keeps its revision', async () => {
  const storage = provider()
  try {
    await expect(storage.apply(0, [
      { kind: 'write', path: '/dsh/home/partial', mode: 0o600, bytes: encode('partial') },
      { kind: 'write', path: '/dsh/node_modules/forbidden', mode: 0o600, bytes: encode('core') },
    ])).rejects.toMatchObject({ code: 'STORAGE_SCOPE' })
    expect(await storage.load()).toEqual({ revision: 0, records: [] })
  } finally { await storage.close() }
})

it('a failed synchronous batch never submits its partial mutations', async () => {
  const storage = provider()
  let commits = 0
  try {
    const { controller, vfs } = await mounted({
      load: () => storage.load(),
      apply: async (revision, operations) => { commits++; return storage.apply(revision, operations) },
    })
    expect(() => {
      controller.batch(() => { vfs.writeFileSync('/dsh/home/partial', 'memory'); throw Error('write failure') })
    }).toThrow('write failure')
    await controller.flush()
    expect(commits).toBe(0)
    expect(controller.status()).toMatchObject({ kind: 'failed', error: { code: 'STORAGE_BATCH_FAILED' } })
    expect(vfs.readFileSync('/dsh/home/partial', 'utf8')).toBe('memory')
    expect((await storage.load()).records).toEqual([])
  } finally { await storage.close() }
})

it('a successful synchronous batch acknowledges only after the provider completes', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const mutableGroups: VfsStorageOperation[][] = []
  const storage: VfsPersistenceProvider = {
    load: async () => ({ revision: 0, records: [] }),
    apply: async (_revision, operations) => { mutableGroups.push([...operations]); await gate; return 1 },
  }
  const { controller, vfs } = await mounted(storage)
  controller.batch(() => { vfs.writeFileSync('/dsh/home/files', 'files'); vfs.writeFileSync('/dsh/home/catalog', 'catalog') })
  const pending = controller.flush()
  await Promise.resolve()
  expect(controller.status().kind).toBe('pending')
  expect(mutableGroups).toHaveLength(1)
  expect(mutableGroups[0]).toHaveLength(2)
  release!(); await pending
  expect(controller.status().kind).toBe('saved')
})

it('hydrate reports pending until validated and rejects traversal before changing the image', async () => {
  let resolveLoad: ((snapshot: VfsStorageSnapshot) => void) | undefined
  const storage: VfsPersistenceProvider = { load: () => new Promise((resolve) => { resolveLoad = resolve }), apply: async () => { throw Error('Unexpected write') } }
  const controller = new VfsPersistenceController(storage)
  const vfs = image(controller)
  const hydrate = controller.hydrate(vfs)
  expect(controller.status().kind).toBe('pending')
  resolveLoad!({ revision: 1, records: [{ kind: 'remove', path: '/dsh/home/base.txt' }, { kind: 'remove', path: '/dsh/home/../node_modules' }] })
  await expect(hydrate).rejects.toMatchObject({ code: 'STORAGE_SCOPE' })
  expect(vfs.readFileSync('/dsh/home/base.txt', 'utf8')).toBe('base')
  expect(controller.status().kind).toBe('failed')
})

it('schema, generation, source and deployment namespace identities remain distinct', () => {
  const base = { generation: 'g1', source: '/one', deployment: 'a' }
  const names = [base, { ...base, generation: 'g2' }, { ...base, source: '/two' }, { ...base, deployment: 'b' }].map(vfsPersistenceNamespace)
  expect(new Set(names).size).toBe(4)
  expect(names[0]).toContain('[1,')
})

it('custom mount roots use the same overlay restrictions', async () => {
  const storage = provider(new IDBFactory(), '/custom')
  try {
    const { controller, vfs } = await mounted(storage, '/custom')
    vfs.writeFileSync('/custom/home/item', 'custom')
    await controller.flush()
    expect((await mounted(storage, '/custom')).vfs.readFileSync('/custom/home/item', 'utf8')).toBe('custom')
  } finally { await storage.close() }
})

it('dispose waits for its pending transaction, closes once and detaches observers', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let closes = 0
  const provider: VfsPersistenceProvider = {
    load: async () => ({ revision: 0, records: [] }),
    apply: async () => { await gate; return 1 },
    close: async () => { closes++ },
  }
  const { controller, vfs } = await mounted(provider)
  const states: string[] = []
  controller.subscribe((state) => { states.push(state.kind) })
  vfs.writeFileSync('/dsh/home/queued', 'queued')
  const disposed = controller.dispose()
  expect(closes).toBe(0)
  release!(); await disposed
  await controller.dispose()
  expect(closes).toBe(1)
  expect(states.at(-1)).toBe('saved')
  const count = states.length
  vfs.writeFileSync('/dsh/home/late', 'memory')
  expect(states).toHaveLength(count)
})

it('invalid append offsets abort the whole batch and leave earlier bytes intact', async () => {
  const storage = provider()
  try {
    await storage.apply(0, [{ kind: 'write', path: '/dsh/home/log', mode: 0o600, bytes: encode('before') }])
    await expect(storage.apply(1, [{ kind: 'append', path: '/dsh/home/log', offset: 99, mode: 0o600, bytes: encode('after') }])).rejects.toMatchObject({ code: 'STORAGE_APPEND_CONFLICT' })
    const snapshot = await storage.load()
    expect(snapshot.revision).toBe(1)
    expect(snapshot.records[0]).toMatchObject({ kind: 'file', bytes: encode('before') })
  } finally { await storage.close() }
})

it('invalid persisted parent relationships fail before overlaying any records', async () => {
  const storage: VfsPersistenceProvider = { load: async () => ({ revision: 1, records: [
    { kind: 'remove', path: '/dsh/home/base.txt' },
    { kind: 'file', path: '/dsh/home/parent', mode: 0o600, bytes: encode('file') },
    { kind: 'directory', path: '/dsh/home/parent/child', mode: 0o700 },
  ] }), apply: async () => { throw Error('Unexpected write') } }
  const controller = new VfsPersistenceController(storage)
  const vfs = image(controller)
  await expect(controller.hydrate(vfs)).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' })
  expect(vfs.readFileSync('/dsh/home/base.txt', 'utf8')).toBe('base')
})
