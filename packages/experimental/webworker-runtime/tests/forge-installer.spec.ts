/** Artifact verification, scoped package loading and VFS-visible update batches. */
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { ForgeInstaller } from '../src/forge/installer.ts'
import { FORGE_GENERATION, type ForgeManifest } from '../src/forge/protocol.ts'
import { editForgeProfilePatch } from '../src/forge/profile-patch.ts'
import { MemoryVfs } from '../src/storage/memory.ts'
import { WorkerModuleLoader } from '../src/module-system/module-loader.ts'

function hash(source: string): string { return createHash('sha256').update(source).digest('hex') }
function plan(id = 'one', source = 'exports.value = require("helper").value', helper = 'exports.value = 1'): { manifest: ForgeManifest; files: Map<string, string> } {
  const codeHash = hash(source)
  const helperHash = hash(helper)
  return {
    manifest: { protocol: 1, generation: FORGE_GENERATION, revision: hash(id + source + helper),
      plugin: { id, name: `plugin-${id}`, version: '1.0.0', packageId: codeHash, entry: 'index.js' }, hostPackages: {},
      packages: [
        { id: codeHash, name: `plugin-${id}`, version: '1.0.0', entry: 'index.js', dependencies: { helper: helperHash }, files: [{ path: 'index.js', sha256: codeHash, size: Buffer.byteLength(source), objectKey: `${FORGE_GENERATION}/objects/${codeHash}` }] },
        { id: helperHash, name: 'helper', version: '1.0.0', entry: 'index.js', dependencies: {}, files: [{ path: 'index.js', sha256: helperHash, size: Buffer.byteLength(helper), objectKey: `${FORGE_GENERATION}/objects/${helperHash}` }] },
      ] },
    files: new Map([[codeHash, source], [helperHash, helper]]),
  }
}

function fixture(clientPackages?: Readonly<Record<string, string>>) {
  const vfs = new MemoryVfs()
  vfs.seed('/dsh/home/profiles/web/cordis.patch.yml', '- id: unrelated\n  disabled: !!js process.env.FLAG\n')
  vfs.seed('/dsh/node_modules/host-lib/package.json', JSON.stringify({ name: 'host-lib', version: '1.0.0', main: 'index.js' }))
  vfs.seed('/dsh/node_modules/host-lib/index.js', 'exports.shared = {}')
  const modules = new WorkerModuleLoader({ vfs, staticModules: {} })
  const artifacts = new Map<string, string>()
  const writes: string[] = []
  vfs.subscribe((event) => { writes.push(event.path) })
  const calls: string[] = []
  let fail = false
  const warnings: string[] = []
  const required: (readonly string[])[] = []
  let active = true
  let activeOverride: boolean | undefined
  let inspect: () => void = () => {}
  const installer = new ForgeInstaller({ vfs, modules, isEntryActive: () => activeOverride ?? active, profileDirectory: '/dsh/home/profiles/web', ...clientPackages === undefined ? {} : { clientPackages }, hostPackages: { 'host-lib': '1.0.0' },
    hmr: { runExclusive: async operation => operation(), reconcileProfile: async (ids?: readonly string[]) => {
      required.push(ids ?? [])
      inspect()
      if (fail) throw new Error('plugin rejected activation')
      active = ids !== undefined && ids.length > 0
      return { pending: [], warnings }
    } }, editPatch: editForgeProfilePatch,
    fetch: async (input) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      calls.push(url)
      const value = artifacts.get(url.split('/').at(-1) ?? '')
      return value === undefined ? new Response('missing', { status: 404 }) : new Response(value)
    },
  })
  return { vfs, modules, installer, artifacts, writes, calls, warnings, required,
    setActive: (value: boolean): void => { activeOverride = value },
    onReconcile: (callback: () => void): void => { inspect = callback },
    fail: (): void => { fail = true }, recover: (): void => { fail = false } }
}

