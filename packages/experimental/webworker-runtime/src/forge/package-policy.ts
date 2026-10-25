/** Trusted shared-package policy for a particular Worker image and page build. */
import { MODULE_PROXIES } from '../module-proxies.ts'
import { REPLACED_EXTERNAL_PACKAGES } from '../node/external_packages/replaced-externals.ts'

/** Whether the frontend owns a DSH or Cordis package even when it is absent from this image.
 * @param name Bare package name.
 * @returns Whether a private artifact must never replace this package.
 */
export function isForgeCorePackage(name: string): boolean {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
    || name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/cordis-')
}

function packageRoot(specifier: string): string {
  const bare = specifier.replace(/^node:/, '')
  return bare.split('/').slice(0, bare.startsWith('@') ? 2 : 1).join('/')
}

/** Derive packages whose identity belongs to the trusted frontend, including versionless runtime replacements.
 * @param hostPackages Exact package inventory captured from the base image before overlays.
 * @param clientPackages Exact shared page package inventory from the same frontend build.
 * @param staticSpecifiers Additional specifiers supplied by the running Worker's static module table.
 * @returns Sorted, unique protected package names; ordinary image libraries are omitted.
 */
export function forgeSharedPackages(hostPackages: Readonly<Record<string, string>>,
  clientPackages: Readonly<Record<string, string>>, staticSpecifiers: readonly string[] = []): string[] {
  const names = [
    ...Object.keys(hostPackages).filter(isForgeCorePackage),
    ...Object.keys(clientPackages),
    ...Object.keys(MODULE_PROXIES).filter(name => name.startsWith('node:')),
    ...REPLACED_EXTERNAL_PACKAGES,
    ...staticSpecifiers,
    'process',
  ]
  return [...new Set(names.map(packageRoot).filter(name => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)))].sort()
}
