/** Browser-session signatures agree with Node across streamed updates and byte views. */
import { createHmac as nativeHmac } from 'node:crypto'
import { expect, it } from 'vitest'
import { createHmac, timingSafeEqual } from '../../src/node/builtin_modules/implemented/crypto.ts'

it.each(['sha1', 'sha256', 'sha512'])('signs browser-cookie payloads using %s', (algorithm) => {
  const key = Buffer.from('private fixture key')
  const expected = nativeHmac(algorithm, key).update('cookie').update('中文').digest('hex')
  const mac = createHmac(algorithm, key).update('cookie')
  key.fill(0)
  expect(mac.update('中文').digest('hex')).toBe(expected)
  expect(() => createHmac('unavailable', 'key')).toThrow('unsupported HMAC')
})

it('compares full byte views and rejects mismatched lengths', () => {
  const bytes = new Uint8Array([9, 1, 2, 8])
  expect(timingSafeEqual(bytes.subarray(1, 3), new DataView(new Uint8Array([1, 2]).buffer))).toBe(true)
  expect(timingSafeEqual(bytes.subarray(1, 3), new Uint8Array([1, 3]))).toBe(false)
  expect(timingSafeEqual(new Uint8Array(), new Uint8Array())).toBe(true)
  expect(() => timingSafeEqual(bytes, bytes.subarray(1))).toThrow('same byte length')
})
