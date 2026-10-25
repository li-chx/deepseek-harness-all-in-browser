/** Client capabilities come from validated base-image metadata, never an install request. */
import { expect, it } from 'vitest'
import { parseImageManifest } from '../src/image-manifest.ts'
import { LOWERING_VERSION } from '../src/image-layout.ts'

const base = { root: '/dsh', profile: 'web', lowered: LOWERING_VERSION,
  javascriptEntries: 0, visitedEntries: 0, rewrittenEntries: 0, lazy: [] }

it('detaches the optional Client roster and leaves legacy images without Client declarations', () => {
  const clientPackages = { react: '18.3.1' }
  const parsed = parseImageManifest({ ...base, clientPackages }, 'manifest')
  clientPackages.react = '19.0.0'
  expect(parsed.clientPackages).toEqual({ react: '18.3.1' })
  expect(parseImageManifest(base, 'manifest').clientPackages).toBeUndefined()
})

it.each([null, [], { react: 18 }, { 'react/jsx-runtime': '18.3.1' }])('rejects malformed Client roster %j', (clientPackages) => {
  expect(() => parseImageManifest({ ...base, clientPackages }, 'manifest')).toThrow('Client platform versions')
})
