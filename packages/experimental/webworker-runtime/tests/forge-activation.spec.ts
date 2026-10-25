/** Activation inspection executes without Cordis's erased const-enum export. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { FiberState } from '@deepseek-ai/cordis'
import { isForgeEntryActive } from '../src/forge/activation.ts'
import { MemoryVfs } from '../src/storage/memory.ts'
import { WorkerModuleLoader } from '../src/module-system/module-loader.ts'

it('distinguishes native active fibers from pending, failed, disposed and absent entries', () => {
  const entries = [
    { options: { id: 'hub', name: 'dsh-plugin' }, fiber: { state: FiberState.ACTIVE } },
    { options: { id: 'pending', name: 'dsh-plugin' }, fiber: { state: FiberState.PENDING } },
    { options: { id: 'failed', name: 'dsh-plugin' }, fiber: { state: FiberState.FAILED } },
    { options: { id: 'disposed', name: 'dsh-plugin' }, fiber: { state: FiberState.DISPOSED } },
    { options: { id: 'disabled', name: 'dsh-plugin' } },
  ]
  const loader = { entries: () => entries }
  expect(isForgeEntryActive(loader, 'hub', 'dsh-plugin')).toBe(true)
  for (const id of ['pending', 'failed', 'disposed', 'disabled', 'absent']) {
    expect(isForgeEntryActive(loader, id, 'dsh-plugin')).toBe(false)
  }
  expect(isForgeEntryActive(loader, 'hub', 'other-plugin')).toBe(false)
})

it('executes emitted activation code when the Worker has no runtime enum module', () => {
  const source = readFileSync(new URL('../src/forge/activation.ts', import.meta.url), 'utf8')
  const emitted = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const vfs = new MemoryVfs()
  vfs.seed('/dsh/activation.js', emitted)
  const modules = new WorkerModuleLoader({ vfs, staticModules: {
    '@deepseek-ai/cordis': () => { throw new Error('Cordis const enums have no runtime export') },
  } })
  const activation = modules.createRequire('/dsh/test.js')('./activation.js') as { isForgeEntryActive: typeof isForgeEntryActive }
  expect(activation.isForgeEntryActive({ entries: () => [
    { options: { id: 'hub', name: 'dsh-plugin' }, fiber: { state: FiberState.ACTIVE } },
  ] }, 'hub', 'dsh-plugin')).toBe(true)
})