it('downloads packages independently, reuses unchanged files, records mutations and removes registration before collection', async () => {
  const f = fixture()
  const first = plan()
  for (const pair of first.files) f.artifacts.set(...pair)
  const phases: string[] = []
  f.installer.subscribe((event) => { phases.push(event.phase) })
  const result = await f.installer.install(first.manifest, 'http://forge.local')
  expect(result).toMatchObject({ status: 'active', downloadedFiles: 2 })
  const path = `/dsh/home/profiles/web/plugins/.forge/packages/${first.manifest.plugin.packageId}/index.js`
  expect(f.modules.createRequire(path)('./index.js')).toEqual({ value: 1 })
  expect(f.vfs.readFileSync('/dsh/home/profiles/web/cordis.patch.yml', 'utf8')).toContain('!!js process.env.FLAG')
  expect(phases).toEqual(['begin', 'files-applied', 'activation'])
  const writeCount = f.writes.length
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ downloadedFiles: 0, writtenFiles: 0 })
  expect(f.writes).toHaveLength(writeCount)
  expect(await f.installer.remove('one')).toMatchObject({ status: 'removed' })
  expect(f.vfs.existsSync(path)).toBe(false)
  expect(f.installer.installed().plugins).toEqual([])
  expect(f.modules.hmrModules.records()).toEqual([])
})

it('resolves two versions by importer and retains a dependency used by another installed plugin', async () => {
  const f = fixture()
  const one = plan('one', 'exports.value = require("helper").value')
  const two = plan('two', 'exports.value = require("helper").value + 1')
  for (const pair of [...one.files, ...two.files]) f.artifacts.set(...pair)
  await f.installer.install(one.manifest, 'http://forge.local')
  expect(await f.installer.install(two.manifest, 'http://forge.local')).toMatchObject({ downloadedFiles: 1 })
  await f.installer.remove('one')
  const path = `/dsh/home/profiles/web/plugins/.forge/packages/${two.manifest.plugin.packageId}/index.js`
  expect(f.modules.createRequire(path)('./index.js')).toEqual({ value: 2 })
  const three = plan('three', 'exports.value = require("helper").value + 2', 'exports.value = 10')
  for (const pair of three.files) f.artifacts.set(...pair)
  await f.installer.install(three.manifest, 'http://forge.local')
  expect(f.modules.createRequire(`/dsh/home/profiles/web/plugins/.forge/packages/${three.manifest.plugin.packageId}/index.js`)('./index.js')).toEqual({ value: 12 })
  expect(f.modules.createRequire(path)('./index.js')).toEqual({ value: 2 })
})

it.each(['generation', 'host', 'path', 'hash', 'reference', 'core', 'object-key'] as const)('rejects %s failures without writes or registrations', async (kind) => {
  const f = fixture()
  const { manifest, files } = plan()
  for (const pair of files) f.artifacts.set(...pair)
  const file = manifest.packages[0]!.files[0]!
  if (kind === 'generation') manifest.generation = 'future'
  if (kind === 'host') manifest.hostPackages['host-lib'] = '2.0.0'
  if (kind === 'path') file.path = '../escape.js'
  if (kind === 'hash') f.artifacts.set(file.sha256, 'corrupt')
  if (kind === 'reference') manifest.packages[0]!.dependencies.helper = 'missing'
  if (kind === 'core') manifest.packages[0]!.name = 'host-lib'
  if (kind === 'object-key') file.objectKey = '../secret'
  await expect(f.installer.install(manifest, 'http://forge.local')).rejects.toThrow()
  expect(f.writes).toEqual([])
  expect(f.installer.installed().plugins).toEqual([])
})

it('reports failed activation and observer failures without claiming persistence or rollback', async () => {
  const f = fixture()
  const { manifest, files } = plan()
  for (const pair of files) f.artifacts.set(...pair)
  f.fail()
  f.installer.subscribe(() => { throw new Error('storage observer offline') })
  let observed = 0
  f.installer.subscribe(() => { observed++ })
  const result = await f.installer.install(manifest, 'http://forge.local')
  expect(result).toMatchObject({ status: 'activation-failed', message: 'plugin rejected activation' })
  expect(result.observerErrors).toHaveLength(3)
  expect(observed).toBe(3)
  expect(f.installer.installed().plugins[0]?.status).toBe('activation-failed')
  expect(f.writes.length).toBeGreaterThan(0)
})

