/** Scoped virtual CLI operations report actual build, application and cancellation outcomes. */
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { ForgeCommands } from '../src/forge/commands.ts'
import { ForgeInstaller } from '../src/forge/installer.ts'
import { editForgeProfilePatch } from '../src/forge/profile-patch.ts'
import { FORGE_GENERATION, type ForgeManifest } from '../src/forge/protocol.ts'
import { createChildProcessFacade, type WorkerChildProcess } from '../src/node/builtin_modules/implemented/child_process.ts'
import { VirtualExecutableRegistry } from '../src/shell/process/virtual-executables.ts'
import { WorkerModuleLoader } from '../src/module-system/module-loader.ts'
import { MemoryVfs } from '../src/storage/memory.ts'
import { setActiveVfs } from '../src/storage/active.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

function fixture() {
  const vfs = new MemoryVfs()
  vfs.seed('/dsh/home/profiles/web/cordis.patch.yml', '[]\n')
  vfs.seed('/dsh/home/profiles/web/package.json', JSON.stringify({ dependencies: { preserved: '1.0.0' } }))
  setActiveVfs(vfs)
  const modules = new WorkerModuleLoader({ vfs, staticModules: {} })
  const source = 'exports.name = "example"; exports.apply = () => {}'
  const patch = '- insert:\n  - id: example\n    name: example\n'
  const client = 'window.__ModuleLoader__.load({id:"example",factory(){}})'
  const files = new Map([source, patch, client].map(value => [hash(value), value]))
  const id = hash('package')
  const manifest: ForgeManifest = { protocol: 1, generation: FORGE_GENERATION, revision: id,
    plugin: { id: 'example', name: 'example', version: '1.0.0', entry: 'index.js', packageId: id }, hostPackages: {},
    packages: [{ id, name: 'example', version: '1.0.0', entry: 'index.js', dependencies: {},
      metadata: { repository: { url: 'https://github.com/example/example' },
        exports: { '.': './index.js', './client': './client/client.js' },
        dsh: { bundle: { patch: 'cordis.patch.yml' }, client: { platform: 'web', inject: ['locale'] } } },
      files: [[source, 'index.js'], [patch, 'cordis.patch.yml'], [client, 'client/client.js']].map(([text = '', path = '']) => ({ path, size: Buffer.byteLength(text), sha256: hash(text), objectKey: `${FORGE_GENERATION}/objects/${hash(text)}` })),
    }],
  }
  const calls: string[] = []
  const entered = Promise.withResolvers<undefined>()
  let block = false
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    calls.push(url)
    if (url.endsWith('/builds')) {
      entered.resolve(undefined)
      if (block) await new Promise<void>((resolve, reject) => {
        void resolve
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      const request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { pluginId: string }
      return Response.json({ ...manifest, plugin: { ...manifest.plugin, id: request.pluginId } })
    }
    return new Response(files.get(url.split('/').at(-1) ?? '') ?? '', { status: 200 })
  }
  let active = true
  const installer = new ForgeInstaller({ vfs, modules, isEntryActive: () => active, profileDirectory: '/dsh/home/profiles/web',
    hostPackages: { '@deepseek-ai/dsh-app-boot': '0.2.1-rc.3' }, fetch: fetcher, editPatch: editForgeProfilePatch,
    hmr: { runExclusive: async operation => operation(), reconcileProfile: async (ids?: readonly string[]) => {
      if (ids === undefined) active = false
      return { pending: [], warnings: [] }
    } },
  })
  const commands = new ForgeCommands(installer, 'web', fetcher)
  commands.configure('http://forge.local')
  const registry = new VirtualExecutableRegistry()
  const unregister = [registry.register(commands.dsh), registry.register(commands.which)]
  const facade = createChildProcessFacade(registry)
  cleanups.push(async () => { for (const stop of unregister) stop(); await commands.close(); await installer.close() })
  return { vfs, modules, installer, commands, facade, calls, entered,
    setActive: (value: boolean): void => { active = value }, block: (): void => { block = true } }
}

async function completion(child: WorkerChildProcess): Promise<{ code: unknown; signal: unknown; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (value: unknown) => { stdout += String(value) })
  child.stderr?.on('data', (value: unknown) => { stderr += String(value) })
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code: unknown, signal: unknown) => { resolve({ code, signal, stdout, stderr }) })
  })
}

