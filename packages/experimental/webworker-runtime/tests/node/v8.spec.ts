/** Optional heap statistics let plugins retain their explicit unavailable-measurement policy. */
import { expect, it, vi } from 'vitest'
import { lowerModuleSource } from '../../src/compile/transform.ts'
import { MODULE_PROXIES } from '../../src/module-proxies.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { createNodeBuiltins } from '../../src/node/builtins.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

it.each(['v8', 'node:v8'])('loads %s silently and preserves caught and uncaught statistics failures', async (specifier) => {
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const vfs = new MemoryVfs()
    const loader = new WorkerModuleLoader({ vfs, staticModules: createNodeBuiltins() })
    vfs.seed('/dsh/probe.js', lowerModuleSource({ filename: '/dsh/probe.js', source: `
      import v8, { getHeapStatistics } from '${specifier}'
      export const same = v8.getHeapStatistics === getHeapStatistics
      export function required() { return getHeapStatistics() }
      function available() {
        try {
          const { used_heap_size: used, heap_size_limit: limit } = getHeapStatistics()
          return !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0 || used < limit * 2 / 3
        } catch { return true }
      }
      let pending = Promise.resolve()
      export function admit(work) {
        const task = pending.then(() => available() ? work() : undefined)
        pending = task.then(() => undefined, () => undefined)
        return task
      }
    ` }).code)
    const require = loader.createRequire('/dsh/probe.js')
    const probe = require('./probe.js') as {
      same: boolean
      required: () => unknown
      admit: (work: () => Promise<string>) => Promise<string | undefined>
    }
    expect(probe.same).toBe(true)
    expect(require('v8')).toBe(require('node:v8'))
    expect(reported).not.toHaveBeenCalled()
    expect(warned).not.toHaveBeenCalled()
    expect(loader.resolve(specifier, '/dsh')).toMatchObject({ kind: 'static' })
    expect(MODULE_PROXIES[specifier]).toBe('./node/builtin_modules/optional/v8.ts')
    expect(probe.required).toThrow(expect.objectContaining({
      code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
      message: 'web-preview: node:v8.getHeapStatistics is not available in the worker host',
    }))
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<string>()
    const order: string[] = []
    const first = probe.admit(() => { order.push('first'); started.resolve(undefined); return release.promise })
    const second = probe.admit(() => { order.push('second'); return Promise.resolve('second result') })
    try {
      await started.promise
      expect(order).toEqual(['first'])
    } finally {
      release.resolve('first result')
      await Promise.all([first, second])
    }
    expect(await first).toBe('first result')
    expect(await second).toBe('second result')
    expect(order).toEqual(['first', 'second'])
    expect(reported).toHaveBeenCalledTimes(3)
    expect(warned).not.toHaveBeenCalled()
    expect(MODULE_PROXIES['node:vm']).toBe('./node/builtin_modules/mock/vm.ts')
  } finally {
    reported.mockRestore()
    warned.mockRestore()
  }
})
