import { describe, expect, it } from 'vitest'
import { AutomationApplication, type TaskRunSnapshot } from '@offgrid/automation'

describe('task guidance handler lifecycle', () => {
  it('is unavailable after the running task releases its handler', () => {
    const rows = new Map<string, TaskRunSnapshot>()
    const application = new AutomationApplication({
      history: {
        load: () => [...rows.values()],
        save: (snapshot) => rows.set(snapshot.taskId, snapshot),
        remove: (taskId) => rows.delete(taskId)
      },
      device: { id: 'desktop-test', name: 'Desktop test' },
      now: () => 1
    })
    application.start()
    application.record({
      taskId: 'web-running',
      kind: 'web_use',
      title: 'Running Web Use task',
      status: 'running',
      executionDeviceId: 'desktop-test'
    })

    const release = application.registerGuideHandler('web-running', () => true)
    expect(application.guideAvailability('web-running')).toEqual({ available: true })
    release()
    expect(application.guideAvailability('web-running')).toEqual({
      available: false,
      reason: 'This task cannot accept guidance yet.'
    })
  })
})
