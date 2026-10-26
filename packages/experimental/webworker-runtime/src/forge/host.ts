/** Worker-owned Forge routes and immutable base-image package discovery. */
import type { HttpFetch } from '../transport/http-transport.ts'
import type { MemoryVfs } from '../storage/memory.ts'
import type { WorkerModuleLoader } from '../module-system/module-loader.ts'
import type Hmr from '@deepseek-ai/dsh-hmr'
import { basename, join } from '../module-system/posix-path.ts'
import { ForgeInstaller, type ForgeInstallerOptions } from './installer.ts'
import { editForgeProfilePatch } from './profile-patch.ts'
import { ForgeError, object } from './protocol.ts'
import { ForgeCommands } from './commands.ts'
import { AiwHistory } from '../aiw/history.ts'
import { AiwWorkbench } from '../aiw/workbench.ts'
import { forgeSharedPackages as installerSharedPackages } from './package-policy.ts'

/** Snapshot package versions before plugin artifacts can be applied.
 * @param vfs Base image filesystem.
 * @param root Image root.
 * @returns Exact package versions, independent of subsequent VFS edits.
 */
export function readForgeHostPackages(vfs: MemoryVfs, root: string): Readonly<Record<string, string>> {
  const packages: Record<string, string> = {}
  const modules = join(root, 'node_modules')
  const directories: string[] = []
  for (const name of vfs.readdirSync(modules)) {
    if (name.startsWith('@')) for (const child of vfs.readdirSync(join(modules, name))) directories.push(join(modules, name, child))
    else directories.push(join(modules, name))
  }
  for (const directory of directories) {
    const path = join(directory, 'package.json')
    if (!vfs.existsSync(path)) continue
    const manifest = object(JSON.parse(vfs.readFileSync(path, 'utf8') as string))
    if (typeof manifest.name === 'string' && typeof manifest.version === 'string') packages[manifest.name] = manifest.version
  }
  return Object.freeze(packages)
}

/** Create installer state owned by a running host.
 * @param vfs Mounted filesystem.
 * @param modules Host module loader.
 * @param profileDirectory Profile holding plugin registrations.
 * @param hostPackages Immutable package roster captured before boot.
 * @param hmr Existing profile reconciliation service.
 * @param isEntryActive Reads the native Loader entry activation state.
 * @param isEntryDisabled Reads native effective entry disablement, independently of fiber activation.
 * @param fetcher Host-owned outbound HTTP.
 * @param clientPackages Trusted page-shared versions; omission declares none.
 * @param staticSpecifiers Static module names supplied by this Worker, protected against private remapping.
 * @param restoration Validated catalog and synchronous persistence batch supplied by the host.
 * @returns Installer and its Fetch route adapter.
 */
export function createForgeHost(vfs: MemoryVfs, modules: WorkerModuleLoader, profileDirectory: string,
  hostPackages: Readonly<Record<string, string>>, hmr: Pick<Hmr, 'runExclusive' | 'reconcileProfile'>,
  isEntryActive: (id: string, name: string) => boolean,
  isEntryDisabled: (id: string, name: string) => boolean,
  fetcher: HttpFetch = (input, init) => fetch(input, init),
  clientPackages: Readonly<Record<string, string>> = {},
  staticSpecifiers: readonly string[] = [],
  restoration: Pick<ForgeInstallerOptions, 'restoredCatalog' | 'withFileBatch'> = {},
): { installer: ForgeInstaller; commands: ForgeCommands; aiw: AiwWorkbench; fetch: (request: Request) => Promise<Response> } {
  const marker = profileDirectory.indexOf('/home/profiles/')
  const root = marker < 0 ? profileDirectory.slice(0, profileDirectory.lastIndexOf('/')) : profileDirectory.slice(0, marker)
  const history = new AiwHistory(vfs, `${root}/home/.aiw`, { hostPackages, clientPackages,
    sharedPackages: installerSharedPackages(hostPackages, clientPackages, staticSpecifiers) })
  const cachedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    if (url.pathname.startsWith('/v1/artifacts/')) {
      const bytes = history.object(url.pathname.slice('/v1/artifacts/'.length))
      if (bytes !== undefined) return new Response(new Uint8Array(bytes))
      if (url.hostname === 'aiw.local') throw new ForgeError('history-not-found', 'Retained plugin artifact is missing')
    }
    return fetcher(request)
  }
  const installer = new ForgeInstaller({ vfs, modules, profileDirectory, hostPackages, clientPackages, staticSpecifiers,
    ...restoration, hmr, isEntryActive, isEntryDisabled,
    beforeApply: (manifest, artifacts) => {
      const previous = installer.snapshot(manifest.plugin.id)
      if (previous !== undefined) history.capture(previous.manifest, previous.artifacts)
      history.capture(manifest, artifacts)
    },
    fetch: cachedFetch, editPatch: editForgeProfilePatch })
  installer.finishRestore()
  installer.subscribe((event) => { if (event.phase === 'activation' && event.status !== undefined) history.mark({ pluginId: event.pluginId, revision: event.revision, status: event.status }) })
  const commands = new ForgeCommands(installer, basename(profileDirectory), fetcher, (manifest, source, directory) => {
    history.stageSource(manifest.revision, { directory, files: { ...source.files,
      'forge.json': JSON.stringify({ ...source, files: Object.keys(source.files) }, null, 2) + '\n' } })
    return () => { history.unstage(manifest.revision) }
  })
  const settingsPath = `${root}/home/.aiw/settings.json`
  if (vfs.existsSync(settingsPath)) {
    const settings = object(JSON.parse(vfs.readFileSync(settingsPath, 'utf8') as string))
    if (settings.schema !== 1) throw new ForgeError('invalid-settings', 'Saved AIB settings schema is invalid')
    commands.configure(settings.baseUrl)
  }
  const aiw = new AiwWorkbench(vfs, root, profileDirectory, installer, commands, history)
  return {
    installer, commands, aiw,
    fetch: async (request) => {
      try {
        const path = new URL(request.url).pathname
        if (path === '/__forge/target' && request.method === 'GET') return Response.json(installer.target())
        if (path === '/__forge/installed' && request.method === 'GET') return Response.json(installer.installed())
        if (request.method === 'POST') {
          const body = object(await request.json())
          if (path === '/__forge/configure') return Response.json(commands.configure(body.baseUrl))
          if (path === '/__forge/install') {
            if (typeof body.baseUrl !== 'string') throw new ForgeError('invalid-url', 'Forge URL is missing')
            return Response.json(await installer.install(body.manifest, body.baseUrl, request.signal))
          }
          if (path === '/__forge/remove') return Response.json(await installer.remove(body.pluginId, request.signal))
        }
        return Response.json({ error: { code: 'not-found', message: 'Unknown Forge operation' } }, { status: 404 })
      } catch (error) {
        return Response.json({ error: { code: error instanceof ForgeError ? error.code : 'operation-failed',
          message: error instanceof Error ? error.message : String(error) } }, { status: error instanceof ForgeError ? 400 : 500 })
      }
    },
  }
}
