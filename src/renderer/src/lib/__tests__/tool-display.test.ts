import { describe, expect, it } from 'vitest'
import { productToolName, runningToolLabel } from '../tool-display'

describe('tool display names', () => {
  it.each([
    ['web_task', 'Web Use'],
    ['web_use', 'Web Use'],
    ['computer_task', 'Computer Use'],
    ['computer_use', 'Computer Use'],
    ['pro:web_task', 'Web Use']
  ])('maps %s to its product name', (internalName, productName) => {
    expect(productToolName(internalName)).toBe(productName)
  })

  it('uses the product name in live activity', () => {
    expect(runningToolLabel('web_task')).toBe('Running Web Use…')
  })
})
