/** Workbench actions use real VFS notifications, installer plans, retained bytes and guarded shell filesystem access. */
import { createHash } from 'node:crypto'
import { Buffer } from 'buffer'
import { expect, it, onTestFinished, type TestContext } from 'vitest'
import { createForgeHost } from '../src/forge/host.ts'
import { readForgeCatalog } from '../src/forge/catalog.ts'
import { FORGE_GENERATION, object, type ForgeManifest } from '../src/forge/protocol.ts'
import { MemoryVfs } from '../src/storage/memory.ts'
import { WorkerModuleLoader } from '../src/module-system/module-loader.ts'
import { AiwFiles } from '../src/aiw/files.ts'
import type { AiwFilesArchive } from '../src/aiw/protocol.ts'

const digest = (source: string): string => createHash('sha256').update(source).digest('hex')
function plan(version: string, id = 'sample', entry = 'index.ts'): { manifest: ForgeManifest; bytes: string } {
  const bytes = `exports.value = ${JSON.stringify(version)}; exports.apply = () => {};`
  const hash = digest(bytes)
  return { bytes, manifest: { protocol: 1, generation: FORGE_GENERATION, revision: digest(id + version),
    plugin: { id, name: id, version: '1.0.0', packageId: hash, entry }, hostPackages: {},
    packages: [{ id: hash, name: id, version: '1.0.0', entry, dependencies: {}, hostDependencies: [],
      files: [{ path: entry, sha256: hash, size: Buffer.byteLength(bytes), objectKey: `${FORGE_GENERATION}/objects/${hash}` }] }] } }
}
function fixture(test: Pick<TestContext, 'onTestFinished'>, vfs = new MemoryVfs(), restore = false) {
  if (!restore) {
    vfs.seed('/dsh/home/profiles/web/cordis.patch.yml', '[]\n')
    vfs.seed('/dsh/workspace/note.txt', 'first')
    vfs.seed('/dsh/home/.credentials.yaml', 'private-key')
    vfs.seed('/dsh/node_modules/base/package.json', '{"name":"base","version":"1.0.0"}')
  }
  const artifacts = new Map<string, string>()
  let offline = false
  const modules = new WorkerModuleLoader({ vfs, staticModules: {} })
  const host = createForgeHost(vfs, modules, '/dsh/home/profiles/web', {}, {
    runExclusive: async operation => operation(), reconcileProfile: async () => ({ pending: [], warnings: [] }),
  }, (_id, name) => String(vfs.readFileSync('/dsh/home/profiles/web/cordis.patch.yml', 'utf8')).includes(name), () => false, async (input, init) => {
    if (offline) throw new Error('Forge offline')
    const request = new Request(input, init), url = new URL(request.url)
    if (url.pathname === '/v1/builds') {
      const payload = object(await request.json()), plugin = object(payload.plugin), files = object(plugin.files)
      const built = plan(String(files['index.ts']).includes('v2') ? 'v2' : 'v1', String(plugin.id), String(plugin.entry))
      artifacts.set(built.manifest.packages[0]?.files[0]?.sha256 ?? '', built.bytes)
      return Response.json(built.manifest)
    }
    const bytes = artifacts.get(url.pathname.split('/').at(-1) ?? '')
    return bytes === undefined ? new Response('missing', { status: 404 }) : new Response(bytes)
  }, {}, [], restore ? { restoredCatalog: readForgeCatalog(vfs, '/dsh/home/profiles/web', {}) } : {})
  test.onTestFinished(async () => { await host.aiw.close(); await host.commands.close(); await host.installer.close() })
  const action = async (body: object): Promise<{ status: number; value: Record<string, unknown> }> => {
    const response = await host.aiw.fetch(new Request('http://worker/__aiw/action', { method: 'POST', body: JSON.stringify(body) }))
    return { status: response.status, value: object(await response.json()) }
  }
  return { vfs, host, modules, artifacts, action, setOffline: (): void => { offline = true } }
}

