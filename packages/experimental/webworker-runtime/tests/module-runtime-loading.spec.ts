/** Runtime requests evaluate prepared modules once and preserve importer-owned dependency tracking. */
import { expect, it } from 'vitest'
import { lowerModuleSource } from '../src/compile/transform.ts'
import { WorkerModuleLoader } from '../src/module-system/module-loader.ts'
import { MemoryVfs } from '../src/storage/memory.ts'

function fixture() {
  const vfs = new MemoryVfs()
  const files: Record<string, string> = {
    '/dsh/plugin/package.json': JSON.stringify({ main: 'main.cjs' }),
    '/dsh/plugin/main.cjs': `const alias = require;
      exports.locate = name => alias.resolve(name);
      exports.read = name => alias(name);
      exports.later = name => import(name);`,
    '/dsh/plugin/lazy.ts': 'export const token = {}; export const version = 1',
    '/dsh/plugin/folder/package.json': JSON.stringify({ main: './entry.cts' }),
    '/dsh/plugin/folder/entry.cts': 'module.exports = { value: 2 }',
    '/dsh/plugin/data.json': '{"value":3}',
    '/dsh/plugin/a.cjs': 'exports.name="a"; exports.other=require("./b.cjs").name',
    '/dsh/plugin/b.cjs': 'exports.name="b"; exports.other=require("./a.cjs").name',
    '/dsh/dep/package.json': JSON.stringify({ exports: {
      '.': { types: './missing.d.ts', browser: './browser.mjs', default: './default.cjs' },
      './private': null,
      './*': './parts/*.mts',
    } }),
    '/dsh/dep/browser.mjs': 'export const browser = true',
    '/dsh/dep/default.cjs': 'throw new Error("unselected condition")',
    '/dsh/dep/parts/feature.mts': 'export const value = 4',
    '/dsh/dep/parts/private.mts': 'throw new Error("blocked wildcard")',
    '/dsh/node_modules/undeclared/package.json': '{"main":"index.js"}',
    '/dsh/node_modules/undeclared/index.js': 'exports.value = "must not leak"',
  }
  for (const [path, source] of Object.entries(files)) {
    vfs.seed(path, path.endsWith('.json') ? source : lowerModuleSource({ filename: path, source }).code)
  }
  const fs = { read: true }
  const loader = new WorkerModuleLoader({ vfs, staticModules: { 'node:fs': () => fs } })
  loader.setPackageScopes(new Map([
    ['/dsh/plugin', { dep: '/dsh/dep' }],
    ['/dsh/dep', {}],
  ]))
  const root = loader.requireFrom('/dsh/plugin')('./main.cjs') as {
    locate(name: string): string
    read(name: string): unknown
    later(name: string): Promise<{ token: unknown; version: number }>
  }
  return { vfs, loader, root }
}

it('resolves without evaluation, then shares alias/computed require and dynamic import identities', async () => {
  const { root, loader } = fixture()
  expect(loader.usage().modules).toBe(1)
  expect(root.locate('./lazy')).toBe('/dsh/plugin/lazy.ts')
  expect(root.locate('dep/feature')).toBe('/dsh/dep/parts/feature.mts')
  expect(root.locate('node:fs')).toBe('node:fs')
  expect(loader.usage().modules).toBe(1)
  expect(loader.hmrModules.records()[0]?.dependencies).toEqual([])
  const imported = await root.later('./lazy.ts')
  expect(imported).toBe(root.read('./lazy'))
  expect((await root.later('./lazy.ts')).token).toBe(imported.token)
  expect(root.read('./folder')).toEqual({ value: 2 })
  expect(root.read('./data.json')).toEqual({ value: 3 })
  expect(root.read('./a.cjs')).toEqual({ name: 'a', other: 'b' })
  expect(root.read('dep')).toMatchObject({ browser: true })
  expect(root.read('dep/feature')).toMatchObject({ value: 4 })
  expect(loader.hmrModules.records().find(row => row.url.endsWith('/main.cjs'))?.dependencies)
    .toEqual(expect.arrayContaining(['file:///dsh/plugin/lazy.ts', 'file:///dsh/dep/parts/feature.mts']))
})

it('keeps undeclared packages and blocked exports unavailable at the actual request', async () => {
  const { root } = fixture()
  expect(() => root.read('undeclared')).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }))
  await expect(root.later('undeclared')).rejects.toMatchObject({ code: 'MODULE_NOT_FOUND' })
  expect(() => root.read('dep/private')).toThrow(expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }))
  expect(() => root.locate('dep/../escape')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_PACKAGE_TARGET' }))
  expect(() => root.read('node:missing-capability')).toThrow('no static module')
})

it('invalidates evaluated lazy modules and tracks a new owner after HMR without changing old exports', async () => {
  const { root, vfs, loader } = fixture()
  const old = await root.later('./lazy.ts')
  vfs.writeFileSync('/dsh/plugin/lazy.ts', lowerModuleSource({ filename: 'lazy.ts', source: 'export const version = 2' }).code)
  loader.hmrModules.invalidate(['file:///dsh/plugin/lazy.ts', 'file:///dsh/plugin/main.cjs'])
  const next = loader.requireFrom('/dsh/plugin')('./main.cjs') as typeof root
  expect(await next.later('./lazy.ts')).toMatchObject({ version: 2 })
  expect(old.version).toBe(1)
  expect(loader.hmrModules.records().find(row => row.url.endsWith('/main.cjs'))?.dependencies).toEqual(['file:///dsh/plugin/lazy.ts'])
})

it('reports circular directory main resolution instead of recursing indefinitely', () => {
  const { root, vfs } = fixture()
  vfs.seed('/dsh/plugin/loop/package.json', '{"main":"."}')
  expect(() => root.read('./loop')).toThrow(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }))
})
