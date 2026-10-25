/** Worker-owned Forge routes and immutable base-image package discovery. */
import type { HttpFetch } from '../transport/http-transport.ts'
import type { MemoryVfs } from '../storage/memory.ts'
import type { WorkerModuleLoader } from '../module-system/module-loader.ts'
import type Hmr from '@deepseek-ai/dsh-hmr'
import { basename, join } from '../module-system/posix-path.ts'
import { ForgeInstaller } from './installer.ts'
import { editForgeProfilePatch } from './profile-patch.ts'
import { ForgeError, object } from './protocol.ts'
import { ForgeCommands } from './commands.ts'

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
 * @returns Installer and its Fetch route adapter.
 */
export function createForgeHost(vfs: MemoryVfs, modules: WorkerModuleLoader, profileDirectory: string,
  hostPackages: Readonly<Record<string, string>>, hmr: Pick<Hmr, 'runExclusive' | 'reconcileProfile'>,
  isEntryActive: (id: string, name: string) => boolean,
  isEntryDisabled: (id: string, name: string) => boolean,
  fetcher: HttpFetch = (input, init) => fetch(input, init),
  clientPackages: Readonly<Record<string, string>> = {},
): { installer: ForgeInstaller; commands: ForgeCommands; fetch: (request: Request) => Promise<Response> } {
  const installer = new ForgeInstaller({ vfs, modules, profileDirectory, hostPackages, clientPackages, hmr, isEntryActive, isEntryDisabled,
    fetch: fetcher, editPatch: editForgeProfilePatch })
  const commands = new ForgeCommands(installer, basename(profileDirectory), fetcher)
  return {
    installer, commands,
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
