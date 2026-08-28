import { describe, expect, it } from 'vitest'
import {
  applyRemoteTaskControl,
  type RemoteTaskControlKind,
  type TaskControlRuntime
} from '../remote-task-control'

function boundary(): { runtime: TaskControlRuntime; received: string[] } {
  const received: string[] = []
  return {
    received,
    runtime: {
      stopWebTask: (taskId) => {
        received.push(`web:stop:${taskId}`)
        return true
      },
      controlVisionTask: (command, taskId) => {
        received.push(`guard:${command}:${taskId}`)
        return true
      }
    }
  }
}

describe('remote task control routing', () => {
  it.each<RemoteTaskControlKind>(['pause', 'resume', 'take_over'])(
    'uses the shared task guard for %s on both task kinds',
    (control) => {
      const web = boundary()
      const computer = boundary()
      expect(applyRemoteTaskControl('web-1', 'web_use', control, web.runtime)).toBe(true)
      expect(applyRemoteTaskControl('computer-1', 'computer_use', control, computer.runtime)).toBe(
        true
      )
      const expected = control === 'take_over' ? 'takeover' : control
      expect(web.received).toEqual([`guard:${expected}:web-1`])
      expect(computer.received).toEqual([`guard:${expected}:computer-1`])
    }
  )

  it('stops Web Use through the BrowserHost lease owner', () => {
    const { runtime, received } = boundary()
    expect(applyRemoteTaskControl('web-1', 'web_use', 'stop', runtime)).toBe(true)
    expect(received).toEqual(['web:stop:web-1'])
  })

  it('stops Computer Use through its task guard', () => {
    const { runtime, received } = boundary()
    expect(applyRemoteTaskControl('computer-1', 'computer_use', 'stop', runtime)).toBe(true)
    expect(received).toEqual(['guard:stop:computer-1'])
  })
})
