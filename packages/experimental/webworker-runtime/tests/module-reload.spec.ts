/** Worker module identities, dependency records and cache eviction used by Host HMR. */
import { expect, it } from 'vitest'
import { WorkerModuleLoader } from '../src/module-system/module-loader.ts'
import { MemoryVfs } from '../src/storage/memory.ts'

function fixture(files: Record<string, string>) {
  const vfs = new MemoryVfs()
  for (const [path, text] of Object.entries(files)) vfs.seed(`/dsh/${path}`, text)
  const loader = new WorkerModuleLoader({ vfs, staticModules: {} })
  return { vfs, loader, require: loader.requireFrom('/dsh') }
}

it('records shared cached dependencies and reloads selected importers without replacing an unrelated module', () => {
  const { vfs, loader, require } = fixture({
    'shared.js': 'exports.version = 1',
    'a.js': 'exports.value = require("./shared.js").version',
    'b.js': 'exports.value = require("./shared.js").version',
    'other.js': 'exports.value = {}',
  })
  const a = require('./a.js')
  require('./b.js')
  const other = require('./other.js')
  expect(loader.hmrModules.records().filter(row => row.url.endsWith('/a.js') || row.url.endsWith('/b.js'))
    .map(row => row.dependencies)).toEqual([['file:///dsh/shared.js'], ['file:///dsh/shared.js']])
  vfs.writeFileSync('/dsh/shared.js', 'exports.version = 2')
  expect(require('./a.js')).toBe(a)
  loader.hmrModules.invalidate(['file:///dsh/shared.js', 'file:///dsh/a.js', 'file:///dsh/b.js'])
  expect(require('./a.js')).toEqual({ value: 2 })
  expect(require('./b.js')).toEqual({ value: 2 })
  expect(require('./other.js')).toBe(other)
  expect(loader.usage().modules).toBe(4)
})

it('replaces obsolete dependency edges and records deferred requests and createRequire owners', () => {
  const { vfs, loader, require } = fixture({
    'a.js': 'exports.read = () => require("./b.js")',
    'b.js': 'exports.value = 1',
    'c.js': 'exports.value = 2',
  })
  const first = require('./a.js') as { read(): unknown }
  expect(loader.hmrModules.records()[0]?.dependencies).toEqual([])
  expect(first.read()).toEqual({ value: 1 })
  expect(loader.hmrModules.records()[0]?.dependencies).toEqual(['file:///dsh/b.js'])
  vfs.writeFileSync('/dsh/a.js', 'exports.read = () => require("./c.js")')
  loader.hmrModules.invalidate(['file:///dsh/a.js'])
  const second = require('./a.js') as { read(): unknown }
  second.read()
  first.read()
  expect(loader.hmrModules.records().find(row => row.url.endsWith('/a.js'))?.dependencies)
    .toEqual(['file:///dsh/c.js'])
  loader.createRequire('file:///dsh/a.js')('./b.js')
  expect(loader.hmrModules.records().find(row => row.url.endsWith('/a.js'))?.dependencies)
    .toEqual(['file:///dsh/c.js', 'file:///dsh/b.js'])
  expect(loader.createRequire('file:///dsh/external.js')('./c.js')).toEqual({ value: 2 })
})

it('keeps circular partial exports and permits retry after evaluation failure', () => {
  const { vfs, loader, require } = fixture({
    'a.js': 'exports.name = "a"; exports.peer = require("./b.js").name',
    'b.js': 'exports.name = "b"; exports.peer = require("./a.js").name',
    'broken.js': 'require("./a.js"); throw new Error("broken")',
  })
  expect(require('./a.js')).toEqual({ name: 'a', peer: 'b' })
  expect(() => require('./broken.js')).toThrow('broken')
  expect(loader.hmrModules.records().find(row => row.url.endsWith('/broken.js')))
    .toMatchObject({ loaded: false, dependencies: ['file:///dsh/a.js'] })
  vfs.writeFileSync('/dsh/broken.js', 'exports.fixed = true')
  expect(require('./broken.js')).toEqual({ fixed: true })
})

it('rejects bootstrap eviction atomically and includes its late dependencies', () => {
  const { loader, require } = fixture({
    'boot.js': 'exports.read = () => require("./shared.js")',
    'shared.js': 'exports.value = 1',
    'plugin.js': 'exports.value = 2',
  })
  const boot = require('./boot.js') as { read(): unknown }
  loader.protectBootstrap()
  boot.read()
  const plugin = require('./plugin.js')
  expect(loader.hmrModules.protectedUrls()).toEqual(['file:///dsh/boot.js', 'file:///dsh/shared.js'])
  expect(() => { loader.hmrModules.invalidate(['file:///dsh/plugin.js', 'file:///dsh/shared.js']) })
    .toThrow('requires a restart')
  expect(require('./plugin.js')).toBe(plugin)
})

it('expires package metadata and JSON modules when a replacement is loaded', () => {
  const { loader, vfs, require } = fixture({
    'node_modules/example/package.json': '{"main":"v1.js"}',
    'node_modules/example/v1.js': 'module.exports = require("./data.json")',
    'node_modules/example/v2.js': 'exports.value = 2',
    'node_modules/example/data.json': '{"value":1}',
  })
  expect(require('example')).toEqual({ value: 1 })
  vfs.writeFileSync('/dsh/node_modules/example/package.json', '{"main":"v2.js"}')
  loader.hmrModules.invalidate(['file:///dsh/node_modules/example/v1.js'])
  expect(require('example')).toEqual({ value: 2 })
  loader.hmrModules.invalidate(['file:///dsh/node_modules/example/data.json'])
  vfs.writeFileSync('/dsh/node_modules/example/data.json', '{"value":3}')
  expect(require('./node_modules/example/data.json')).toEqual({ value: 3 })
})