it('keeps prior module dependency scopes after failed activation, then collects them on recovery', async () => {
  const f = fixture()
  const first = plan('one', 'exports.read = () => require("helper").value')
  for (const pair of first.files) f.artifacts.set(...pair)
  await f.installer.install(first.manifest, 'http://forge.local')
  const oldPath = `/dsh/home/profiles/web/plugins/.forge/packages/${first.manifest.plugin.packageId}/index.js`
  const old = f.modules.createRequire(oldPath)('./index.js') as { read(): number }
  const second = plan('one', 'exports.read = () => require("helper").value + 1', 'exports.value = 10')
  for (const pair of second.files) f.artifacts.set(...pair)
  f.fail()
  expect(await f.installer.install(second.manifest, 'http://forge.local')).toMatchObject({ status: 'activation-failed' })
  expect(old.read()).toBe(1)
  expect(f.vfs.existsSync(oldPath)).toBe(true)
  f.recover()
  expect(await f.installer.install(second.manifest, 'http://forge.local')).toMatchObject({ status: 'active', downloadedFiles: 0 })
  expect(f.vfs.existsSync(oldPath)).toBe(false)
})

it('reuses a verified local object when its package instance directory changes', async () => {
  const f = fixture()
  const first = plan()
  for (const pair of first.files) f.artifacts.set(...pair)
  await f.installer.install(first.manifest, 'http://forge.local')
  const next = structuredClone(first.manifest)
  const id = hash('new dependency environment')
  next.plugin.packageId = id
  next.packages[0]!.id = id
  next.revision = hash('new revision')
  const fetched = f.calls.length
  expect(await f.installer.install(next, 'http://forge.local')).toMatchObject({ status: 'active', downloadedFiles: 0 })
  expect(f.calls).toHaveLength(fetched)
  expect(f.vfs.readFileSync(`/dsh/home/profiles/web/plugins/.forge/packages/${id}/index.js`, 'utf8')).toBe('exports.value = require("helper").value')
})

it('refuses the CLI core package even when the base image omits it', async () => {
  const f = fixture()
  const { manifest } = plan()
  manifest.plugin.name = '@deepseek-ai/dsh'
  manifest.packages[0]!.name = '@deepseek-ai/dsh'
  await expect(f.installer.install(manifest, 'http://forge.local')).rejects.toMatchObject({ code: 'core-package' })
  expect(f.writes).toEqual([])
})

it('preserves unrelated reconciliation warnings without reporting the managed plugin inactive', async () => {
  const f = fixture()
  const { manifest, files } = plan()
  for (const pair of files) f.artifacts.set(...pair)
  f.warnings.push('unrelated plugin remains inactive')
  expect(await f.installer.install(manifest, 'http://forge.local')).toMatchObject({ status: 'active', message: 'unrelated plugin remains inactive' })
  expect(await f.installer.remove('one')).toMatchObject({ status: 'removed', message: 'unrelated plugin remains inactive' })
})

it('rejects inconsistent sizes for a deduplicated object before downloading or writing', async () => {
  const f = fixture()
  const { manifest } = plan()
  const source = manifest.packages[0]!.files[0]!
  manifest.packages[1]!.files = [{ ...source, size: source.size + 1 }]
  await expect(f.installer.install(manifest, 'http://forge.local')).rejects.toMatchObject({ code: 'invalid-manifest' })
  expect(f.calls).toEqual([])
  expect(f.writes).toEqual([])
})

it.each(['files', 'dependency'] as const)('refuses an existing package owned outside Forge: %s', async (kind) => {
  const f = fixture()
  const { manifest } = plan()
  if (kind === 'files') f.vfs.seed('/dsh/home/profiles/web/node_modules/plugin-one/package.json', '{}')
  else f.vfs.seed('/dsh/home/profiles/web/package.json', JSON.stringify({ dependencies: { 'plugin-one': '1.0.0' } }))
  await expect(f.installer.install(manifest, 'http://forge.local')).rejects.toMatchObject({ code: 'package-not-owned' })
  expect(f.writes).toEqual([])
  expect(f.calls).toEqual([])
})