it('file edits compare observed bytes, readonly packages remain visible, and private files cannot be read or reached by shell', async (test) => {
  const f = fixture(test)
  expect((await f.action({ action: 'list', path: '/dsh/node_modules' })).value.entries).toMatchObject([{ name: 'base', writable: false }])
  const read = await f.action({ action: 'read', path: '/dsh/workspace/note.txt' })
  expect(read.value).toMatchObject({ text: 'first', sha256: digest('first') })
  expect((await f.action({ action: 'write', path: '/dsh/workspace/note.txt', text: 'unobserved' })).status).toBe(400)
  expect((await f.action({ action: 'write', path: '/dsh/workspace/note.txt', text: 'second', expectedSha256: read.value.sha256 })).status).toBe(200)
  expect((await f.action({ action: 'write', path: '/dsh/workspace/note.txt', text: 'stale', expectedSha256: read.value.sha256 })).status).toBe(400)
  expect(f.vfs.readFileSync('/dsh/workspace/note.txt', 'utf8')).toBe('second')
  for (const path of ['/dsh/home/.credentials.yaml', '/dsh/home/.aiw/settings.json', '/dsh/home/profiles/web/plugins/.forge/installed.json']) {
    expect((await f.action({ action: 'read', path })).status).toBe(400)
  }
  expect((await f.action({ action: 'write', path: '/dsh/home/profiles/web/cordis.patch.yml', text: '[]' })).status).toBe(400)
  const shell = await f.action({ action: 'shell', cwd: '/dsh/workspace', command: 'printf ok > created.txt && cat created.txt' })
  expect(shell.value).toMatchObject({ exitCode: 0, stdout: 'ok' })
  const denied = await f.action({ action: 'shell', cwd: '/dsh/workspace', command: 'echo bad > /dsh/home/.credentials.yaml' })
  expect(denied.value.exitCode).not.toBe(0)
  expect(f.vfs.readFileSync('/dsh/home/.credentials.yaml', 'utf8')).toBe('private-key')
  expect((await f.action({ action: 'shell', cwd: '/dsh/workspace', command: 'not-a-command' })).value.exitCode).toBe(127)
})

it('renames and deletes validate descendants and reject hardlink aliases', async (test) => {
  const f = fixture(test)
  await f.action({ action: 'mkdir', path: '/dsh/workspace/folder' })
  await f.action({ action: 'write', path: '/dsh/workspace/folder/file.txt', text: 'content' })
  expect((await f.action({ action: 'rename', path: '/dsh/workspace/folder', to: '/dsh/workspace/renamed' })).status).toBe(200)
  expect((await f.action({ action: 'delete', path: '/dsh/workspace/renamed' })).status).toBe(200)
  f.vfs.linkSync('/dsh/home/.credentials.yaml', '/dsh/workspace/alias')
  expect((await f.action({ action: 'read', path: '/dsh/workspace/alias' })).status).toBe(400)
  expect((await f.action({ action: 'export', path: '/dsh/workspace/alias' })).status).toBe(400)
  f.vfs.seed('/dsh/workspace/with-secret/.credentials.yaml', 'hidden')
  expect((await f.action({ action: 'delete', path: '/dsh/workspace/with-secret' })).status).toBe(400)
  expect(f.vfs.readFileSync('/dsh/workspace/with-secret/.credentials.yaml', 'utf8')).toBe('hidden')
})

it('text editing rejects invalid UTF-8 while verified file backups preserve binary data and never overwrite a destination', async (test) => {
  const f = fixture(test)
  f.vfs.seed('/dsh/workspace/backup/binary.bin', new Uint8Array([255, 0, 129]))
  expect((await f.action({ action: 'read', path: '/dsh/workspace/backup/binary.bin' })).status).toBe(400)
  const exported = await f.action({ action: 'export', path: '/dsh/workspace/backup' })
  const archive = exported.value.archive
  expect((await f.action({ action: 'import-preview', archive, directory: '/dsh/workspace/restored' })).value).toMatchObject({ fileCount: 1, bytes: 3, conflicts: [] })
  expect(f.vfs.existsSync('/dsh/workspace/restored')).toBe(false)
  expect((await f.action({ action: 'import', archive, directory: '/dsh/workspace/restored' })).status).toBe(200)
  expect(f.vfs.readFileSync('/dsh/workspace/restored/binary.bin')).toEqual(new Uint8Array([255, 0, 129]))
  expect((await f.action({ action: 'import', archive, directory: '/dsh/workspace/restored' })).status).toBe(400)
  const original = object(archive)
  for (const files of [
    [{ path: '../escape', base64: '', sha256: digest('') }],
    [{ path: 'file', base64: 'YmFk', sha256: digest('different') }],
    [{ path: 'file', base64: '', sha256: digest('') }, { path: 'file/child', base64: '', sha256: digest('') }],
  ]) {
    expect((await f.action({ action: 'import', archive: { ...original, files }, directory: '/dsh/workspace/invalid' })).status).toBe(400)
    expect(f.vfs.existsSync('/dsh/workspace/invalid')).toBe(false)
  }
})

