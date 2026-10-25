/** Cold-start ownership, integrity checks and atomic file/catalog storage groups. */
import { createHash } from 'node:crypto'
import { IDBFactory } from 'fake-indexeddb'
import { expect, it } from 'vitest'
import { applyForgeMappings, readForgeCatalog, type ForgeCatalog } from '../src/forge/catalog.ts'
import { ForgeInstaller } from '../src/forge/installer.ts'
import { editForgeProfilePatch } from '../src/forge/profile-patch.ts'
import { FORGE_GENERATION, type ForgeManifest } from '../src/forge/protocol.ts'
import { WorkerModuleLoader } from '../src/module-system/module-loader.ts'
import { MemoryVfs } from '../src/storage/memory.ts'
import { IndexedDbVfsProvider, vfsPersistenceNamespace } from '../src/storage/indexeddb.ts'
import { VfsPersistenceController } from '../src/storage/persistence.ts'

const profile = '/dsh/home/profiles/web'
const catalogPath = `${profile}/plugins/.forge/installed.json`
const hostPackages = { host: '1.0.0' }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function plan(version: number) {
  const source = `exports.value = require('private-helper').value + ${version}; exports.instance = {}`
  const helper = 'exports.value = 10'
  const patch = '- insert:\n  - id: persisted-plugin\n    name: persistent-plugin\n'
  const id = hash(source)
  const helperId = hash(helper)
  const files = new Map([[hash(source), source], [hash(helper), helper], [hash(patch), patch]])
  const file = (path: string, bytes: string) => ({ path, sha256: hash(bytes), size: Buffer.byteLength(bytes), objectKey: `${FORGE_GENERATION}/objects/${hash(bytes)}` })
  const manifest: ForgeManifest = { protocol: 1, generation: FORGE_GENERATION, revision: id,
    plugin: { id: 'persisted', name: 'persistent-plugin', version: `${version}.0.0`, packageId: id, entry: 'lib/main.js' }, hostPackages: {},
    packages: [
      { id, name: 'persistent-plugin', version: `${version}.0.0`, entry: 'lib/main.js', hostDependencies: [], dependencies: { 'private-helper': helperId },
        files: [file('lib/main.js', source), file('cordis.patch.yml', patch)], metadata: { dsh: { bundle: { patch: './cordis.patch.yml' } } } },
      { id: helperId, name: 'private-helper', version: '1.0.0', entry: 'index.js', hostDependencies: [], dependencies: {}, files: [file('index.js', helper)] },
    ] }
  return { manifest, files }
}
function base(vfs: MemoryVfs) {
  vfs.seed(`${profile}/cordis.patch.yml`, '[]\n')
  vfs.seed('/dsh/node_modules/host/package.json', '{"name":"host","version":"1.0.0","main":"index.js"}')
  vfs.seed('/dsh/node_modules/host/index.js', 'exports.host = true')
}
function assemble(vfs: MemoryVfs, persistence?: VfsPersistenceController) {
  const modules = new WorkerModuleLoader({ vfs, staticModules: {} })
  const catalog = readForgeCatalog(vfs, profile, hostPackages)
  applyForgeMappings(modules, profile, hostPackages, catalog)
  const files = new Map<string, string>()
  let active = true
  let disabled = false
  let failure = false
  let inspect: () => Promise<void> = async () => {}
  const installer = new ForgeInstaller({ vfs, modules, profileDirectory: profile, hostPackages, restoredCatalog: catalog,
    ...persistence === undefined ? {} : { withFileBatch: (operation: () => void) => { persistence.batch(operation) } },
    isEntryActive: () => active, isEntryDisabled: () => disabled, editPatch: editForgeProfilePatch,
    hmr: { runExclusive: async operation => operation(), reconcileProfile: async (ids) => {
      await inspect()
      if (failure) throw new Error('activation failed')
      active = !!ids?.length && !disabled
      return { warnings: [], pending: [] }
    } },
    fetch: async (input) => {
      const key = new URL(input instanceof Request ? input.url : input.toString()).pathname.split('/').at(-1)!
      const bytes = files.get(key)
      if (bytes === undefined) throw new Error('Forge is offline')
      return new Response(bytes)
    },
  })
  return { modules, installer, files,
    inspect: (fn: () => Promise<void>) => { inspect = fn },
    active: (value: boolean) => { active = value }, disabled: (value: boolean) => { disabled = value },
    fail: () => { failure = true },
  }
}

