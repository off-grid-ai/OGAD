import { expect, it } from 'vitest'
import { modelStartupTimeout } from '../startup-timeout'

it('allows a cold CUDA model load to finish after the normal startup limit', () => {
  expect(modelStartupTimeout('llama-cuda')).toBe(180_000)
  expect(modelStartupTimeout('llama-prism-cuda')).toBe(180_000)
})

it('keeps the normal startup limit for Vulkan and CPU engines', () => {
  expect(modelStartupTimeout('llama')).toBe(60_000)
  expect(modelStartupTimeout('llama-cpu')).toBe(60_000)
})
