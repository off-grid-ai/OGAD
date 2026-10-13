import { expect, it } from 'vitest'
import { modelStartupQuietLimit, startupStalled } from '../startup-timeout'

it.each(['llama', 'llama-cpu', 'llama-cuda', 'llama-prism', 'llama-prism-cuda'])(
  'allows %s to load from a slow drive without output for several minutes',
  (engine) => {
    const quietLimit = modelStartupQuietLimit(engine)
    expect(startupStalled(61_000, 0, quietLimit)).toBe(false)
    expect(startupStalled(181_000, 0, quietLimit)).toBe(false)
    expect(startupStalled(599_000, 0, quietLimit)).toBe(false)
    expect(startupStalled(600_000, 0, quietLimit)).toBe(false)
    expect(startupStalled(600_001, 0, quietLimit)).toBe(true)
  }
)

it('starts the quiet period again when the engine prints progress', () => {
  const quietLimit = modelStartupQuietLimit('llama')
  expect(startupStalled(900_000, 595_000, quietLimit)).toBe(false)
  expect(startupStalled(1_195_001, 595_000, quietLimit)).toBe(true)
})

it('keeps waiting on a slow load that still prints progress, however long it takes', () => {
  const start = 0
  // Ten minutes in, but the server wrote a line 5 seconds ago.
  expect(startupStalled(start + 600_000, start + 595_000, 60_000)).toBe(false)
})

it('gives up on a server that has gone silent past the quiet limit', () => {
  expect(startupStalled(61_000, 0, 60_000)).toBe(true)
  expect(startupStalled(60_000, 0, 60_000)).toBe(false)
})
