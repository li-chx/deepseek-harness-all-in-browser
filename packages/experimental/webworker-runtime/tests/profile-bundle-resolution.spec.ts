/** Standard app-boot inventory resolves Forge profile mirrors through the Worker require face. */
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { expect, it } from 'vitest'
import { WorkerModuleLoader } from '../src/module-system/module-loader.ts'
import { MemoryVfs } from '../src/storage/memory.ts'

function fixture() {
  const vfs = new MemoryVfs()
  const profile = '/dsh/home/profiles/web'
  // Execute the real resolver source; unrelated profile operations are outside this fixture.
  const source = readFileSync(new URL('../../../boot/app-boot/src/profile.ts', import.meta.url), 'utf8')
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  vfs.seed('/dsh/profile.js', code)
  const unused = (): object => new Proxy({}, { get(_target, property) { throw new Error(`Unexpected profile dependency: ${String(property)}`) } })
  const loader: WorkerModuleLoader = new WorkerModuleLoader({ vfs, staticModules: {
    'node:module': () => ({ createRequire: (anchor: string) => loader.createRequire(anchor) }),
    'node:fs': () => ({ existsSync: (path: string) => vfs.existsSync(path) }),
    'node:path': () => posix,
    '@deepseek-ai/cordis-plugin-include': unused,
    '@deepseek-ai/dsh-home-paths': unused,
    '@deepseek-ai/dsh-official-bundles': unused,
    './plugin-compatibility.ts': unused,
    './profile-compatibility.ts': unused,
    './index.ts': unused,
    './profile-resolution/legacy-links.ts': unused,
  } })
  const resolver = loader.requireFrom('/dsh')('./profile.js') as {
    resolveBundleDir(bin: string, name: string, installation: string, profile: string): string
  }
  const bundle = (directory: string, name: string): void => {
    vfs.seed(`${directory}/package.json`, JSON.stringify({ name, exports: { '.': './index.js' }, dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    vfs.seed(`${directory}/index.js`, 'exports.name = "bundle"')
  }
  return { vfs, loader, profile, bundle,
    resolve: (name: string) => resolver.resolveBundleDir('dsh', name, '/dsh/node_modules/@deepseek-ai/dsh/package.json', profile) }
}

it.each(['dsh-plugin', '@example/mobile'])('discovers profile bundle %s without a package.json export', (name) => {
  const f = fixture()
  const directory = `${f.profile}/node_modules/${name}`
  f.bundle(directory, name)
  f.loader.setPackageAliases(new Map([[name, directory]]))
  expect(f.loader.createRequire(`${f.profile}/package.json`).resolve(name)).toBe(`${directory}/index.js`)
  expect(() => f.loader.createRequire(`${f.profile}/package.json`).resolve(`${name}/package.json`)).toThrow('does not export')
  expect(f.resolve(name)).toBe(directory)
  f.vfs.rmSync(directory, { recursive: true })
  expect(() => f.resolve(name)).toThrow('cannot resolve profile bundle')
})

it('keeps installation bundles ahead of profile copies in the standard resolver', () => {
  const f = fixture()
  f.bundle('/dsh/node_modules/example', 'example')
  f.bundle(`${f.profile}/node_modules/example`, 'example')
  expect(f.resolve('example')).toBe('/dsh/node_modules/example')
})

it('lists anchor ancestors without node_modules/node_modules and preserves builtin and relative paths', () => {
  const f = fixture()
  const require = f.loader.createRequire(`${f.profile}/node_modules/example/index.js`)
  expect(require.resolve.paths('another')).toEqual([
    `${f.profile}/node_modules/example/node_modules`, `${f.profile}/node_modules`,
    '/dsh/home/profiles/node_modules', '/dsh/home/node_modules', '/dsh/node_modules', '/node_modules',
  ])
  expect(require.resolve.paths('node:module')).toBeNull()
  expect(require.resolve.paths('./relative')).toEqual([`${f.profile}/node_modules/example`])
})