it('removes obsolete published assets after successful replacement', async () => {
  const f = fixture()
  const first = plan()
  const root = first.manifest.packages[0]!
  root.files.push({ path: 'client/old.js', sha256: hash('old asset'), size: 9, objectKey: `${FORGE_GENERATION}/objects/${hash('old asset')}` })
  for (const pair of first.files) f.artifacts.set(...pair)
  f.artifacts.set(hash('old asset'), 'old asset')
  await f.installer.install(first.manifest, 'http://forge.local')
  const oldAsset = '/dsh/home/profiles/web/node_modules/plugin-one/client/old.js'
  expect(f.vfs.existsSync(oldAsset)).toBe(true)
  const next = plan('one', 'exports.value = require("helper").value + 1')
  for (const pair of next.files) f.artifacts.set(...pair)
  expect(await f.installer.install(next.manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
  expect(f.vfs.existsSync(oldAsset)).toBe(false)
})

it('declares fixed Client versions without granting Host module imports', async () => {
  const versions = { react: '18.3.1' }
  const f = fixture(versions)
  versions.react = '19.0.0'
  expect(f.installer.target().clientPackages).toEqual({ react: '18.3.1' })
  expect(f.installer.target().hostPackages).not.toHaveProperty('react')
  const { manifest, files } = plan('client', 'exports.read = () => require("react")')
  manifest.clientPackages = { react: '18.3.1' }
  for (const pair of files) f.artifacts.set(...pair)
  expect(await f.installer.install(manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
  const path = `/dsh/home/profiles/web/plugins/.forge/packages/${manifest.plugin.packageId}/index.js`
  const plugin = f.modules.createRequire(path)('./index.js') as { read(): unknown }
  expect(() => plugin.read()).toThrow('react')
  expect(f.vfs.existsSync('/dsh/node_modules/react/package.json')).toBe(false)
})

it.each(['missing', 'version', 'replace', 'host-import'])('rejects invalid Client requirement %s before download or write', async (kind) => {
  const f = fixture(kind === 'missing' ? {} : { react: '18.3.1' })
  const { manifest } = plan()
  manifest.clientPackages = { react: kind === 'version' ? '19.0.0' : '18.3.1' }
  if (kind === 'replace') manifest.packages[0]!.name = 'react'
  if (kind === 'host-import') manifest.hostPackages = { react: '18.3.1' }
  await expect(f.installer.install(manifest, 'http://forge.local')).rejects.toThrow()
  expect(f.writes).toEqual([])
  expect(f.calls).toEqual([])
  expect(f.installer.installed().plugins).toEqual([])
})

function publishedPlan(source = 'exports.value = 1', patch = '- insert:\n  - id: native-one\n    name: plugin-one\n') {
  const result = plan('one', source, 'exports.helper = true')
  const root = result.manifest.packages[0]!
  root.metadata = { dsh: { bundle: { patch: './cordis.patch.yml' } } }
  root.files.push({ path: 'cordis.patch.yml', sha256: hash(patch), size: Buffer.byteLength(patch), objectKey: `${FORGE_GENERATION}/objects/${hash(patch)}` })
  result.files.set(hash(patch), patch)
  return result
}

function nativeSelection(f: ReturnType<typeof fixture>, names: string[]) {
  const path = '/dsh/home/profiles/web/package.json'
  const value = JSON.parse(f.vfs.readFileSync(path, 'utf8') as string) as { dsh: { profile: { bundles: string[] } } }
  value.dsh.profile.bundles = names
  f.vfs.writeFileSync(path, JSON.stringify(value))
}

it('selects published bundles once through native composition and preserves profile fields', async () => {
  const f = fixture()
  f.vfs.seed('/dsh/home/profiles/web/package.json', JSON.stringify({ dependencies: { other: '2' }, dsh: { other: true, profile: { bundles: ['other'], custom: 1 } } }))
  const first = publishedPlan()
  for (const pair of first.files) f.artifacts.set(...pair)
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
  expect(f.required).toEqual([['native-one']])
  expect(f.vfs.readFileSync('/dsh/home/profiles/web/cordis.patch.yml', 'utf8')).not.toContain('forge-one')
  expect(JSON.parse(f.vfs.readFileSync('/dsh/home/profiles/web/package.json', 'utf8') as string)).toEqual({
    dependencies: { other: '2', 'plugin-one': '1.0.0' }, dsh: { other: true, profile: { bundles: ['other', 'plugin-one'], custom: 1 } },
  })
  nativeSelection(f, ['plugin-one', 'other'])
  await f.installer.install(first.manifest, 'http://forge.local')
  expect(JSON.parse(f.vfs.readFileSync('/dsh/home/profiles/web/package.json', 'utf8') as string)).toMatchObject({
    dsh: { profile: { bundles: ['plugin-one', 'other'] } },
  })
  const update = publishedPlan('exports.value = 2')
  for (const pair of update.files) f.artifacts.set(...pair)
  nativeSelection(f, ['other'])
  f.setActive(false)
  expect(f.installer.installed().plugins[0]?.status).toBe('disabled')
  expect(await f.installer.install(update.manifest, 'http://forge.local')).toMatchObject({ status: 'disabled' })
  expect(f.required.at(-1)).toEqual([])
  nativeSelection(f, ['other', 'plugin-one'])
  f.setActive(true)
  expect(f.installer.installed().plugins[0]?.status).toBe('active')
  f.setActive(false)
  expect(f.installer.installed().plugins[0]?.status).toBe('activation-failed')
})

it.each([false, true])('migrates a legacy Forge row with native selection already present=%s', async (selected) => {
  const f = fixture()
  const first = publishedPlan()
  for (const pair of first.files) f.artifacts.set(...pair)
  await f.installer.install(first.manifest, 'http://forge.local')
  nativeSelection(f, selected ? ['plugin-one'] : [])
  const path = '/dsh/home/profiles/web/cordis.patch.yml'
  f.vfs.writeFileSync(path, editForgeProfilePatch(f.vfs.readFileSync(path, 'utf8') as string, 'forge-one', 'plugin-one'))
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
  expect(f.vfs.readFileSync(path, 'utf8')).not.toContain('forge-one')
  expect(JSON.parse(f.vfs.readFileSync('/dsh/home/profiles/web/package.json', 'utf8') as string)).toMatchObject({ dsh: { profile: { bundles: ['plugin-one'] } } })
  expect(f.required.at(-1)).toEqual(['native-one'])
})

it('deselects a bundle before unloading and keeps files plus dependency when unloading fails', async () => {
  const f = fixture()
  const first = publishedPlan()
  for (const pair of first.files) f.artifacts.set(...pair)
  await f.installer.install(first.manifest, 'http://forge.local')
  f.onReconcile(() => {
    expect(JSON.parse(f.vfs.readFileSync('/dsh/home/profiles/web/package.json', 'utf8') as string)).toMatchObject({
      dependencies: { 'plugin-one': '1.0.0' }, dsh: { profile: { bundles: [] } },
    })
    expect(f.vfs.existsSync('/dsh/home/profiles/web/node_modules/plugin-one/index.js')).toBe(true)
  })
  f.fail()
  expect(await f.installer.remove('one')).toMatchObject({ status: 'activation-failed' })
  expect(f.installer.installed().plugins[0]?.status).toBe('activation-failed')
  f.recover()
  f.setActive(false)
  expect(await f.installer.remove('one')).toMatchObject({ status: 'removed' })
  expect(f.vfs.existsSync('/dsh/home/profiles/web/node_modules/plugin-one')).toBe(false)
  expect(JSON.parse(f.vfs.readFileSync('/dsh/home/profiles/web/package.json', 'utf8') as string)).toEqual({ dependencies: {}, dsh: { profile: { bundles: [] } } })
})

it('does not turn native required-entry failures or inactive entries into successful activation', async () => {
  const f = fixture()
  const first = publishedPlan()
  for (const pair of first.files) f.artifacts.set(...pair)
  f.fail()
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ status: 'activation-failed' })
  expect(f.required.at(-1)).toEqual(['native-one'])
  f.recover()
  f.setActive(false)
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ status: 'activation-failed', message: 'The selected plugin is not active' })
})

it('rejects unsupported published bundle patches before mutating any files', async () => {
  const f = fixture()
  const first = publishedPlan('exports.value = 1', '- insert:\n  - id: wrong\n    name: other-package\n')
  for (const pair of first.files) f.artifacts.set(...pair)
  await expect(f.installer.install(first.manifest, 'http://forge.local')).rejects.toThrow('Bundle entry must load its published package')
  expect(f.writes).toEqual([])
})

it('retains files and dependency if reconciliation leaves a removed bundle active', async () => {
  const f = fixture()
  const first = publishedPlan()
  for (const pair of first.files) f.artifacts.set(...pair)
  await f.installer.install(first.manifest, 'http://forge.local')
  f.setActive(true)
  expect(await f.installer.remove('one')).toMatchObject({ status: 'activation-failed', message: 'The removed plugin is still active' })
  expect(f.vfs.existsSync('/dsh/home/profiles/web/node_modules/plugin-one/index.js')).toBe(true)
  expect(JSON.parse(f.vfs.readFileSync('/dsh/home/profiles/web/package.json', 'utf8') as string)).toMatchObject({
    dependencies: { 'plugin-one': '1.0.0' }, dsh: { profile: { bundles: [] } },
  })
})
