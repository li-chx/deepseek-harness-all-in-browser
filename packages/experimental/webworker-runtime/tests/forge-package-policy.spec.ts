/** Shared policy follows the trusted build, never the remote install plan. */
import { expect, it } from 'vitest'
import { forgeSharedPackages } from '../src/forge/package-policy.ts'
import { createNodeBuiltins, REPLACED_PREFIXES } from '../src/node/builtins.ts'

it('protects every actual static package root while permitting ordinary image dependency versions', () => {
  const host = { '@deepseek-ai/dsh-core': '1.0.0', '@deepseek-ai/cordis': '4.0.5', undici: '6.0.0' }
  const client = { react: '19.0.0', 'react/jsx-runtime': '19.0.0' }
  const shared = forgeSharedPackages(host, client)
  const actual = Object.keys({ ...createNodeBuiltins(), ...REPLACED_PREFIXES })
    .map(name => name.replace(/^node:/, '')).map(name => name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/'))
  expect(shared).toEqual(expect.arrayContaining([...actual, 'process', 'react', '@deepseek-ai/dsh-core', '@deepseek-ai/cordis']))
  expect(shared).not.toContain('undici')
  expect(shared).not.toContain('react/jsx-runtime')
  expect(shared).toEqual([...new Set(shared)].sort())
  const custom = forgeSharedPackages(host, client, ['custom-runtime/entry', 'cordis:group'])
  expect(custom).toContain('custom-runtime')
  expect(custom).not.toContain('cordis:group')
})