it('answers only local probes synchronously and installs published metadata through async spawn', async () => {
  const f = fixture()
  expect(f.facade.spawnSync('which', ['dsh']).stdout.toString()).toBe('/dsh/bin/dsh\n')
  const which = f.facade.spawnSync('which', ['dsh'], { encoding: 'utf8' })
  expect(which.status === 0 && which.stdout.trim().length > 0).toBe(true)
  expect(which.stdout).toBe('/dsh/bin/dsh\n')
  const missing = f.facade.spawnSync('which', ['npm'], { encoding: 'utf-8' })
  expect(missing.status === 0 && missing.stdout.trim().length > 0).toBe(false)
  expect(missing.stdout).toBe('')
  expect(() => { Reflect.apply(f.facade.spawnSync, undefined, ['which', ['dsh'], { encoding: 'unsupported' }]) })
    .toThrow('Unknown encoding')
  expect(f.facade.spawnSync('dsh', ['--version']).stdout.toString()).toBe('0.2.1-rc.3\n')
  expect(f.facade.spawnSync('dsh', ['plugin', '--profile', 'web', 'add', 'example']).error).toBeDefined()
  expect(f.calls).toEqual([])
  const installed = await completion(f.facade.spawn('dsh', ['plugin', '--profile', 'web', 'add', 'example@1.0.0']))
  expect(installed).toMatchObject({ code: 0, signal: null })
  expect(installed.stdout).toContain('Installed example')
  expect(f.modules.requireFrom('/dsh/node_modules/loader')('example')).toMatchObject({ name: 'example' })
  expect(f.vfs.readFileSync('/dsh/home/profiles/web/cordis.patch.yml', 'utf8')).toBe('[]\n')
  expect(JSON.parse(f.vfs.readFileSync('/dsh/home/profiles/web/package.json', 'utf8') as string)).toMatchObject({
    dsh: { profile: { bundles: ['example'] } },
  })
  const packagePath = '/dsh/home/profiles/web/node_modules/example'
  expect(JSON.parse(f.vfs.readFileSync(`${packagePath}/package.json`, 'utf8') as string)).toMatchObject({
    name: 'example', repository: { url: 'https://github.com/example/example' }, dsh: { client: { platform: 'web' } },
  })
  expect(f.vfs.existsSync(`${packagePath}/client/client.js`)).toBe(true)
  expect(JSON.parse(f.vfs.readFileSync('/dsh/home/profiles/web/package.json', 'utf8') as string)).toEqual({ dependencies: { preserved: '1.0.0', example: '1.0.0' }, dsh: { profile: { bundles: ['example'] } } })
  expect(await completion(f.facade.spawn('dsh', ['plugin', '--profile=web', 'remove', 'example']))).toMatchObject({ code: 0 })
  expect(f.vfs.existsSync(packagePath)).toBe(false)
})

it('refuses other profiles and unsupported commands without network or file effects', async () => {
  const f = fixture()
  expect(await completion(f.facade.spawn('dsh', ['plugin', '--profile', 'other', 'add', 'example']))).toMatchObject({ code: 1 })
  expect(await completion(f.facade.spawn('dsh', ['run', 'example']))).toMatchObject({ code: 1 })
  expect(f.facade.spawnSync('which', ['npm']).status).toBe(1)
  expect(f.facade.spawnSync('node', ['-e', '1']).error).toBeDefined()
  expect(f.calls).toEqual([])
  expect(f.installer.installed().plugins).toEqual([])
})

it('cancels pending build work and reports the terminating signal without installing', async () => {
  const f = fixture()
  f.block()
  const child = f.facade.spawn('dsh', ['plugin', '--profile', 'web', 'add', 'example'])
  const result = completion(child)
  await f.entered.promise
  child.kill('SIGTERM')
  expect(await result).toMatchObject({ code: null, signal: 'SIGTERM' })
  expect(f.installer.installed().plugins).toEqual([])
})

it('reports a disabled native bundle update as a successful installation', async () => {
  const f = fixture()
  expect((await completion(f.facade.spawn('dsh', ['plugin', '--profile', 'web', 'add', 'example']))).code).toBe(0)
  const path = '/dsh/home/profiles/web/package.json'
  const profile = JSON.parse(f.vfs.readFileSync(path, 'utf8') as string) as { dsh: { profile: { bundles: string[] } } }
  profile.dsh.profile.bundles = []
  f.vfs.writeFileSync(path, JSON.stringify(profile))
  f.setActive(false)
  const update = await completion(f.facade.spawn('dsh', ['plugin', '--profile', 'web', 'update', 'example']))
  expect(update).toMatchObject({ code: 0, stderr: '' })
  expect(update.stdout).toContain('Installed example (disabled)')
  expect(f.installer.installed().plugins[0]?.status).toBe('disabled')
})
