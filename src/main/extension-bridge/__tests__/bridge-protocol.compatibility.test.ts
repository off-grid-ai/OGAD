import { expect, it } from 'vitest'
import { pairingCode } from '../bridge-protocol'

it('preserves the pairing words used by the existing extension for mixed-case keys', async () => {
  expect(await pairingCode('Z-key', 'a-key')).toBe('hand-mode-maps-barn-cube-moth')
  expect(await pairingCode('a-key', 'Z-key')).toBe('hand-mode-maps-barn-cube-moth')
})
