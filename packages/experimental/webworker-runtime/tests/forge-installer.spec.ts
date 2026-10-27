/** Artifact verification, scoped package loading and VFS-visible update batches. */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { lowerModuleSource } from '../src/compile/transform.ts'
import { ForgeInstaller } from '../src/forge/installer.ts'
import { FORGE_GENERATION, type ForgeManifest, type ForgePackageExports } from '../src/forge/protocol.ts'
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
        { id: codeHash, name: `plugin-${id}`, version: '1.0.0', entry: 'index.js', dependencies: { helper: helperHash }, hostDependencies: [], files: [{ path: 'index.js', sha256: codeHash, size: Buffer.byteLength(source), objectKey: `${FORGE_GENERATION}/objects/${codeHash}` }] },
        { id: helperHash, name: 'helper', version: '1.0.0', entry: 'index.js', dependencies: {}, hostDependencies: [], files: [{ path: 'index.js', sha256: helperHash, size: Buffer.byteLength(helper), objectKey: `${FORGE_GENERATION}/objects/${helperHash}` }] },
      ] },
    files: new Map([[codeHash, source], [helperHash, helper]]),
  }
}

function fixture(clientPackages?: Readonly<Record<string, string>>) {
  const vfs = new MemoryVfs()
  vfs.seed('/dsh/home/profiles/web/cordis.patch.yml', '- id: unrelated\n  disabled: !!js process.env.FLAG\n')
  vfs.seed('/dsh/node_modules/host-lib/package.json', JSON.stringify({ name: 'host-lib', version: '1.0.0', main: 'index.js' }))
  vfs.seed('/dsh/node_modules/host-lib/index.js', 'exports.shared = {}')
  const modules = new WorkerModuleLoader({ vfs, staticModules: {
    'node:fs': () => ({ readFileSync: (path: URL, encoding: 'utf8') => vfs.readFileSync(fileURLToPath(path), encoding) }),
  } })
  const artifacts = new Map<string, string>()
  const writes: string[] = []
  vfs.subscribe((event) => { writes.push(event.path) })
  const calls: string[] = []
  let fail = false
  const warnings: string[] = []
  const required: (readonly string[])[] = []
  let active = true
  let disabled = false
  let activeOverride: boolean | undefined
  let inspect: () => void = () => {}
  const entryStates = new Map<string, { active?: boolean; disabled?: boolean }>()
  const installer = new ForgeInstaller({ vfs, modules, isEntryActive: id => entryStates.get(id)?.active ?? activeOverride ?? active, isEntryDisabled: id => entryStates.get(id)?.disabled ?? disabled, profileDirectory: '/dsh/home/profiles/web', ...clientPackages === undefined ? {} : { clientPackages }, hostPackages: { 'host-lib': '1.0.0' },
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
    setEntry: (id: string, state: { active?: boolean; disabled?: boolean }): void => { entryStates.set(id, state) },
    setDisabled: (value: boolean): void => { disabled = value },
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

it('rejects the preceding frontend generation before downloading or writing', async () => {
  const f = fixture()
  const { manifest } = plan()
  manifest.generation = 'dsh-worker-rc2-7'
  for (const pkg of manifest.packages) {
    for (const file of pkg.files) file.objectKey = `dsh-worker-rc2-7/objects/${file.sha256}`
  }
  expect(f.installer.target().generation).toBe('dsh-worker-rc2-8')
  await expect(f.installer.install(manifest, 'http://forge.local')).rejects.toMatchObject({ code: 'generation-mismatch' })
  expect(f.calls).toEqual([])
  expect(f.writes).toEqual([])
  expect(f.installer.installed().plugins).toEqual([])
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


it('preserves published bundle configuration and original patch bytes for native composition', async () => {
  const f = fixture()
  const patch = '- insert:\n  - id: native-one\n    name: plugin-one\n    # package defaults\n    config:\n      enabled: true\n      nested: { choices: [1, null, "value"], label: 你好 }\n'
  const first = publishedPlan('exports.value = 1', patch)
  for (const pair of first.files) f.artifacts.set(...pair)
  f.onReconcile(() => {
    expect(f.vfs.readFileSync('/dsh/home/profiles/web/node_modules/plugin-one/cordis.patch.yml', 'utf8')).toBe(patch)
  })
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
  expect(f.required).toEqual([['native-one']])
  const immutable = `/dsh/home/profiles/web/plugins/.forge/packages/${first.manifest.plugin.packageId}/cordis.patch.yml`
  expect(f.vfs.readFileSync(immutable, 'utf8')).toBe(patch)
})

it.each([
  ['config: { limit: .inf }', 'finite numbers'],
  ['config: { limit: .nan }', 'finite numbers'],
  ['config: { value: !!js process.exit() }', 'unsupported tags'],
  ['config: !!js ({})', 'unsupported tags'],
  ['config: { value: !custom data }', 'unsupported tags'],
  ['config: { original: &value [1], copy: *value }', 'YAML aliases'],
  ['config: { 1: value }', 'object keys must be strings'],
  ['disabled: true', 'field disabled is not supported'],
  ['group: []', 'field group is not supported'],
  ['inject: []', 'field inject is not supported'],
  ['isolate: true', 'field isolate is not supported'],
])('rejects unsupported bundle option %s before any write', async (option, message) => {
  const f = fixture()
  const patch = `- insert:\n  - id: native-one\n    name: plugin-one\n    ${option}\n`
  const first = publishedPlan('exports.value = 1', patch)
  for (const pair of first.files) f.artifacts.set(...pair)
  const operation = f.installer.install(first.manifest, 'http://forge.local')
  await expect(operation).rejects.toMatchObject({ code: 'unsupported-bundle' })
  await expect(operation).rejects.toThrow(message)
  expect(f.writes).toEqual([])
  expect(f.required).toEqual([])
  expect(f.installer.installed().plugins).toEqual([])
})

it.each([
  '- insert: []\n',
  '- insert: [{id: native-one, name: plugin-one}, {id: native-one, name: plugin-one}]\n',
  '- insert: [{id: native-one, name: plugin-one}]\n- insert: [{id: native-one, name: plugin-one}]\n',
  '- insert: [{id: native-one, name: plugin-one}]\n  remove: other\n',
])('rejects empty or duplicate bundle entries and unsupported operations before any write', async (patch) => {
  const f = fixture()
  const first = publishedPlan('exports.value = 1', patch)
  for (const pair of first.files) f.artifacts.set(...pair)
  await expect(f.installer.install(first.manifest, 'http://forge.local')).rejects.toMatchObject({ code: 'unsupported-bundle' })
  expect(f.writes).toEqual([])
  expect(f.required).toEqual([])
})


it.each(['[]', '[1, false, null]', 'null', '1', 'false', '"value"'])('retains literal config %s for the plugin to validate', async (config) => {
  const f = fixture()
  const patch = `- insert:\n  - id: native-one\n    name: plugin-one\n    config: ${config}\n`
  const first = publishedPlan('exports.value = 1', patch)
  for (const pair of first.files) f.artifacts.set(...pair)
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
  expect(f.vfs.readFileSync('/dsh/home/profiles/web/node_modules/plugin-one/cordis.patch.yml', 'utf8')).toBe(patch)
  expect(f.required).toEqual([['native-one']])
})


it('executes a nested published entry beside its resources and reports resource updates and removal', async () => {
  const f = fixture()
  const profile = '/dsh/home/profiles/web'
  const publicDirectory = `${profile}/node_modules/plugin-one`
  const batches: { phase: string; paths: readonly string[] }[] = []
  f.installer.subscribe((event) => { batches.push({ phase: event.phase, paths: event.paths }) })
  const resourcePlan = (entry: string, skill: string, resourceName: string) => {
    const code = lowerModuleSource({ filename: entry, source: `
      import { readFileSync } from 'node:fs'
      export const entryUrl = import.meta.url
      export const skill = readFileSync(new URL('../skills/${resourceName}', import.meta.url), 'utf8')
    ` }).code
    const result = publishedPlan(code)
    const rootPackage = result.manifest.packages[0]
    if (rootPackage === undefined) throw new Error('Root package is missing')
    const codeFile = rootPackage.files.find(file => file.path === 'index.js')
    if (codeFile === undefined) throw new Error('Entry artifact is missing')
    codeFile.path = entry
    rootPackage.id = hash(code + skill + entry)
    rootPackage.entry = entry
    rootPackage.metadata = { ...rootPackage.metadata, exports: { '.': `./${entry}`, './package.json': './package.json' } }
    rootPackage.files.push({ path: `skills/${resourceName}`, sha256: hash(skill), size: Buffer.byteLength(skill), objectKey: `${FORGE_GENERATION}/objects/${hash(skill)}` })
    result.files.set(hash(skill), skill)
    result.manifest.plugin.packageId = rootPackage.id
    result.manifest.plugin.entry = entry
    result.manifest.revision = hash(rootPackage.id)
    return result
  }
  const first = resourcePlan('lib/index.js', '# First skill', 'first.md')
  for (const pair of first.files) f.artifacts.set(...pair)
  await f.installer.install(first.manifest, 'http://forge.local')
  const immutable = `${profile}/plugins/.forge/packages/${first.manifest.plugin.packageId}`
  expect(f.modules.requireFrom(profile)('plugin-one')).toEqual({
    entryUrl: `file://${immutable}/lib/index.js`, skill: '# First skill',
  })
  expect(f.vfs.existsSync(`${publicDirectory}/lib/index.js`)).toBe(false)
  expect(f.vfs.readFileSync(`${publicDirectory}/skills/first.md`, 'utf8')).toBe('# First skill')
  expect(JSON.parse(f.vfs.readFileSync(`${immutable}/package.json`, 'utf8') as string)).toMatchObject({ main: 'lib/index.js', exports: { '.': './lib/index.js' } })
  expect(JSON.parse(f.vfs.readFileSync(`${publicDirectory}/package.json`, 'utf8') as string)).toMatchObject({ main: 'index.js', exports: { '.': './index.js' } })

  const updated = resourcePlan('dist/main.js', '# Updated skill', 'updated.md')
  for (const pair of updated.files) f.artifacts.set(...pair)
  await f.installer.install(updated.manifest, 'http://forge.local')
  // The fixture's HMR seam does not execute Loader reconciliation; expire its wrapper as the real HMR service does.
  f.modules.hmrModules.invalidate([`file://${publicDirectory}/index.js`])
  const updatedRoot = `${profile}/plugins/.forge/packages/${updated.manifest.plugin.packageId}`
  expect(f.modules.requireFrom(profile)('plugin-one')).toEqual({
    entryUrl: `file://${updatedRoot}/dist/main.js`, skill: '# Updated skill',
  })
  expect(f.vfs.existsSync(`${publicDirectory}/dist/main.js`)).toBe(false)
  expect(f.vfs.existsSync(`${publicDirectory}/skills/first.md`)).toBe(false)
  expect(f.vfs.existsSync(immutable)).toBe(false)
  expect(f.writes).toContain(`${updatedRoot}/skills/updated.md`)
  expect(f.writes).toContain(`${publicDirectory}/skills/first.md`)
  expect(batches.at(-1)?.paths).toEqual(expect.arrayContaining([
    `${updatedRoot}/skills/updated.md`, `${publicDirectory}/skills/updated.md`, `${publicDirectory}/skills/first.md`,
  ]))

  f.setActive(false)
  const beforeRemove = f.writes.length
  expect(await f.installer.remove('one')).toMatchObject({ status: 'removed' })
  expect(f.vfs.existsSync(updatedRoot)).toBe(false)
  expect(f.vfs.existsSync(publicDirectory)).toBe(false)
  expect(f.writes.slice(beforeRemove)).toEqual(expect.arrayContaining([updatedRoot, publicDirectory]))
  expect(batches.at(-1)?.paths).toEqual(expect.arrayContaining([updatedRoot, publicDirectory]))
})


it.each(['true', 'false', 'null'])('preserves native root overrides with disabled=%s beside the single self insert', async (disabled) => {
  const f = fixture()
  const patch = `- id: compaction-basic\n  disabled: ${disabled}\n- insert:\n  - id: native-one\n    name: plugin-one\n    config: { mode: extended }\n- id: agent-preset\n  config: { options: [1, null, false] }\n`
  const first = publishedPlan('exports.value = 1', patch)
  for (const pair of first.files) f.artifacts.set(...pair)
  f.onReconcile(() => {
    expect(f.vfs.readFileSync('/dsh/home/profiles/web/node_modules/plugin-one/cordis.patch.yml', 'utf8')).toBe(patch)
  })
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
  expect(f.required).toEqual([['native-one']])
  const immutable = `/dsh/home/profiles/web/plugins/.forge/packages/${first.manifest.plugin.packageId}/cordis.patch.yml`
  expect(f.vfs.readFileSync(immutable, 'utf8')).toBe(patch)
  expect(f.vfs.readFileSync('/dsh/home/profiles/web/cordis.patch.yml', 'utf8')).not.toContain('compaction-basic')
})

it.each([
  ['- id: base\n', 'must set config or disabled'],
  ['- id: base\n  name: replacement\n  config: {}\n', 'override field name is not supported'],
  ['- id: base\n  group: []\n', 'override field group is not supported'],
  ['- id: base\n  remove: true\n', 'override field remove is not supported'],
  ['- id: base\n  inject: []\n', 'override field inject is not supported'],
  ['- id: base\n  disabled: "true"\n', 'disabled must be a literal boolean or null'],
  ['- id: base\n  disabled: 1\n', 'disabled must be a literal boolean or null'],
  ['- id: base\n  disabled: {}\n', 'disabled must be a literal boolean or null'],
  ['- id: base\n  config: { value: .inf }\n', 'finite numbers'],
  ['- id: base\n  config: !!js ({})\n', 'unsupported tags'],
  ['- id: base\n  disabled: !!js true\n', 'unsupported tags'],
  ['- id: base\n  config: { original: &value [], copy: *value }\n', 'YAML aliases'],
  ['- id: base\n  disabled: true\n- id: base\n  config: null\n', 'override id base is duplicated'],
  ['- id: native-one\n  disabled: true\n', 'cannot override its own inserted entry'],
])('rejects invalid root override before writes: %s', async (override, message) => {
  const f = fixture()
  const first = publishedPlan('exports.value = 1', `${override}- insert:\n  - id: native-one\n    name: plugin-one\n`)
  for (const pair of first.files) f.artifacts.set(...pair)
  const operation = f.installer.install(first.manifest, 'http://forge.local')
  await expect(operation).rejects.toMatchObject({ code: 'unsupported-bundle' })
  await expect(operation).rejects.toThrow(message)
  expect(f.writes).toEqual([])
  expect(f.required).toEqual([])
  expect(f.installer.installed().plugins).toEqual([])
})

it('rejects override-only patches without the plugin insertion before writes', async () => {
  const f = fixture()
  const first = publishedPlan('exports.value = 1', '- id: base\n  disabled: true\n')
  for (const pair of first.files) f.artifacts.set(...pair)
  await expect(f.installer.install(first.manifest, 'http://forge.local')).rejects.toThrow('must contain at least one package insert entry')
  expect(f.writes).toEqual([])
})


it('reports native override disablement without treating an enabled but inactive entry as disabled', async () => {
  const f = fixture()
  const first = publishedPlan()
  for (const pair of first.files) f.artifacts.set(...pair)
  await f.installer.install(first.manifest, 'http://forge.local')
  f.setDisabled(true)
  f.setActive(false)
  expect(f.installer.installed().plugins[0]?.status).toBe('disabled')
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ status: 'disabled' })
  expect(f.required.at(-1)).toEqual(['native-one'])
  expect(JSON.parse(f.vfs.readFileSync('/dsh/home/profiles/web/package.json', 'utf8') as string)).toMatchObject({
    dsh: { profile: { bundles: ['plugin-one'] } },
  })
  f.setDisabled(false)
  expect(f.installer.installed().plugins[0]?.status).toBe('activation-failed')
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({
    status: 'activation-failed', message: 'The selected plugin is not active',
  })
})

it('rejects native disablement that leaves an active entry running', async () => {
  const f = fixture()
  const first = publishedPlan()
  for (const pair of first.files) f.artifacts.set(...pair)
  f.setDisabled(true)
  f.setActive(true)
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({
    status: 'activation-failed', message: 'The disabled plugin is still active',
  })
})

function privateHostPlan(id: string, version: number): ReturnType<typeof plan> {
  const source = lowerModuleSource({ filename: 'index.js', source: `
    import lib from 'host-lib';
    export const esm = lib;
    export const cjs = require('host-lib');
    export const host = require('host-consumer').shared;
    export const read = () => require('host-lib').version;
    // ${id}:${version}
  ` }).code
  const result = plan(id, source, `exports.version = ${version}; exports.self = () => require('host-lib')`)
  const root = result.manifest.packages[0]!
  const dependency = result.manifest.packages[1]!
  dependency.name = 'host-lib'
  dependency.version = `${version}.0.0`
  root.dependencies = { 'host-lib': dependency.id }
  const consumer = 'exports.shared = require("host-lib").shared'
  const consumerId = hash(consumer)
  result.files.set(consumerId, consumer)
  root.dependencies['host-consumer'] = consumerId
  result.manifest.packages.push({ id: consumerId, name: 'host-consumer', version: '1.0.0', entry: 'index.js', dependencies: {}, hostDependencies: ['host-lib'],
    files: [{ path: 'index.js', sha256: consumerId, size: Buffer.byteLength(consumer), objectKey: `${FORGE_GENERATION}/objects/${consumerId}` }] })
  result.manifest.hostPackages = { 'host-lib': '1.0.0' }
  return result
}

interface PrivateHostExports {
  esm: { version: number; self(): unknown }
  cjs: unknown
  host: unknown
  read(): number
}
function privateHostExports(f: ReturnType<typeof fixture>, manifest: ForgeManifest): PrivateHostExports {
  return f.modules.requireFrom(`/dsh/home/profiles/web/plugins/.forge/packages/${manifest.plugin.packageId}`)('./index.js') as PrivateHostExports
}

it('keeps host, two private versions, CJS/ESM identities and self references separate through update and removal', async () => {
  const f = fixture()
  const batches: string[] = []
  f.installer.subscribe((event) => { batches.push(...event.paths) })
  const hostPath = '/dsh/node_modules/host-lib/index.js'
  const hostBytes = f.vfs.readFileSync(hostPath, 'utf8')
  const host = f.modules.requireFrom('/dsh')('host-lib') as { shared: unknown }
  const first = privateHostPlan('one', 2)
  const other = privateHostPlan('two', 3)
  for (const entry of [first, other]) {
    for (const pair of entry.files) f.artifacts.set(...pair)
    expect(await f.installer.install(entry.manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
  }
  const one = privateHostExports(f, first.manifest)
  const two = privateHostExports(f, other.manifest)
  expect(one.esm).toBe(one.cjs)
  expect(two.esm).toBe(two.cjs)
  expect(one.esm).not.toBe(two.esm)
  expect(one.esm.self()).toBe(one.esm)
  expect(two.esm.self()).toBe(two.esm)
  expect([one.read(), two.read()]).toEqual([2, 3])
  expect(one.host).toBe(host.shared)
  expect(two.host).toBe(host.shared)
  const next = privateHostPlan('one', 4)
  for (const pair of next.files) f.artifacts.set(...pair)
  await f.installer.install(next.manifest, 'http://forge.local')
  expect(privateHostExports(f, next.manifest).read()).toBe(4)
  expect(two.read()).toBe(3)
  expect(await f.installer.remove('one')).toMatchObject({ status: 'removed' })
  expect(two.read()).toBe(3)
  expect(f.modules.requireFrom('/dsh')('host-lib')).toBe(host)
  expect(f.vfs.readFileSync(hostPath, 'utf8')).toEqual(hostBytes)
  expect(f.writes.some(path => path.startsWith('/dsh/node_modules/'))).toBe(false)
  const collected = `/dsh/home/profiles/web/plugins/.forge/packages/${next.manifest.packages[1]!.id}/index.js`
  expect(f.vfs.existsSync(collected)).toBe(false)
  expect(f.writes).toContain(collected)
  expect(batches).toContain(collected)
})

it('retains the old private version for deferred requires when an update fails activation', async () => {
  const f = fixture()
  const first = privateHostPlan('one', 2)
  const next = privateHostPlan('one', 3)
  for (const entry of [first, next]) for (const pair of entry.files) f.artifacts.set(...pair)
  await f.installer.install(first.manifest, 'http://forge.local')
  const old = privateHostExports(f, first.manifest)
  f.fail()
  expect(await f.installer.install(next.manifest, 'http://forge.local')).toMatchObject({ status: 'activation-failed' })
  expect(old.read()).toBe(2)
  expect(old.esm.self()).toBe(old.esm)
  expect(privateHostExports(f, next.manifest).read()).toBe(3)
  expect(f.vfs.existsSync(`/dsh/home/profiles/web/plugins/.forge/packages/${first.manifest.packages[1]!.id}/index.js`)).toBe(true)
})

it.each(['@deepseek-ai/dsh-core', '@deepseek-ai/cordis', 'react', 'fs', 'process', 'got', '@deepseek-ai/node-addon-system'])(
  'refuses private copies of shared %s before download or writes', async (name) => {
    const f = fixture({ react: '19.0.0' })
    const { manifest } = plan()
    manifest.packages[1]!.name = name
    manifest.packages[0]!.dependencies = { [name]: manifest.packages[1]!.id }
    await expect(f.installer.install({ ...manifest, sharedPackages: [] }, 'http://forge.local')).rejects.toMatchObject({ code: 'core-package' })
    expect(f.calls).toEqual([])
    expect(f.writes).toEqual([])
  },
)

it('refuses an ordinary host library as the root plugin without changing global package aliases', async () => {
  const f = fixture()
  const { manifest } = plan()
  manifest.plugin.name = 'host-lib'
  manifest.packages[0]!.name = 'host-lib'
  await expect(f.installer.install(manifest, 'http://forge.local')).rejects.toMatchObject({ code: 'core-package' })
  expect(f.calls).toEqual([])
  expect(f.writes).toEqual([])
  expect(f.modules.requireFrom('/dsh')('host-lib')).toEqual({ shared: {} })
})

it('retains conditional and patterned exports, independent modules and a nested package manifest', async () => {
  const f = fixture()
  const result = plan('files', 'exports.read = name => require(name)')
  const pkg = result.manifest.packages[0]!
  const add = (path: string, source: string): void => {
    const sha256 = hash(source)
    result.files.set(sha256, source)
    pkg.files.push({ path, sha256, size: Buffer.byteLength(source), objectKey: `${FORGE_GENERATION}/objects/${sha256}` })
  }
  add('parts/value.cts', 'module.exports = { value: 8 }')
  add('folder/package.json', '{"main":"../parts/value.cts"}')
  pkg.metadata = { exports: {
    '.': [{ types: './types/omitted.d.ts', browser: './index.js' }, './index.js'],
    './parts/*': './parts/*.cts', './blocked': null,
  } }
  for (const pair of result.files) f.artifacts.set(...pair)
  expect(await f.installer.install(result.manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
  const immutable = `/dsh/home/profiles/web/plugins/.forge/packages/${pkg.id}`
  const require = f.modules.requireFrom(immutable)
  const plugin = require('./index.js') as { read(name: string): unknown }
  expect(plugin.read('./folder')).toEqual({ value: 8 })
  expect(plugin.read('plugin-files/parts/value')).toBe(plugin.read('./parts/value.cts'))
  expect(() => plugin.read('plugin-files/blocked')).toThrow(expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }))
  expect(JSON.parse(f.vfs.readFileSync(`${immutable}/package.json`, 'utf8') as string)).toMatchObject({ exports: pkg.metadata.exports })
  expect(f.vfs.readFileSync('/dsh/home/profiles/web/node_modules/plugin-files/index.js', 'utf8')).toContain(immutable)
  expect(f.vfs.readFileSync(`${immutable}/index.js`, 'utf8')).toBe('exports.read = name => require(name)')
})

it.each<ForgePackageExports>(['./../outside.js', './node_modules/other/index.js', '/absolute.js', { './feature': './safe.js', browser: './browser.js' }])(
  'rejects unsafe export metadata %j before file writes', async (exports) => {
    const f = fixture()
    const { manifest } = plan()
    manifest.packages[0]!.metadata = { exports }
    await expect(f.installer.install(manifest, 'http://forge.local')).rejects.toThrow()
    expect(f.calls).toEqual([])
    expect(f.writes).toEqual([])
  },
)

it.each<ForgePackageExports>(['./index.js', [{ browser: './index.js' }, null], { browser: './index.js', default: './index.js' }])(
  'keeps the public root wrapper for shorthand exports %j', async (exports) => {
    const f = fixture()
    const { manifest, files } = plan('short', 'exports.value = 8')
    manifest.packages[0]!.metadata = { exports }
    for (const pair of files) f.artifacts.set(...pair)
    expect(await f.installer.install(manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
    expect(f.modules.requireFrom('/dsh')('plugin-short')).toEqual({ value: 8 })
    expect(JSON.parse(f.vfs.readFileSync('/dsh/home/profiles/web/node_modules/plugin-short/package.json', 'utf8') as string))
      .toMatchObject({ exports: { '.': './index.js' } })
  },
)

it('grants host packages only to their declaring package, including public subpaths', async () => {
  const f = fixture()
  const result = plan('scoped', 'exports.read = name => require(name)', 'exports.read = () => require("host-lib")')
  result.manifest.hostPackages = { 'host-lib': '1.0.0' }
  result.manifest.packages[1]!.hostDependencies = ['host-lib']
  const root = result.manifest.packages[0]!
  root.metadata = { exports: { '.': './index.js', './entry': './index.js' } }
  for (const pair of result.files) f.artifacts.set(...pair)
  await f.installer.install(result.manifest, 'http://forge.local')
  const require = f.modules.requireFrom('/dsh')
  const plugin = require('plugin-scoped') as { read(name: string): unknown }
  const helper = plugin.read('helper') as { read(): unknown }
  expect(helper.read()).toBe(require('host-lib'))
  expect(() => plugin.read('host-lib')).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }))
  expect(require('plugin-scoped/entry')).toBe(plugin)
  expect(require.resolve('plugin-scoped/entry')).toContain(`/plugins/.forge/packages/${root.id}/index.js`)
})

it('redirects Host subpaths to the immutable package while keeping Client files public', async () => {
  const f = fixture()
  const result = plan('subpath', 'exports.value = {}')
  const root = result.manifest.packages[0]!
  root.entry = 'lib/main.cjs'
  root.files[0]!.path = root.entry
  result.manifest.plugin.entry = root.entry
  const child = 'module.exports = require("./main.cjs")'
  const client = 'window.__ModuleLoader__.load({})'
  for (const [path, source] of [['lib/child.cjs', child], ['client.js', client], ['data.json', '{"value":9}']] as const) {
    const sha256 = hash(source)
    result.files.set(sha256, source)
    root.files.push({ path, sha256, size: Buffer.byteLength(source), objectKey: `${FORGE_GENERATION}/objects/${sha256}` })
  }
  root.metadata = { exports: { '.': './lib/main.cjs', './entry': './lib/main.cjs', './child': './lib/child.cjs', './client': './client.js', './data': './data.json' },
    dsh: { client: { inject: [], platform: 'web' } } }
  for (const pair of result.files) f.artifacts.set(...pair)
  await f.installer.install(result.manifest, 'http://forge.local')
  const require = f.modules.requireFrom('/dsh')
  expect(require('plugin-subpath/entry')).toBe(require('plugin-subpath'))
  expect(require('plugin-subpath/child')).toBe(require('plugin-subpath'))
  const implementation = f.modules.requireFrom(`/dsh/home/profiles/web/plugins/.forge/packages/${root.id}`)
  expect(implementation('plugin-subpath/child')).toBe(require('plugin-subpath/child'))
  expect(implementation('./data.json')).toBe(require('plugin-subpath/data'))
  expect(f.vfs.readFileSync('/dsh/home/profiles/web/node_modules/plugin-subpath/client.js', 'utf8')).toBe(client)
  const publicChild = f.modules.requireFrom('/dsh/home/profiles/web/node_modules/plugin-subpath')
  expect(() => publicChild('host-lib')).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }))
})

it.each(['missing', 'duplicate', 'undeclared', 'private-conflict'] as const)('rejects invalid per-package host grant %s before writes', async (kind) => {
  const f = fixture()
  const { manifest } = plan()
  const root = manifest.packages[0]!
  if (kind === 'duplicate') { manifest.hostPackages = { 'host-lib': '1.0.0' }; root.hostDependencies = ['host-lib', 'host-lib'] }
  if (kind === 'undeclared') root.hostDependencies = ['host-lib']
  if (kind === 'private-conflict') {
    manifest.hostPackages = { 'host-lib': '1.0.0' }
    root.hostDependencies = ['host-lib']
    root.dependencies['host-lib'] = manifest.packages[1]!.id
  }
  const value = kind === 'missing' ? { ...manifest, packages: manifest.packages.map(({ hostDependencies: _omitted, ...pkg }) => pkg) } : manifest
  await expect(f.installer.install(value, 'http://forge.local')).rejects.toMatchObject({ code: 'invalid-manifest' })
  expect(f.calls).toEqual([])
  expect(f.writes).toEqual([])
})

const multiPatch = '- insert:\n  - {id: knowledge, name: plugin-one/knowledge, config: {embeddingProvider: none}}\n  - {id: tool-knowledge, name: plugin-one/tool-knowledge}\n- insert: [{id: ui-knowledge, name: plugin-one}]\n'

it('requires every bundle entry and preserves native selection through updates and removal', async () => {
  const f = fixture()
  const first = publishedPlan('exports.value = 1', multiPatch)
  for (const pair of first.files) f.artifacts.set(...pair)
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
  expect(f.required.at(-1)).toEqual(['knowledge', 'tool-knowledge', 'ui-knowledge'])
  f.setEntry('knowledge', { active: false })
  expect(f.installer.installed().plugins[0]?.status).toBe('activation-failed')
  f.setEntry('knowledge', { active: true })
  const second = publishedPlan('exports.value = 2', multiPatch)
  for (const pair of second.files) f.artifacts.set(...pair)
  expect(await f.installer.install(second.manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
  expect(f.vfs.readFileSync('/dsh/home/profiles/web/node_modules/plugin-one/cordis.patch.yml', 'utf8')).toBe(multiPatch)
  nativeSelection(f, [])
  f.setActive(false)
  f.setEntry('knowledge', { active: false })
  expect(await f.installer.install(second.manifest, 'http://forge.local')).toMatchObject({ status: 'disabled' })
  expect(f.required.at(-1)).toEqual([])
  expect(await f.installer.remove('one')).toMatchObject({ status: 'removed' })
  expect(f.vfs.existsSync('/dsh/home/profiles/web/node_modules/plugin-one')).toBe(false)
})

it('reports an inactive secondary entry as failure instead of accepting the active root', async () => {
  const f = fixture()
  const first = publishedPlan('exports.value = 1', multiPatch)
  for (const pair of first.files) f.artifacts.set(...pair)
  f.setEntry('tool-knowledge', { active: false })
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ status: 'activation-failed' })
  expect(f.installer.installed().plugins[0]?.status).toBe('activation-failed')
  expect(f.vfs.existsSync('/dsh/home/profiles/web/node_modules/plugin-one')).toBe(true)
  f.setEntry('tool-knowledge', { active: true })
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
})

it('allows disabled bundle members while verifying each enabled member', async () => {
  const f = fixture()
  const first = publishedPlan('exports.value = 1', multiPatch)
  for (const pair of first.files) f.artifacts.set(...pair)
  f.setEntry('knowledge', { active: false, disabled: true })
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
  f.setEntry('tool-knowledge', { active: false, disabled: true })
  f.setEntry('ui-knowledge', { active: false, disabled: true })
  expect(f.installer.installed().plugins[0]?.status).toBe('disabled')
  expect(await f.installer.install(first.manifest, 'http://forge.local')).toMatchObject({ status: 'disabled' })
  f.setEntry('knowledge', { active: true, disabled: true })
  expect(f.installer.installed().plugins[0]?.status).toBe('activation-failed')
})

it('retains package files when one removed member remains active', async () => {
  const f = fixture()
  const first = publishedPlan('exports.value = 1', multiPatch)
  for (const pair of first.files) f.artifacts.set(...pair)
  await f.installer.install(first.manifest, 'http://forge.local')
  f.setEntry('tool-knowledge', { active: true })
  expect(await f.installer.remove('one')).toMatchObject({ status: 'activation-failed', message: 'The removed plugin is still active' })
  expect(f.vfs.existsSync('/dsh/home/profiles/web/node_modules/plugin-one')).toBe(true)
  f.setEntry('tool-knowledge', { active: false })
  expect(await f.installer.remove('one')).toMatchObject({ status: 'removed' })
})

it('retains previous artifacts when a replaced member remains active', async () => {
  const f = fixture()
  const first = publishedPlan('exports.value = 1', multiPatch)
  for (const pair of first.files) f.artifacts.set(...pair)
  await f.installer.install(first.manifest, 'http://forge.local')
  const second = publishedPlan('exports.value = 2', multiPatch.replace('tool-knowledge', 'new-tools'))
  for (const pair of second.files) f.artifacts.set(...pair)
  f.setEntry('tool-knowledge', { active: true })
  expect(await f.installer.install(second.manifest, 'http://forge.local')).toMatchObject({ status: 'activation-failed', message: 'A replaced plugin entry is still active' })
  const previous = `/dsh/home/profiles/web/plugins/.forge/packages/${first.manifest.plugin.packageId}`
  expect(f.vfs.existsSync(previous)).toBe(true)
  f.setEntry('tool-knowledge', { active: false })
  expect(await f.installer.install(second.manifest, 'http://forge.local')).toMatchObject({ status: 'active' })
  expect(f.vfs.existsSync(previous)).toBe(false)
})

it.each(['plugin-one-other', 'other/subpath', 'plugin-one/', 'plugin-one/../escape', 'plugin-one/./part', 'plugin-one/node_modules/other', 'plugin-one/a//b', 'plugin-one/a?b', 'plugin-one/a%2fb'])(
  'rejects a foreign or unsafe bundle module %s before writing files', async (name) => {
    const f = fixture()
    const first = publishedPlan('exports.value = 1', `- insert: [{id: entry, name: "${name}"}]`)
    for (const pair of first.files) f.artifacts.set(...pair)
    await expect(f.installer.install(first.manifest, 'http://forge.local')).rejects.toMatchObject({ code: 'unsupported-bundle' })
    expect(f.writes).toEqual([])
  },
)
