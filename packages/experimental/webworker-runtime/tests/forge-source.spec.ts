/** Local source descriptors select explicit files without directory discovery or ambient reads. */
import { expect, it } from 'vitest'
import { readForgeSource } from '../src/forge/source.ts'
import type { ShellFileSystem } from '../src/shell/types.ts'

function fixture(descriptor: unknown = {}) {
  const files = new Map<string, string>([
    ['/workspace/plugin/forge.json', JSON.stringify({ id: 'local-plugin', name: 'local-plugin', version: '1.0.0',
      entry: 'main.ts', files: ['main.ts', 'data.json'], ...typeof descriptor === 'object' ? descriptor : {} })],
    ['/workspace/plugin/main.ts', 'export const value: number = 1'],
    ['/workspace/plugin/data.json', '{"value":1}'],
    ['/workspace/plugin/.env', 'never read'],
    ['/workspace/plugin/unlisted.ts', 'never read'],
  ])
  const reads: string[] = []
  const filesystem: ShellFileSystem = {
    stat: async path => path === '/workspace/plugin' ? { directory: true, size: 0, mtimeMs: 0 }
      : files.has(path) ? { directory: false, size: files.get(path)?.length ?? 0, mtimeMs: 0 } : undefined,
    readText: async (path) => { reads.push(path); const text = files.get(path); if (text === undefined) throw Error('Missing file'); return text },
    list: async () => { throw Error('Directory discovery is forbidden') },
    writeText: async () => { throw Error('Source reading cannot write files') },
    mkdir: async () => { throw Error('Source reading cannot create directories') },
    remove: async () => { throw Error('Source reading cannot delete files') },
    rename: async () => { throw Error('Source reading cannot rename files') },
  }
  return { files, reads, filesystem }
}

it('reads explicit TS and JSON sources with separate dependencies and optional peer declarations', async () => {
  const f = fixture({ dependencies: { 'is-odd': '^3.0.0' }, peerDependencies: { react: '^19.0.0' },
    peerDependenciesMeta: { react: { optional: true } } })
  const result = await readForgeSource('plugin', '/workspace', f.filesystem, new AbortController().signal)
  expect(result.files).toEqual({ 'main.ts': 'export const value: number = 1', 'data.json': '{"value":1}' })
  expect(result.dependencies).toEqual({ 'is-odd': '^3.0.0' })
  expect(result.peerDependenciesMeta).toEqual({ react: { optional: true } })
  expect(f.reads).toEqual(['/workspace/plugin/forge.json', '/workspace/plugin/main.ts', '/workspace/plugin/data.json'])
})

it.each([
  { files: ['main.ts', 'main.ts'] },
  { files: ['data.json'] },
  { files: [] },
  { files: 'main.ts' },
  { files: [1] },
  { id: '../bad' },
  { name: 'https://registry/package' },
  { version: 1 },
  { dependencies: { ordinary: 1 } },
  { peerDependencies: [] },
  { peerDependenciesMeta: { ordinary: { optional: 'yes' } } },
  { peerDependenciesMeta: { ordinary: { extra: true } } },
  { generation: 'override' },
  { protocol: 1 },
  { hostPackages: {} },
])('rejects malformed descriptor fields before reading selected sources: %j', async (descriptor) => {
  const f = fixture(descriptor)
  await expect(readForgeSource('/workspace/plugin', '/ignored', f.filesystem, new AbortController().signal)).rejects.toThrow()
  expect(f.reads).toEqual(['/workspace/plugin/forge.json'])
})

it.each(['../main.ts', '/main.ts', 'dir\\main.ts', 'dir/../main.ts', './main.ts', 'dir//main.ts', 'node_modules/a.js',
  'dir/node_modules/a.js', 'package.json', '.env.json', 'dir/.env.local.js', 'main.wasm', 'types.d.ts'])
('rejects unsafe or unsupported explicit source paths: %s', async (path) => {
  const f = fixture({ entry: path, files: [path] })
  await expect(readForgeSource('plugin', '/workspace', f.filesystem, new AbortController().signal)).rejects.toThrow()
  expect(f.reads).toEqual(['/workspace/plugin/forge.json'])
})

it('rejects missing sources and directories passed as files', async () => {
  const f = fixture()
  f.files.delete('/workspace/plugin/main.ts')
  await expect(readForgeSource('plugin', '/workspace', f.filesystem, new AbortController().signal)).rejects.toThrow('not a regular file')
  const originalStat = f.filesystem.stat.bind(f.filesystem)
  f.filesystem.stat = async path => path.endsWith('/main.ts') ? { directory: true, size: 0, mtimeMs: 0 } : originalStat(path)
  await expect(readForgeSource('plugin', '/workspace', f.filesystem, new AbortController().signal)).rejects.toThrow('not a regular file')
  expect(f.reads).toEqual(['/workspace/plugin/forge.json', '/workspace/plugin/forge.json'])
})

it('rejects malformed JSON and a directory in place of forge.json', async () => {
  const f = fixture()
  f.files.set('/workspace/plugin/forge.json', '{')
  await expect(readForgeSource('plugin', '/workspace', f.filesystem, new AbortController().signal)).rejects.toThrow('invalid JSON')
  f.filesystem.stat = async () => ({ directory: true, size: 0, mtimeMs: 0 })
  await expect(readForgeSource('plugin', '/workspace', f.filesystem, new AbortController().signal)).rejects.toThrow('regular forge.json')
})

it('cancellation during an asynchronous source read prevents reading remaining files', async () => {
  const f = fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const original = f.filesystem.readText.bind(f.filesystem)
  f.filesystem.readText = async (path) => {
    if (path.endsWith('/main.ts')) { entered.resolve(undefined); await release.promise }
    return original(path)
  }
  const cancellation = new AbortController()
  const reading = readForgeSource('plugin', '/workspace', f.filesystem, cancellation.signal)
  await entered.promise
  cancellation.abort(new Error('cancelled source read'))
  release.resolve(undefined)
  await expect(reading).rejects.toThrow('cancelled source read')
  expect(f.reads).not.toContain('/workspace/plugin/data.json')
})