it('source builds retain exact source and artifact revisions across GC and fresh host instances, restoring without Forge', async (test) => {
  const f = fixture(test)
  expect((await f.action({ action: 'configure', baseUrl: 'http://forge.local' })).status).toBe(200)
  expect((await f.action({ action: 'create-project', directory: '/dsh/workspace/sample', name: 'sample', client: false })).status).toBe(200)
  expect((await f.action({ action: 'build', directory: '/dsh/workspace/sample' })).value.exitCode).toBe(0)
  const first = f.host.installer.installed().plugins[0]?.revision
  const old = await f.action({ action: 'read', path: '/dsh/workspace/sample/index.ts' })
  await f.action({ action: 'write', path: '/dsh/workspace/sample/index.ts', text: String(old.value.text).replace('v1', 'v2'), expectedSha256: old.value.sha256 })
  expect((await f.action({ action: 'build', directory: '/dsh/workspace/sample' })).value.exitCode).toBe(0)
  const firstPlan = plan('v1')
  expect(f.vfs.existsSync(`/dsh/home/profiles/web/plugins/.forge/packages/${firstPlan.manifest.plugin.packageId}/index.ts`)).toBe(false)
  await f.host.aiw.close(); await f.host.commands.close(); await f.host.installer.close()
  const restored = fixture(test, f.vfs, true); restored.setOffline()
  expect((await restored.action({ action: 'status' })).value.baseUrl).toBe('http://forge.local/')
  expect((await restored.action({ action: 'history', pluginId: 'sample' })).value.versions).toMatchObject([{ hasSource: true }, { hasSource: true }])
  expect((await restored.action({ action: 'restore', pluginId: 'sample', revision: first })).value.status).toBe('active')
  expect(restored.vfs.readFileSync('/dsh/workspace/sample/index.ts', 'utf8')).toContain('sample v1')
  expect(restored.modules.createRequire('/dsh/home/profiles/web/node_modules/sample/index.js')('sample')).toMatchObject({ value: 'v1' })
  expect((await restored.action({ action: 'remove', pluginId: 'sample' })).status).toBe(200)
  expect((await restored.action({ action: 'status' })).value).toMatchObject({ plugins: [], historyPlugins: [{ pluginId: 'sample', name: 'sample' }] })
  expect((await restored.action({ action: 'restore', pluginId: 'sample', revision: first })).value.status).toBe('active')
})

it('portable plugin backups validate every hash before installing and include build source rather than subsequently edited drafts', async (test) => {
  const f = fixture(test)
  await f.action({ action: 'configure', baseUrl: 'http://forge.local' })
  await f.action({ action: 'create-project', directory: '/dsh/workspace/sample', name: 'sample', client: false })
  await f.action({ action: 'build', directory: '/dsh/workspace/sample' })
  const read = await f.action({ action: 'read', path: '/dsh/workspace/sample/index.ts' })
  await f.action({ action: 'write', path: '/dsh/workspace/sample/index.ts', text: 'unbuilt edit', expectedSha256: read.value.sha256 })
  const exported = await f.action({ action: 'plugin-export', pluginId: 'sample' })
  expect(object(object(object(exported.value.archive).source).files)['index.ts']).toContain('sample v1')
  const archive = object(exported.value.archive)
  const bytes = object(archive.objects)
  const imported = fixture(test)
  imported.setOffline()
  const invalid = await imported.action({ action: 'plugin-import', archive: { ...archive, objects: Object.fromEntries(Object.keys(bytes).map(hash => [hash, Buffer.from('wrong').toString('base64')])) } })
  expect(invalid.status).toBe(400)
  expect(imported.host.installer.installed().plugins).toEqual([])
  expect((await imported.action({ action: 'plugin-import', archive })).value.status).toBe('active')
  expect(imported.vfs.existsSync('/dsh/workspace/sample')).toBe(false)
  const projects = (await imported.action({ action: 'projects' })).value.projects
  expect(Array.isArray(projects)).toBe(true)
  if (!Array.isArray(projects)) throw new Error('missing imported project')
  expect(object(projects[0]).directory).toContain('/imported-sample-')
  expect(object(projects[0]).name).toBe('sample')
})

it('corrupt retained bytes refuse restore without rewriting them or changing the current revision', async (test) => {
  const f = fixture(test), first = plan('v1'), second = plan('v2')
  for (const built of [first, second]) {
    for (const file of built.manifest.packages[0]?.files ?? []) f.artifacts.set(file.sha256, built.bytes)
    await f.host.installer.install(built.manifest, 'http://forge.local')
  }
  const hash = first.manifest.packages[0]?.files[0]?.sha256 ?? ''
  const path = `/dsh/home/.aiw/objects/${hash}`
  f.vfs.writeFileSync(path, 'corrupt')
  expect((await f.action({ action: 'restore', pluginId: 'sample', revision: first.manifest.revision })).status).toBe(400)
  expect(f.vfs.readFileSync(path, 'utf8')).toBe('corrupt')
  expect(f.host.installer.installed().plugins[0]?.revision).toBe(second.manifest.revision)
})