it('restores files and grants before code loads, then updates and removes without rebuilding the installed package', async () => {
  const indexedDB = new IDBFactory()
  const namespace = vfsPersistenceNamespace({ generation: FORGE_GENERATION, source: 'catalog-test', deployment: 'roundtrip' })
  const provider = new IndexedDbVfsProvider({ namespace, indexedDB })
  const persistence = new VfsPersistenceController(provider)
  const vfs = new MemoryVfs({ sink: persistence })
  base(vfs)
  await persistence.hydrate(vfs)
  const first = assemble(vfs, persistence)
  const initial = plan(1)
  for (const item of initial.files) first.files.set(...item)
  first.inspect(async () => {
    await persistence.flush()
    const restored = new MemoryVfs()
    base(restored)
    await new VfsPersistenceController(provider).hydrate(restored)
    expect(readForgeCatalog(restored, profile, hostPackages).manifests).toHaveLength(1)
    expect(JSON.parse(restored.readFileSync(catalogPath, 'utf8') as string)).toMatchObject({ schema: 1, phase: 'applied' })
  })
  await first.installer.install(initial.manifest, 'https://forge.invalid')
  const old = first.modules.requireFrom('/dsh')('persistent-plugin') as { instance: object }
  await first.installer.close()
  await persistence.flush()
  await provider.close()

  const nextProvider = new IndexedDbVfsProvider({ namespace, indexedDB })
  const nextPersistence = new VfsPersistenceController(nextProvider)
  const restored = new MemoryVfs({ sink: nextPersistence })
  base(restored)
  await nextPersistence.hydrate(restored)
  const next = assemble(restored, nextPersistence)
  expect(next.modules.hmrModules.records()).toEqual([])
  const loaded = next.modules.requireFrom('/dsh')('persistent-plugin') as { value: number; instance: object }
  expect(loaded.value).toBe(11)
  expect(loaded.instance).not.toBe(old.instance)
  expect(next.installer.installed().plugins[0]?.status).toBe('active')
  expect(await next.installer.install(initial.manifest, 'https://offline.invalid')).toMatchObject({ downloadedFiles: 0, writtenFiles: 0 })
  const update = plan(2)
  for (const item of update.files) next.files.set(...item)
  expect(await next.installer.install(update.manifest, 'https://forge.invalid')).toMatchObject({ status: 'active' })
  expect(await next.installer.remove('persisted')).toMatchObject({ status: 'removed' })
  await next.installer.close()
  await nextPersistence.flush()
  const empty = new MemoryVfs()
  base(empty)
  await new VfsPersistenceController(nextProvider).hydrate(empty)
  expect(readForgeCatalog(empty, profile, hostPackages).manifests).toEqual([])
  expect(empty.existsSync(`${profile}/node_modules/persistent-plugin`)).toBe(false)
  await nextProvider.close()
})

it('recomputes native disablement and activation failure after a cold boot', async () => {
  const vfs = new MemoryVfs()
  base(vfs)
  const first = assemble(vfs)
  const initial = plan(1)
  for (const item of initial.files) first.files.set(...item)
  await first.installer.install(initial.manifest, 'https://forge.invalid')
  const path = `${profile}/package.json`
  const pkg = JSON.parse(vfs.readFileSync(path, 'utf8') as string) as { dsh: { profile: { bundles: string[] } } }
  pkg.dsh.profile.bundles = []
  vfs.writeFileSync(path, JSON.stringify(pkg))
  const next = assemble(vfs)
  next.active(false)
  expect(next.installer.installed().plugins[0]?.status).toBe('disabled')
  pkg.dsh.profile.bundles = ['persistent-plugin']
  vfs.writeFileSync(path, JSON.stringify(pkg))
  expect(next.installer.installed().plugins[0]?.status).toBe('activation-failed')
  next.disabled(true)
  expect(next.installer.installed().plugins[0]?.status).toBe('disabled')
})

