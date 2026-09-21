import { describe, it, expect } from 'vitest'
import { reserveForRam, evaluateMemoryGuard } from '../memory-guard'

describe('reserveForRam', () => {
  it('reserves 4GB on small machines (<=10GB) so an 8GB box is not blocked outright', () => {
    expect(reserveForRam(8)).toBe(4)
    expect(reserveForRam(10)).toBe(4) // boundary
  })
  it('reserves 6GB above 10GB', () => {
    expect(reserveForRam(16)).toBe(6)
    expect(reserveForRam(10.5)).toBe(6)
  })
})

describe('evaluateMemoryGuard', () => {
  it('Core ML is exempt: modelGb is 0 and never over budget', () => {
    const r = evaluateMemoryGuard({ totalGb: 8, modelSizeGb: 20, coreml: true, zImageStack: false })
    expect(r.modelGb).toBe(0)
    expect(r.overBudget).toBe(false)
  })

  it('standard GGUF: footprint is size * 1.4, budget is total - reserve (under-budget branch)', () => {
    // 16GB machine, reserve 6 -> budget 10. A 2GB model -> 2.8GB resident, fits.
    const r = evaluateMemoryGuard({
      totalGb: 16,
      modelSizeGb: 2,
      coreml: false,
      zImageStack: false
    })
    expect(r.reserveGb).toBe(6)
    expect(r.budgetGb).toBe(10)
    expect(r.modelGb).toBeCloseTo(2.8, 5)
    expect(r.overBudget).toBe(false)
  })

  it('standard GGUF over budget: a large model on a small machine is refused (over branch)', () => {
    // 8GB machine, reserve 4 -> budget 4. A 6GB model -> 8.4GB resident, refused.
    const r = evaluateMemoryGuard({ totalGb: 8, modelSizeGb: 6, coreml: false, zImageStack: false })
    expect(r.budgetGb).toBe(4)
    expect(r.modelGb).toBeCloseTo(8.4, 5)
    expect(r.overBudget).toBe(true)
  })

  it('exact budget boundary is NOT over (strictly greater refuses)', () => {
    // total 10.6, reserve 6 -> budget 4.6. model 3.285714... * 1.4 -> exactly budget.
    const modelSizeGb = 4.6 / 1.4
    const r = evaluateMemoryGuard({ totalGb: 10.6, modelSizeGb, coreml: false, zImageStack: false })
    expect(r.modelGb).toBeCloseTo(4.6, 5)
    expect(r.overBudget).toBe(false)
  })

  it('Z-Image stack counts encoder + VAE, not just the diffusion file', () => {
    // 16GB -> budget 10. diffusion 2 + encoder 3 + vae 0.3 = 5.3 * 1.4 = 7.42, fits.
    const r = evaluateMemoryGuard({
      totalGb: 16,
      modelSizeGb: 2,
      coreml: false,
      zImageStack: true,
      zEncoderGb: 3,
      zVaeGb: 0.3
    })
    expect(r.modelGb).toBeCloseTo(7.42, 5)
    expect(r.overBudget).toBe(false)
  })

  it('Z-Image stack can push a combo over budget that the diffusion file alone would pass', () => {
    // diffusion 2GB alone would be 2.8 (fits budget 10). With a 6GB encoder + 1GB vae
    // the real stack is 9 * 1.4 = 12.6 -> over budget, correctly refused.
    const r = evaluateMemoryGuard({
      totalGb: 16,
      modelSizeGb: 2,
      coreml: false,
      zImageStack: true,
      zEncoderGb: 6,
      zVaeGb: 1
    })
    expect(r.modelGb).toBeCloseTo(12.6, 5)
    expect(r.overBudget).toBe(true)
  })

  it('counts the complete Qwen-Image 2.1 stack', () => {
    const result = evaluateMemoryGuard({
      totalGb: 24,
      modelSizeGb: 4.2,
      coreml: false,
      zImageStack: false,
      qwenImageStack: true,
      qwenEncoderGb: 5,
      qwenVisionGb: 1.1,
      qwenVaeGb: 0.7
    })
    expect(result.modelGb).toBeCloseTo(15.4)
    expect(result.overBudget).toBe(false)
  })

  it('ignores encoder/VAE sizes when the stack flag is off', () => {
    const r = evaluateMemoryGuard({
      totalGb: 16,
      modelSizeGb: 2,
      coreml: false,
      zImageStack: false,
      zEncoderGb: 99,
      zVaeGb: 99
    })
    expect(r.modelGb).toBeCloseTo(2.8, 5)
  })
})
