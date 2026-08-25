import { describe, expect, it } from 'vitest'
import {
  computerUseHistoryTokenBudget,
  DEFAULT_COMPUTER_USE_SETTINGS,
  normalizeComputerUseSettings,
  resolveComputerUseContextTokens,
  tailWithinTokenBudget
} from '../computer-use-settings'

describe('Computer Use settings', () => {
  it('normalizes unknown values to one safe settings object', () => {
    expect(
      normalizeComputerUseSettings({
        context: '64k',
        screenshotSize: 'huge',
        screenshotQuality: 'raw',
        checkpointInterval: 99,
        retrieveOlderVisuals: 'yes'
      })
    ).toEqual({ ...DEFAULT_COMPUTER_USE_SETTINGS, checkpointInterval: 10 })
  })

  it('clamps a selected context to the loaded model ceiling', () => {
    expect(resolveComputerUseContextTokens('32k', 16_384)).toBe(16_384)
    expect(resolveComputerUseContextTokens('16k', 32_768)).toBe(16_384)
    expect(resolveComputerUseContextTokens('auto', 24_576)).toBe(24_576)
  })

  it('keeps only complete newest history entries within the budget', () => {
    expect(tailWithinTokenBudget(['old'.repeat(20), 'middle', 'new'], 3)).toEqual(['middle', 'new'])
  })

  it('reserves most of the selected context for the current screenshot and response', () => {
    expect(computerUseHistoryTokenBudget(16_384)).toBe(4_096)
    expect(computerUseHistoryTokenBudget(32_768)).toBe(8_192)
  })
})