it('keeps a failed update catalog recoverable and collects retired files only after successful fresh activation', async () => {
  const vfs = new MemoryVfs()
  base(vfs)
  const first = assemble(vfs)
  const initial = plan(1)
  const update = plan(2)
  for (const item of [...initial.files, ...update.files]) first.files.set(...item)
  await first.installer.install(initial.manifest, 'https://forge.invalid')
  first.fail()
  expect(await first.installer.install(update.manifest, 'https://forge.invalid')).toMatchObject({ status: 'activation-failed' })
  expect(readForgeCatalog(vfs, profile, hostPackages).retired).toHaveLength(1)
  const failed = assemble(vfs)
  failed.active(false)
  failed.installer.finishRestore()
  expect(readForgeCatalog(vfs, profile, hostPackages).retired).toHaveLength(1)
  const next = assemble(vfs)
  next.installer.finishRestore()
  expect(readForgeCatalog(vfs, profile, hostPackages).retired).toEqual([])
  expect(vfs.existsSync(`${profile}/plugins/.forge/packages/${initial.manifest.plugin.packageId}`)).toBe(false)
  expect(next.modules.requireFrom('/dsh')('persistent-plugin')).toMatchObject({ value: 12 })
})

it('retains a complete catalog and files when unloading is interrupted after deselection', async () => {
  const vfs = new MemoryVfs()
  base(vfs)
  const first = assemble(vfs)
  const initial = plan(1)
  for (const item of initial.files) first.files.set(...item)
  await first.installer.install(initial.manifest, 'https://forge.invalid')
  first.inspect(async () => {
    const next = assemble(vfs)
    next.active(false)
    expect(next.installer.installed().plugins[0]?.status).toBe('disabled')
    expect(next.modules.requireFrom('/dsh')('persistent-plugin')).toMatchObject({ value: 11 })
  })
  first.fail()
  expect(await first.installer.remove('persisted')).toMatchObject({ status: 'activation-failed' })
  expect(readForgeCatalog(vfs, profile, hostPackages).manifests).toHaveLength(1)
})

it.each(['schema', 'generation', 'missing', 'hash', 'wrapper', 'public', 'duplicate', 'host', 'client'] as const)(
  'rejects %s corruption before boot without mutating saved files', async (kind) => {
    const vfs = new MemoryVfs()
    base(vfs)
    const first = assemble(vfs)
    const initial = plan(1)
    for (const item of initial.files) first.files.set(...item)
    await first.installer.install(initial.manifest, 'https://forge.invalid')
    const catalog = JSON.parse(vfs.readFileSync(catalogPath, 'utf8') as string) as Omit<ForgeCatalog, 'schema'> & { schema: number }
    if (kind === 'schema') catalog.schema = 99
    if (kind === 'generation') catalog.generation = 'old-generation'
    if (kind === 'duplicate') catalog.manifests.push(catalog.manifests[0]!)
    if (kind === 'host') catalog.manifests[0]!.hostPackages = { host: '2.0.0' }
    if (kind === 'client') catalog.manifests[0]!.clientPackages = { react: '99.0.0' }
    vfs.writeFileSync(catalogPath, JSON.stringify(catalog))
    const entry = `${profile}/plugins/.forge/packages/${initial.manifest.plugin.packageId}/lib/main.js`
    if (kind === 'missing') vfs.rmSync(entry)
    if (kind === 'hash') vfs.writeFileSync(entry, 'exports.changed = true')
    if (kind === 'wrapper') vfs.writeFileSync(`${profile}/node_modules/persistent-plugin/index.js`, 'exports.changed = true')
    if (kind === 'public') vfs.writeFileSync(`${profile}/node_modules/persistent-plugin/cordis.patch.yml`, '[]')
    const changes: string[] = []
    vfs.subscribe((event) => { changes.push(event.path) })
    expect(() => readForgeCatalog(vfs, profile, hostPackages)).toThrow()
    expect(changes).toEqual([])
  })
