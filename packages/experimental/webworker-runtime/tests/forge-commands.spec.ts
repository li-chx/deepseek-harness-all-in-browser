/** Scoped virtual CLI operations report actual build, application and cancellation outcomes. */
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { ForgeCommands } from '../src/forge/commands.ts'
import { ForgeInstaller } from '../src/forge/installer.ts'
import { editForgeProfilePatch } from '../src/forge/profile-patch.ts'
import { FORGE_GENERATION, type ForgeManifest } from '../src/forge/protocol.ts'
import type { ForgeSourcePlugin } from '../src/forge/source.ts'
import { createChildProcessFacade, type WorkerChildProcess } from '../src/node/builtin_modules/implemented/child_process.ts'
import { VirtualExecutableRegistry } from '../src/shell/process/virtual-executables.ts'
import { WorkerModuleLoader } from '../src/module-system/module-loader.ts'
import { MemoryVfs } from '../src/storage/memory.ts'
import { hostFileSystem } from '../src/shell/fs-access.ts'
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
    packages: [{ id, name: 'example', version: '1.0.0', entry: 'index.js', dependencies: {}, hostDependencies: [],
      metadata: { repository: { url: 'https://github.com/example/example' },
        exports: { '.': './index.js', './client': './client/client.js' },
        dsh: { bundle: { patch: 'cordis.patch.yml' }, client: { platform: 'web', inject: ['locale'] } } },
      files: [[source, 'index.js'], [patch, 'cordis.patch.yml'], [client, 'client/client.js']].map(([text = '', path = '']) => ({ path, size: Buffer.byteLength(text), sha256: hash(text), objectKey: `${FORGE_GENERATION}/objects/${hash(text)}` })),
    }],
  }
  const calls: string[] = []
  const requests: unknown[] = []
  let rejectBuild = false
  let mutateSourceReply: ((manifest: ForgeManifest) => void) | undefined
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
      const request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { pluginId: string; plugin?: ForgeSourcePlugin }
      requests.push(request)
      if (rejectBuild) return Response.json({ error: { code: 'COMPILE_FAILED', message: 'source compilation failed' } }, { status: 400 })
      if (request.plugin !== undefined) {
        const plugin = request.plugin
        const packageId = hash(JSON.stringify(plugin))
        const compiledFiles = { ...plugin.files, ...plugin.client === undefined ? {} : {
          'forge-client.js': `window.__ModuleLoader__.load({id:${JSON.stringify(plugin.name)},factory(){return {apply(){}}}})`,
        } }
        const artifactFiles = Object.entries(compiledFiles).map(([path, value]) => {
          files.set(hash(value), value)
          return { path, size: Buffer.byteLength(value), sha256: hash(value), objectKey: `${FORGE_GENERATION}/objects/${hash(value)}` }
        })
        const built: ForgeManifest = { protocol: 1, generation: FORGE_GENERATION, revision: packageId, hostPackages: {},
          plugin: { id: plugin.id, name: plugin.name, version: plugin.version, entry: plugin.entry, packageId },
          packages: [{ id: packageId, name: plugin.name, version: plugin.version, entry: plugin.entry,
            dependencies: {}, hostDependencies: [], files: artifactFiles, ...plugin.client === undefined ? {} : {
              metadata: { dsh: { client: { platform: 'web', inject: plugin.client.inject } },
                exports: { '.': `./${plugin.entry}`, './client': './forge-client.js' } },
            } }],
        }
        mutateSourceReply?.(built)
        return Response.json(built)
      }
      return Response.json({ ...manifest, plugin: { ...manifest.plugin, id: request.pluginId } })
    }
    return new Response(files.get(url.split('/').at(-1) ?? '') ?? '', { status: 200 })
  }
  let active = true
  let disabled = false
  const installer = new ForgeInstaller({ vfs, modules, isEntryActive: () => active, isEntryDisabled: () => disabled, profileDirectory: '/dsh/home/profiles/web',
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
  return { vfs, modules, installer, commands, facade, calls, requests, entered,
    rejectBuild: (): void => { rejectBuild = true },
    changeSourceReply: (change: (manifest: ForgeManifest) => void): void => { mutateSourceReply = change },
    setActive: (value: boolean): void => { active = value },
    setDisabled: (value: boolean): void => { disabled = value }, block: (): void => { block = true } }
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

function seedSource(vfs: MemoryVfs, id = 'source-example', name = 'source-example', value = 1): void {
  vfs.seed('/dsh/workspace/plugin/forge.json', JSON.stringify({ id, name, version: '1.0.0', entry: 'src/main.ts', files: ['src/main.ts', 'data.json'] }))
  vfs.seed('/dsh/workspace/plugin/src/main.ts', `exports.name = "source-example"; exports.value = ${value}; exports.apply = () => {}`)
  vfs.seed('/dsh/workspace/plugin/data.json', '{"selected":true}')
  vfs.seed('/dsh/workspace/plugin/.env', 'not uploaded')
  vfs.seed('/dsh/workspace/plugin/unlisted.js', 'not uploaded')
}

it('builds explicit local files relative to cwd and updates the same source identity', async () => {
  const f = fixture()
  seedSource(f.vfs)
  const built = await completion(f.facade.spawn('dsh', ['plugin', '--profile', 'web', 'build', 'plugin'], { cwd: '/dsh/workspace' }))
  expect(built).toMatchObject({ code: 0, stderr: '' })
  expect(built.stdout).toContain('Installed source-example')
  expect(built.stdout).not.toContain('saved')
  expect(f.calls[0]).toBe('http://forge.local/v1/builds')
  expect(f.requests[0]).toEqual({ protocol: 1, generation: FORGE_GENERATION, plugin: {
    id: 'source-example', name: 'source-example', version: '1.0.0', entry: 'src/main.ts',
    files: { 'src/main.ts': 'exports.name = "source-example"; exports.value = 1; exports.apply = () => {}', 'data.json': '{"selected":true}' },
    dependencies: {}, peerDependencies: {},
  } })
  expect(f.modules.requireFrom('/dsh/node_modules/loader')('source-example')).toMatchObject({ value: 1 })
  seedSource(f.vfs, 'source-example', 'source-example', 2)
  const updated = await completion(f.facade.spawn('dsh', ['plugin', '--profile=web', 'build', '/dsh/workspace/plugin']))
  expect(updated.code).toBe(0)
  expect(f.installer.installed().plugins).toHaveLength(1)
  // The fixture does not run Loader HMR; invalidate its wrapper at the same seam.
  f.modules.hmrModules.invalidate(['file:///dsh/home/profiles/web/node_modules/source-example/index.js'])
  expect(f.modules.requireFrom('/dsh/node_modules/loader')('source-example')).toMatchObject({ value: 2 })
  f.rejectBuild()
  expect((await completion(f.facade.spawn('dsh', ['plugin', '--profile=web', 'build', '/dsh/workspace/plugin']))).stderr)
    .toContain('source compilation failed')
  expect(f.modules.requireFrom('/dsh/node_modules/loader')('source-example')).toMatchObject({ value: 2 })
})

function seedClientSource(vfs: MemoryVfs): void {
  seedSource(vfs)
  vfs.writeFileSync('/dsh/workspace/plugin/forge.json', JSON.stringify({ id: 'source-example', name: 'source-example',
    version: '1.0.0', entry: 'src/main.ts', files: ['src/main.ts', 'ui.tsx'], client: { entry: 'ui.tsx' } }))
  vfs.seed('/dsh/workspace/plugin/ui.tsx', 'export const apply = ctx => {};')
}

it('passes normalized Client source declarations to Forge and preserves the built Client export in the public package', async () => {
  const f = fixture()
  seedClientSource(f.vfs)
  const built = await completion(f.facade.spawn('dsh', ['plugin', '--profile=web', 'build', '/dsh/workspace/plugin']))
  expect(built).toMatchObject({ code: 0, stderr: '' })
  expect(f.requests[0]).toMatchObject({ plugin: { client: { entry: 'ui.tsx', inject: [], files: ['ui.tsx'], dependencies: {}, peerDependencies: {} },
    files: { 'ui.tsx': 'export const apply = ctx => {};' } } })
  const directory = '/dsh/home/profiles/web/node_modules/source-example'
  expect(JSON.parse(f.vfs.readFileSync(`${directory}/package.json`, 'utf8') as string)).toMatchObject({
    dsh: { client: { platform: 'web', inject: [] } }, exports: { '.': './index.js', './client': './forge-client.js' },
  })
  expect(f.vfs.readFileSync(`${directory}/forge-client.js`, 'utf8')).toContain('id:"source-example"')
  expect(built.stdout).toContain('Installed source-example')
  expect(built.stdout).not.toContain('Client activated')
})

it.each(['omitted', 'inject', 'export'] as const)('rejects a source response that changes the requested Client half: %s', async (kind) => {
  const f = fixture()
  seedClientSource(f.vfs)
  expect((await completion(f.facade.spawn('dsh', ['plugin', '--profile=web', 'build', '/dsh/workspace/plugin']))).code).toBe(0)
  const before = f.vfs.readFileSync('/dsh/home/profiles/web/node_modules/source-example/package.json', 'utf8')
  f.changeSourceReply((manifest) => {
    const root = manifest.packages[0]
    if (root?.metadata?.dsh?.client === undefined) throw Error('Fixture has no Client metadata')
    if (kind === 'omitted') delete root.metadata.dsh.client
    else if (kind === 'inject') root.metadata.dsh.client.inject.push('other-client')
    else root.metadata.exports = { '.': './src/main.ts', './client': './missing-client.js' }
  })
  const failed = await completion(f.facade.spawn('dsh', ['plugin', '--profile=web', 'build', '/dsh/workspace/plugin']))
  expect(failed).toMatchObject({ code: 1 })
  expect(failed.stderr).toContain('Forge returned')
  expect(f.vfs.readFileSync('/dsh/home/profiles/web/node_modules/source-example/package.json', 'utf8')).toBe(before)
})

it('rejects an unexpected Client half for a Host-only source request before installing', async () => {
  const f = fixture()
  seedSource(f.vfs)
  f.changeSourceReply((manifest) => {
    const root = manifest.packages[0]
    if (root === undefined) throw Error('Fixture has no root package')
    root.metadata = { dsh: { client: { platform: 'web', inject: [] } } }
  })
  const failed = await completion(f.facade.spawn('dsh', ['plugin', '--profile=web', 'build', '/dsh/workspace/plugin']))
  expect(failed).toMatchObject({ code: 1 })
  expect(failed.stderr).toContain('Forge returned')
  expect(f.installer.installed().plugins).toEqual([])
})

it('source identity collisions and invalid file selection never request a build', async () => {
  const f = fixture()
  seedSource(f.vfs)
  expect((await completion(f.facade.spawn('dsh', ['plugin', '--profile=web', 'build', '/dsh/workspace/plugin']))).code).toBe(0)
  for (const [id, name] of [['another-id', 'source-example'], ['source-example', 'another-name']]) {
    seedSource(f.vfs, id, name)
    const before = f.calls.length
    expect((await completion(f.facade.spawn('dsh', ['plugin', '--profile=web', 'build', '/dsh/workspace/plugin']))).code).toBe(1)
    expect(f.calls).toHaveLength(before)
  }
  f.vfs.writeFileSync('/dsh/workspace/plugin/forge.json', JSON.stringify({ id: 'source-example', name: 'source-example',
    version: '1.0.0', entry: '../secret.ts', files: ['../secret.ts'] }))
  const before = f.calls.length
  expect((await completion(f.facade.spawn('dsh', ['plugin', '--profile=web', 'build', '/dsh/workspace/plugin']))).code).toBe(1)
  expect(f.calls).toHaveLength(before)
  expect(f.modules.requireFrom('/dsh/node_modules/loader')('source-example')).toMatchObject({ value: 1 })
})

it('source builds share cancellation and close with published builds', async () => {
  const f = fixture()
  seedSource(f.vfs)
  f.block()
  const child = f.facade.spawn('dsh', ['plugin', '--profile=web', 'build', '/dsh/workspace/plugin'])
  const result = completion(child)
  await f.entered.promise
  await f.commands.close()
  expect(await result).toMatchObject({ code: 1 })
  expect(f.installer.installed().plugins).toEqual([])
})

it('cancels an asynchronous source read before networking and preserves the installed source plugin', async () => {
  const f = fixture()
  seedSource(f.vfs)
  expect((await completion(f.facade.spawn('dsh', ['plugin', '--profile=web', 'build', '/dsh/workspace/plugin']))).code).toBe(0)
  const before = f.calls.length
  const filesystem = hostFileSystem()
  const readText = filesystem.readText.bind(filesystem)
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const cancellation = new AbortController()
  filesystem.readText = async (path) => {
    if (path.endsWith('/main.ts')) { entered.resolve(undefined); await released.promise }
    return readText(path)
  }
  const invocation = f.commands.dsh.prepare(['plugin', '--profile=web', 'build', 'plugin'], {
    cwd: '/dsh/workspace', filesystem, signal: cancellation.signal, env: {}, output: () => {},
  })
  await entered.promise
  cancellation.abort(new Error('source read cancelled'))
  released.resolve(undefined)
  expect(await invocation).toMatchObject({ kind: 'exit', exitCode: 1, stderr: 'source read cancelled\n' })
  expect(f.calls).toHaveLength(before)
  expect(f.modules.requireFrom('/dsh/node_modules/loader')('source-example')).toMatchObject({ value: 1 })
})

it('reports disabled source activation separately from failed activation', async () => {
  const f = fixture()
  seedSource(f.vfs)
  f.setActive(false)
  f.setDisabled(true)
  const disabled = await completion(f.facade.spawn('dsh', ['plugin', '--profile=web', 'build', '/dsh/workspace/plugin']))
  expect(disabled).toMatchObject({ code: 0, stderr: '' })
  expect(disabled.stdout).toContain('Installed source-example (disabled)')
  f.setDisabled(false)
  seedSource(f.vfs, 'source-example', 'source-example', 2)
  const failed = await completion(f.facade.spawn('dsh', ['plugin', '--profile=web', 'build', '/dsh/workspace/plugin']))
  expect(failed.code).toBe(1)
  expect(failed.stdout).not.toContain('Installed source-example')
  expect(f.installer.installed().plugins[0]?.status).toBe('activation-failed')
})

it('a source command retains its configured endpoint while asynchronous source reading is pending', async () => {
  const f = fixture()
  seedSource(f.vfs)
  const filesystem = hostFileSystem()
  const readText = filesystem.readText.bind(filesystem)
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  filesystem.readText = async (path) => {
    if (path.endsWith('/main.ts')) { entered.resolve(undefined); await released.promise }
    return readText(path)
  }
  const invocation = f.commands.dsh.prepare(['plugin', '--profile=web', 'build', 'plugin'], {
    cwd: '/dsh/workspace', filesystem, signal: new AbortController().signal, env: {}, output: () => {},
  })
  await entered.promise
  f.commands.configure('http://replacement.local')
  released.resolve(undefined)
  expect(await invocation).toMatchObject({ kind: 'exit', exitCode: 0 })
  expect(f.calls[0]).toBe('http://forge.local/v1/builds')
  expect(f.calls.every(url => url.startsWith('http://forge.local/'))).toBe(true)
})

it('the model bash command path builds selected sources through the registered host executable', async () => {
  const f = fixture()
  seedSource(f.vfs)
  const script = 'cd /dsh/workspace && dsh plugin --profile web build plugin | cat > build.log && cat build.log && which ls dsh'
  const built = await completion(f.facade.spawn('bash', ['-c', script]))
  expect(built).toMatchObject({ code: 0, stderr: '' })
  expect(built.stdout).toContain('Installed source-example')
  expect(built.stdout).toContain('ls: shell built-in command')
  expect(built.stdout).toContain('dsh: shell built-in command')
  expect(f.vfs.readFileSync('/dsh/workspace/build.log', 'utf8')).toContain('Installed source-example')
  expect(f.calls[0]).toBe('http://forge.local/v1/builds')
  expect(f.modules.requireFrom('/dsh/node_modules/loader')('source-example')).toMatchObject({ value: 1 })
})

it('interrupting model bash aborts the registered build before it can install', async () => {
  const f = fixture()
  seedSource(f.vfs)
  f.block()
  const child = f.facade.spawn('bash', ['-c', 'dsh plugin --profile web build /dsh/workspace/plugin'])
  const result = completion(child)
  await f.entered.promise
  child.kill('SIGTERM')
  expect(await result).toMatchObject({ code: null, signal: 'SIGTERM' })
  expect(f.installer.installed().plugins).toEqual([])
})