it('a closed workbench rejects new work without mutating files', async (test) => {
  const f = fixture(test)
  await f.host.aiw.close()
  const result = await f.action({ action: 'status' })
  expect(result.status).toBe(503)
})

it('archive import rejects protected path aliases and conflicting directory entries before writing', () => {
  const vfs = new MemoryVfs(); vfs.seedDirectory('/dsh/workspace')
  const files = new AiwFiles(vfs, '/dsh')
  const base: AiwFilesArchive = { schema: 1, generation: FORGE_GENERATION, kind: 'files', files: [], directories: [] }
  expect(() => files.import({ ...base, directories: ['.credentials.yaml'] }, '/dsh/workspace/new')).toThrow()
  expect(() => files.import({ ...base, directories: ['dir', 'dir'] }, '/dsh/workspace/new')).toThrow()
  expect(vfs.existsSync('/dsh/workspace/new')).toBe(false)
})

it('updates and removals preserve pre-workbench installed artifacts even before history is opened', async (test) => {
  const f = fixture(test), first = plan('v1'), second = plan('v2')
  for (const built of [first, second]) for (const file of built.manifest.packages[0]?.files ?? []) f.artifacts.set(file.sha256, built.bytes)
  await f.host.installer.install(first.manifest, 'http://forge.local')
  f.vfs.rmSync('/dsh/home/.aiw', { recursive: true })
  await f.host.installer.install(second.manifest, 'http://forge.local')
  expect((await f.action({ action: 'history', pluginId: 'sample' })).value.versions).toMatchObject([{ hasSource: false }, { hasSource: false }])
  f.vfs.rmSync('/dsh/home/.aiw', { recursive: true })
  const removed = await f.host.commands.dsh.prepare(['plugin', '--profile', 'web', 'remove', 'sample'], {
    cwd: '/dsh/workspace', env: {}, signal: new AbortController().signal, filesystem: new AiwFiles(f.vfs, '/dsh').shell(), output: () => {},
  })
  expect(removed).toMatchObject({ kind: 'exit', exitCode: 0 })
  expect((await f.action({ action: 'history', pluginId: 'sample' })).value.versions).toMatchObject([{ revision: second.manifest.revision, hasSource: false }])
})

it('closing cancels an accepted build and waits for its HTTP provider to settle', async (test) => {
  const vfs = new MemoryVfs(); vfs.seed('/dsh/home/profiles/web/cordis.patch.yml', '[]')
  const started = Promise.withResolvers<undefined>()
  let providerSettled = false
  const host = createForgeHost(vfs, new WorkerModuleLoader({ vfs, staticModules: {} }), '/dsh/home/profiles/web', {}, {
    runExclusive: async operation => operation(), reconcileProfile: async () => ({ pending: [], warnings: [] }),
  }, () => true, () => false, async (input, init) => {
    const request = new Request(input, init)
    started.resolve(undefined)
    try { await new Promise<void>((_resolve, reject) => {
      const abort = (): void => { reject(request.signal.reason instanceof Error ? request.signal.reason : new Error('cancelled')) }
      if (request.signal.aborted) abort(); else request.signal.addEventListener('abort', abort, { once: true })
    }) } finally { providerSettled = true }
    return Response.json({})
  })
  test.onTestFinished(async () => { await host.aiw.close(); await host.commands.close(); await host.installer.close() })
  const action = (body: object): Promise<Response> => host.aiw.fetch(new Request('http://worker/__aiw/action', { method: 'POST', body: JSON.stringify(body) }))
  await action({ action: 'configure', baseUrl: 'http://forge.local' })
  await action({ action: 'create-project', directory: '/dsh/workspace/pending', name: 'pending', client: false })
  const result = action({ action: 'build', directory: '/dsh/workspace/pending' })
  await started.promise
  await host.aiw.close()
  expect(providerSettled).toBe(true)
  expect(object(await (await result).json())).toMatchObject({ exitCode: 1 })
  expect(host.installer.installed().plugins).toEqual([])
})

it('Unicode and space-containing filenames round-trip through file backup import', () => {
  const vfs = new MemoryVfs(); vfs.seed('/dsh/workspace/source/中文 文件.md', '正文')
  const files = new AiwFiles(vfs, '/dsh')
  const archive = files.export('/dsh/workspace/source')
  expect(files.import(archive, '/dsh/workspace/导入 副本').writes).toBe(1)
  expect(vfs.readFileSync('/dsh/workspace/导入 副本/中文 文件.md', 'utf8')).toBe('正文')
})

