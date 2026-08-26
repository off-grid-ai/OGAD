import { afterEach, describe, expect, it } from 'vitest'
import {
  hasTaskGuideHandlerForTests,
  registerTaskGuideHandler,
  resetTaskGuideHandlersForTests
} from '../task-guide'

afterEach(resetTaskGuideHandlersForTests)

describe('task guidance handler lifecycle', () => {
  it('is unavailable after the running task releases its handler', () => {
    const release = registerTaskGuideHandler('web-running', () => true)
    expect(hasTaskGuideHandlerForTests('web-running')).toBe(true)
    release()
    expect(hasTaskGuideHandlerForTests('web-running')).toBe(false)
  })
})
