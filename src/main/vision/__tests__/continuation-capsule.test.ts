import { describe, expect, it } from 'vitest'
import {
  boundedContinuationCapsule,
  continuationFromTaskSteps
} from '../model-adapters/continuation-capsule'

describe('continuation capsule', () => {
  it('honors a visual-history capacity of ten outcomes', () => {
    const capsule = boundedContinuationCapsule(
      {
        done: Array.from({ length: 12 }, (_, index) => `action ${index + 1}`),
        next: 'continue',
        remember: 'avoid repeats'
      },
      10
    )

    expect(capsule.done).toEqual(Array.from({ length: 10 }, (_, index) => `action ${index + 3}`))
  })

  it('rebuilds recent semantic actions from a resumed task trace', () => {
    const capsule = continuationFromTaskSteps(
      [
        'TASK PHASE · phase-2',
        'action approved: Click reel A.',
        'click at (420, 519)',
        'Vision recovery completed one action. Returning to accessibility control.',
        'action approved: Click reel B.',
        'click at (424, 536)'
      ],
      2,
      'Open a different relevant result'
    )

    expect(capsule).toEqual({
      done: ['Attempted: Click reel A.', 'Attempted: Click reel B.'],
      next: 'Open a different relevant result',
      remember: 'Do not repeat an earlier attempted action or content target.'
    })
  })
})
