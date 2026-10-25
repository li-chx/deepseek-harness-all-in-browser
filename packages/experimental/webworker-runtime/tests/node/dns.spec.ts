/** Optional DNS imports preserve plugin fallback paths without inventing DNS behavior. */
import { expect, it, vi } from 'vitest'
import { lowerModuleSource } from '../../src/compile/transform.ts'
import { MODULE_PROXIES } from '../../src/module-proxies.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { createNodeBuiltins } from '../../src/node/builtins.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

it.each(['dns', 'node:dns'])('loads %s silently and lets a plugin catch unsupported result ordering', (specifier) => {
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const vfs = new MemoryVfs()
    const loader = new WorkerModuleLoader({ vfs, staticModules: createNodeBuiltins() })
    vfs.seed('/dsh/probe.js', lowerModuleSource({ filename: '/dsh/probe.js', source: `
      import dns, { setDefaultResultOrder } from '${specifier}'
      import dnsPromises from 'node:dns/promises'
      export const same = dns.setDefaultResultOrder === setDefaultResultOrder && dns.promises === dnsPromises
      export function fallback() {
        try { dns.setDefaultResultOrder('ipv4first'); return 'unexpected-success' }
        catch (error) { return { code: error.code, message: error.message } }
      }
      export function required() { dns.setDefaultResultOrder('ipv4first') }
    ` }).code)
    const require = loader.createRequire('/dsh/probe.js')
    const probe = require('./probe.js') as { same: boolean; fallback: () => unknown; required: () => void }
    expect(probe.same).toBe(true)
    expect(require('dns')).toBe(require('node:dns'))
    expect(require('dns/promises')).toBe(require('node:dns/promises'))
    expect(reported).not.toHaveBeenCalled()
    expect(warned).not.toHaveBeenCalled()
    expect(loader.resolve(specifier, '/dsh')).toMatchObject({ kind: 'static' })
    expect(MODULE_PROXIES[specifier]).toBe('./node/builtin_modules/optional/dns.ts')
    const refusal = {
      code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
      message: 'web-preview: node:dns.setDefaultResultOrder is not available in the worker host',
    }
    expect(probe.fallback()).toEqual(refusal)
    expect(probe.required).toThrow(expect.objectContaining(refusal))
    expect(reported).toHaveBeenCalledWith(refusal.message)
    expect(warned).not.toHaveBeenCalled()
    expect(MODULE_PROXIES['node:net']).toBe('./node/builtin_modules/mock/net.ts')
    expect(MODULE_PROXIES['node:fs']).toBe('./node/builtin_modules/implemented/fs.ts')
    expect(vfs.readFileSync('/dsh/probe.js', 'utf8')).toContain('ipv4first')
  } finally {
    reported.mockRestore()
    warned.mockRestore()
  }
})
