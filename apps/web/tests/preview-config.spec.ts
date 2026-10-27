/** Deployment defaults share the URL configuration path without changing the address bar. */
import { expect, it } from 'vitest'
import { previewPageUrl, type PreviewDefaults } from '../src/preview-config.ts'
import { previewStorageOptions } from '../src/preview-storage.ts'

const defaults: PreviewDefaults = {
  'preview-fixture': 'none', forge: 'https://forge.example/builds', storage: 'indexeddb',
}

it('applies all deployment defaults without mutating the page URL', () => {
  const page = new URL('https://preview.example/preview.html?other=value#panel')
  const effective = previewPageUrl(page, defaults)
  expect(effective.searchParams.get('preview-fixture')).toBe('none')
  expect(effective.searchParams.get('forge')).toBe(defaults.forge)
  expect(effective.searchParams.get('storage')).toBe('indexeddb')
  expect(effective.searchParams.get('other')).toBe('value')
  expect(effective.hash).toBe('#panel')
  expect(page.href).toBe('https://preview.example/preview.html?other=value#panel')
  expect(previewStorageOptions(effective, new URL('preview/base.tar.gz', page), [])?.kind).toBe('indexeddb')
})

it('retains URL overrides for each deployment default, including empty values', () => {
  const page = new URL('https://preview.example/preview.html?preview-fixture=example&forge=&storage=none')
  const effective = previewPageUrl(page, defaults)
  expect(effective.href).toBe(page.href)
  expect(previewStorageOptions(effective, new URL('preview/base.tar.gz', page), [])).toBeUndefined()
})

it('preserves interactive startup when build values are absent or empty', () => {
  const page = new URL('https://preview.example/preview.html')
  expect(previewPageUrl(page, { 'preview-fixture': undefined, forge: '', storage: undefined }).href).toBe(page.href)
})

it('enables the existing Forge storage default when only the endpoint is configured', () => {
  const page = new URL('https://preview.example/preview.html')
  const effective = previewPageUrl(page, { 'preview-fixture': undefined, forge: defaults.forge, storage: undefined })
  expect(previewStorageOptions(effective, new URL('preview/base.tar.gz', page), [])?.kind).toBe('indexeddb')
})

it('rejects an invalid deployment storage mode through the existing storage parser', () => {
  const page = new URL('https://preview.example/preview.html')
  const effective = previewPageUrl(page, { ...defaults, storage: 'typo' })
  expect(() => previewStorageOptions(effective, new URL('preview/base.tar.gz', page), [])).toThrow('unknown storage mode')
})