it('multi-megabyte binary files round-trip through file and plugin archives', async (test) => {
  const f = fixture(test), bytes = Buffer.alloc(4 * 1024 * 1024, 1)
  const hash = createHash('sha256').update(bytes).digest('hex')
  f.vfs.seed('/dsh/workspace/large/binary.bin', bytes)
  const exported = await f.action({ action: 'export', path: '/dsh/workspace/large' })
  expect((await f.action({ action: 'import', archive: exported.value.archive, directory: '/dsh/workspace/restored-large' })).status).toBe(200)
  expect(createHash('sha256').update(f.vfs.readFileSync('/dsh/workspace/restored-large/binary.bin') as Uint8Array).digest('hex')).toBe(hash)
  const built = plan('large')
  built.manifest.packages[0]!.files.push({ path: 'binary.bin', sha256: hash, size: bytes.length, objectKey: `${FORGE_GENERATION}/objects/${hash}` })
  const response = await f.action({ action: 'plugin-import', archive: {
    schema: 1, generation: FORGE_GENERATION, kind: 'plugin', manifest: built.manifest,
    objects: { [hash]: bytes.toString('base64'), [digest(built.bytes)]: Buffer.from(built.bytes).toString('base64') },
  } })
  expect(response.status).toBe(200)
  expect(response.value.status).toBe('active')
  const pluginArchive = (await f.action({ action: 'plugin-export', pluginId: 'sample' })).value.archive
  const other = fixture(test)
  expect((await other.action({ action: 'plugin-import', archive: pluginArchive })).status).toBe(200)
  expect(createHash('sha256').update(other.vfs.readFileSync(`/dsh/home/profiles/web/plugins/.forge/packages/${built.manifest.plugin.packageId}/binary.bin`) as Uint8Array).digest('hex')).toBe(hash)
})

it.each(['index.ts/helper.ts', 'forge.json/helper.ts'])('rejects conflicting source path %s before retaining or installing an imported plugin', async (conflict) => {
  const f = fixture({ onTestFinished }), built = plan('imported')
  const source = { directory: '/original', files: {
    'forge.json': JSON.stringify({ id: 'sample', name: 'sample', version: '1.0.0', entry: 'index.ts', files: ['index.ts', conflict] }),
    'index.ts': 'export const apply = () => {}', [conflict]: 'export const value = 1',
  } }
  const response = await f.action({ action: 'plugin-import', archive: {
    schema: 1, generation: FORGE_GENERATION, kind: 'plugin', manifest: built.manifest, source,
    objects: { [digest(built.bytes)]: Buffer.from(built.bytes).toString('base64') },
  } })
  expect(response).toMatchObject({ status: 400, value: { error: { code: 'invalid-source' } } })
  expect(f.host.installer.installed().plugins).toEqual([])
  expect(f.vfs.existsSync('/dsh/home/.aiw')).toBe(false)
  expect(f.vfs.readdirSync('/dsh/workspace')).toEqual(['note.txt'])
  expect(f.vfs.readFileSync('/dsh/home/profiles/web/cordis.patch.yml', 'utf8')).toBe('[]\n')
})

it.each(['A', 'AA=', 'AA=A', 'A===', 'AAAA=', 'AAA\n', 'AA-_', '===='])('rejects malformed archive base64 %j before writing', async (base64) => {
  const f = fixture({ onTestFinished }), built = plan('invalid')
  const decoded = Buffer.from(base64, 'base64'), hash = createHash('sha256').update(decoded).digest('hex')
  const file = built.manifest.packages[0]!.files[0]!
  file.sha256 = hash; file.size = decoded.length; file.objectKey = `${FORGE_GENERATION}/objects/${hash}`
  expect((await f.action({ action: 'import', archive: { schema: 1, generation: FORGE_GENERATION, kind: 'files', directories: [],
    files: [{ path: 'invalid.bin', base64, sha256: hash }] }, directory: '/dsh/workspace/invalid-base64' })).value).toMatchObject({ error: { code: 'invalid-archive' } })
  expect((await f.action({ action: 'plugin-import', archive: { schema: 1, generation: FORGE_GENERATION, kind: 'plugin', manifest: built.manifest,
    objects: { [hash]: base64 } } })).value).toMatchObject({ error: { code: 'invalid-archive' } })
  expect(f.vfs.existsSync('/dsh/workspace/invalid-base64')).toBe(false)
  expect(f.host.installer.installed().plugins).toEqual([])
})
