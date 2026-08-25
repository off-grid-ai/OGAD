/**
 * The vision loop's control flow, every boundary scripted: it actuates under
 * the guard, finishes on the model's `finished`, hands off on `call_user`,
 * pauses when the user takes over and resumes after, re-observes an
 * unparseable action, and stops the moment the kill switch or step budget
 * closes the guard - never actuating past it.
 */
import { describe, expect, it } from 'vitest'
import { runVisionTask, type VisionScreen, type VisionTaskDeps } from '../vision-agent'
import { VisionGuard } from '../vision-guard'

const bounds = { width: 1000, height: 1000 }

const world = (
  replies: string[],
  guard = new VisionGuard()
): {
  deps: VisionTaskDeps
  actuated: string[]
  userWaits: string[]
  guard: VisionGuard
} => {
  const actuated: string[] = []
  const userWaits: string[] = []
  const screen: VisionScreen = {
    capture: async () => ({ image: 'png', bounds }),
    actuate: async (action) => {
      actuated.push(action.type)
    }
  }
  return {
    actuated,
    userWaits,
    guard,
    deps: {
      screen,
      guard,
      ground: async () => replies.shift() ?? "finished(content='script exhausted')",
      waitForUser: async (why) => {
        userWaits.push(why)
      }
    }
  }
}

describe('runVisionTask', () => {
  it('actuates a click then finishes, reporting the summary', async () => {
    const w = world([
      "click(point='<point>500 500</point>')",
      "finished(content='shared the file')"
    ])
    const result = await runVisionTask('share the file', w.deps)
    expect(result).toMatchObject({ ok: true, summary: 'shared the file', handoffs: 0 })
    expect(w.actuated).toEqual(['click'])
    expect(w.guard.snapshot().steps).toBe(1)
  })

  it('call_user hands off and resumes after the user acts', async () => {
    const w = world([
      "call_user(content='enter your PIN')",
      "finished(content='done after the PIN')"
    ])
    const result = await runVisionTask('pay', w.deps)
    expect(result.handoffs).toBe(1)
    expect(w.userWaits).toEqual(['enter your PIN'])
    expect(result.steps.join('\n')).toContain('resumed by the user')
  })

  it('pauses when the user takes over mid-run and resumes on their signal', async () => {
    const guard = new VisionGuard()
    const w = world(["click(point='<point>1 1</point>')", "finished(content='ok')"], guard)
    // The user grabs the mouse before the first action is dispatched.
    guard.pauseForUser('you moved the mouse')
    const result = await runVisionTask('t', w.deps)
    expect(w.userWaits).toEqual(['you moved the mouse'])
    expect(result.ok).toBe(true)
    expect(result.steps.join('\n')).toContain('paused: you moved the mouse')
  })

  it('stops immediately when the kill switch is down, actuating nothing', async () => {
    const guard = new VisionGuard()
    guard.halt('stopped with Esc')
    const w = world(["click(point='<point>1 1</point>')"], guard)
    const result = await runVisionTask('t', w.deps)
    expect(result).toMatchObject({ ok: false, summary: 'stopped with Esc' })
    expect(w.actuated).toEqual([])
  })

  it('an unparseable action is re-observed, never actuated blind', async () => {
    const w = world(['not an action', "finished(content='ok')"])
    const result = await runVisionTask('t', w.deps)
    expect(result.ok).toBe(true)
    expect(w.actuated).toEqual([])
    expect(result.steps.join('\n')).toContain('did not parse')
  })

  it('the step budget stops the run after its cap', async () => {
    const guard = new VisionGuard(2)
    const w = world(
      [
        "click(point='<point>1 1</point>')",
        "click(point='<point>2 2</point>')",
        "click(point='<point>3 3</point>')"
      ],
      guard
    )
    const result = await runVisionTask('t', w.deps)
    expect(result.ok).toBe(false)
    expect(w.actuated).toHaveLength(2)
    expect(result.summary).toMatch(/2-step limit/)
  })

  it('re-checks the guard right before dispatch - a kill mid-decision actuates nothing more', async () => {
    const guard = new VisionGuard()
    const w = world(["click(point='<point>1 1</point>')"], guard)
    // Ground resolves, THEN the user hits Esc before dispatch.
    w.deps.ground = async () => {
      guard.halt('stopped with Esc')
      return "click(point='<point>1 1</point>')"
    }
    const result = await runVisionTask('t', w.deps)
    expect(w.actuated).toEqual([])
    expect(result.summary).toBe('stopped with Esc')
  })
})
