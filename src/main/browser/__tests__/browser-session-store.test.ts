import { describe, expect, it } from 'vitest'
import { BrowserSessionStore } from '../browser-session-store'

describe('BrowserSessionStore', () => {
  it('keeps independent Chromium state for manual and agent sessions', () => {
    const store = new BrowserSessionStore<{ name: string }>()
    store.create({
      sessionId: 'manual-1',
      historyId: 'recent-1',
      kind: 'manual',
      resource: { name: 'manual view' }
    })
    store.updateChrome('manual-1', {
      url: 'https://example.com/',
      title: 'Example',
      canGoBack: true,
      canGoForward: false,
      isLoading: false
    })
    store.create({
      sessionId: 'task:research',
      kind: 'task',
      resource: { name: 'agent view' },
      task: { taskId: 'research', goal: 'Find facts', status: 'running', steps: [] }
    })

    expect(store.snapshot()).toEqual({
      activeSessionId: 'task:research',
      sessions: [
        expect.objectContaining({
          sessionId: 'manual-1',
          historyId: 'recent-1',
          kind: 'manual',
          taskId: undefined,
          status: 'open',
          title: 'Example',
          url: 'https://example.com/'
        }),
        expect.objectContaining({
          sessionId: 'task:research',
          kind: 'task',
          taskId: 'research',
          status: 'running',
          title: 'New tab'
        })
      ]
    })
    expect(store.findTask('research')?.resource.name).toBe('agent view')
  })

  it('activates, closes, and falls back without changing another session', () => {
    const store = new BrowserSessionStore<string>()
    store.create({ sessionId: 'one', kind: 'manual', resource: 'first' })
    store.create({ sessionId: 'two', kind: 'manual', resource: 'second' })
    store.create({ sessionId: 'three', kind: 'manual', resource: 'third' })

    expect(store.activate('missing')).toBe(false)
    expect(store.activate('two')).toBe(true)
    expect(store.close('two')?.resource).toBe('second')
    expect(store.snapshot().activeSessionId).toBe('three')
    expect(store.get('one')?.resource).toBe('first')
    expect(store.get('three')?.resource).toBe('third')
    expect(store.close('missing')).toBeUndefined()
  })

  it('can hide an agent session without destroying its live resource', () => {
    const store = new BrowserSessionStore<string>()
    store.create({
      sessionId: 'task:one',
      kind: 'task',
      resource: 'live agent view',
      task: { taskId: 'one', goal: 'Research', status: 'running', steps: [] }
    })

    expect(store.deactivate('task:one')).toBe(true)
    expect(store.snapshot().activeSessionId).toBeNull()
    expect(store.get('task:one')?.resource).toBe('live agent view')
  })

  it('keeps task steps immutable at the session boundary', () => {
    const store = new BrowserSessionStore<string>()
    store.create({
      sessionId: 'task:one',
      kind: 'task',
      resource: 'view',
      task: { taskId: 'one', goal: 'Research', status: 'running', steps: [] }
    })
    const steps = ['opened page']
    store.updateTask('task:one', {
      taskId: 'one',
      goal: 'Research',
      status: 'done',
      steps
    })
    steps.push('mutated outside')

    expect(store.get('task:one')?.task?.steps).toEqual(['opened page'])
    expect(() =>
      store.create({ sessionId: 'task:one', kind: 'manual', resource: 'duplicate' })
    ).toThrow(/already exists/)
  })

  it('returns every owned resource during process teardown', () => {
    const store = new BrowserSessionStore<string>()
    store.create({ sessionId: 'one', kind: 'manual', resource: 'first' })
    store.create({ sessionId: 'two', kind: 'manual', resource: 'second' })

    expect(store.clear().map((record) => record.resource)).toEqual(['first', 'second'])
    expect(store.snapshot()).toEqual({ activeSessionId: null, sessions: [] })
  })
})
