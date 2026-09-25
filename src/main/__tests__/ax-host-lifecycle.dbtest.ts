import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  emitState: vi.fn(),
  emitStep: vi.fn(),
  hide: vi.fn(),
  capture: vi.fn(),
  choose: vi.fn(),
  preparePlan: vi.fn(),
  registerGuide: vi.fn(),
  registerSession: vi.fn(),
  runElementTask: vi.fn(),
  show: vi.fn(),
  shutdown: vi.fn(),
  start: vi.fn(),
  settings: vi.fn()
}))

vi.mock('electron', () => ({
  screen: { getAllDisplays: () => [{}] },
  systemPreferences: {
    getMediaAccessStatus: () => 'granted',
    isTrustedAccessibilityClient: () => true
  }
}))
vi.mock('@offgrid/automation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@offgrid/automation')>()),
  automationTaskReadStatus: () => 'done',
  selectApplicationTarget: vi.fn()
}))
vi.mock('../llm', () => ({
  llm: {
    activeModelInfo: () => ({ id: 'offgrid/chat', vision: true }),
    effectiveContextSize: () => 16_384,
    chat: vi.fn(async () => '{"fill":true,"text":"hello","submit":false}')
  }
}))
vi.mock('../input/actuation', () => ({
  loadActuation: () => ({
    moveMouse: vi.fn(),
    click: vi.fn(),
    scrollBy: vi.fn(),
    tapKeys: vi.fn(),
    typeText: vi.fn()
  })
}))
vi.mock('../accessibility/ax-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../accessibility/ax-agent')>()
  return { ...actual, runElementTask: mocks.runElementTask }
})
vi.mock('../vision/vision-controller', () => ({
  controlVisionTask: vi.fn(),
  emitVisionState: mocks.emitState,
  emitVisionStep: mocks.emitStep,
  registerVisionSession: mocks.registerSession,
  waitForVisionUser: vi.fn()
}))
vi.mock('../vision/supervisor-window', () => ({
  hideSupervisorWindow: mocks.hide,
  showSupervisorWindow: mocks.show
}))
vi.mock('../computer-use-settings', () => ({ getComputerUseSettings: mocks.settings }))
vi.mock('../tasks/task-history', () => ({
  getTaskRun: vi.fn(),
  recordTaskRun: vi.fn()
}))
vi.mock('../tasks/task-execution-plan-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tasks/task-execution-plan-service')>()
  return { ...actual, prepareTaskExecutionPlan: mocks.preparePlan }
})
vi.mock('../tasks/task-guide', () => ({ registerTaskGuideHandler: mocks.registerGuide }))
vi.mock('../models-manager', () => ({
  listInstalled: vi.fn(async () => ['offgrid/default-decider']),
  resolveComputerUseModelArtifact: vi.fn(async () => ({ primaryPath: '/model.gguf' })),
  resolveModelIdentity: vi.fn(async (modelId: string) => ({ modelId, modelName: modelId }))
}))
vi.mock('../accessibility/decision-model-loader', () => ({
  decideWithDecisionModel: vi.fn(),
  selectedDecisionModelId: () => 'offgrid/default-decider',
  withDecisionModel: vi.fn(async (task) => task())
}))
vi.mock('../vision/grounder-loader', () => ({
  selectedGrounderModelId: () => 'offgrid/grounder'
}))
vi.mock('../vision/remote-vision-server', () => ({
  getRemoteVisionServerForModel: () => null
}))
vi.mock('../vision/computer-use-preflight', () => ({
  computerUsePreflight: () => ({ ok: true })
}))
vi.mock('../accessibility/decision-runtime', () => ({
  decisionRuntime: { start: mocks.start, shutdown: mocks.shutdown },
  DecisionRuntimeError: class DecisionRuntimeError extends Error {
    code = 'startup'
  }
}))
vi.mock('../actions/remote-screen-session', () => ({
  currentRemoteScreenTaskSession: () => null,
  recordComputerUseMetric: vi.fn(),
  recordComputerUseModelCall: vi.fn()
}))
vi.mock('../vision/visual-context', () => ({ recentVisualFacts: () => [] }))
vi.mock('../accessibility/ax-observation', () => ({
  persistAxFrame: vi.fn(),
  persistAxObservation: vi.fn()
}))
vi.mock('../accessibility/ax-frame', () => ({ captureAxObservationFrame: mocks.capture }))
vi.mock('../accessibility/ax-helper', () => ({ accessibilityHelperPath: () => '/helper' }))
vi.mock('../accessibility/native-app-macos', () => ({
  createMacNativeAppPlatform: vi.fn(),
  resolveMacDefaultBrowser: vi.fn()
}))
vi.mock('../accessibility/ax-decision', () => ({
  chooseFactorizedElementStep: mocks.choose
}))
vi.mock('../ocr', () => ({
  runBoxedOCR: vi.fn(async () => ({ width: 100, height: 100, blocks: [], available: true }))
}))

import { getAxRailHost } from '../accessibility/ax-host'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.registerSession.mockReturnValue(vi.fn())
  mocks.registerGuide.mockReturnValue(vi.fn())
  mocks.settings.mockReturnValue({
    modelStrategy: 'decision_plus_specialist',
    context: 'auto',
    checkpointInterval: 8,
    retrieveOlderVisuals: false,
    visualHistoryFrames: 1
  })
  mocks.capture.mockResolvedValue({
    capture: {
      path: '/tmp/frame.png',
      width: 100,
      height: 100,
      displayBounds: { x: 0, y: 0, width: 100, height: 100 }
    }
  })
  mocks.choose.mockResolvedValue({
    step: { action: 'key', keys: 'Enter' },
    result: { combinedConfidence: 0.9, probabilityMargin: 0.8, entropy: 0.1 }
  })
  mocks.preparePlan.mockResolvedValue({
    version: 1,
    phases: [{ id: 'phase-1', title: 'Complete the task' }]
  })
  mocks.runElementTask.mockImplementation(async (_goal, deps) => {
    const snapshot = await deps.read()
    await deps.decideElement?.(
      'Current milestone: Complete the task',
      snapshot,
      { id: 'phase-1', title: 'Complete the task' },
      false,
      false
    )
    deps.onStep?.('pressed Enter')
    deps.onCheckpoint?.(1, ['pressed Enter'])
    deps.onObservation?.({
      step: 1,
      prompt: 'prompt',
      retrievedFacts: [],
      durationMs: 1,
      result: 'actuated'
    })
    return { ok: true, summary: 'completed', steps: ['done'] }
  })
})

describe('AX host lifecycle', () => {
  it('admits a safe task, runs the shared element loop, and releases its owners', async () => {
    const result = await getAxRailHost().runTask('Draft a note', 'task-1', 'Notes', {
      windowTitle: 'Notes',
      windowId: 'window-1',
      processId: 42,
      elements: []
    })

    expect(result).toEqual({ ok: true, summary: 'completed', steps: ['done'] })
    expect(mocks.preparePlan).toHaveBeenCalledWith(
      expect.objectContaining({ goal: 'Draft a note', surface: 'computer', targetLabel: 'Notes' }),
      expect.any(Function)
    )
    expect(mocks.runElementTask).toHaveBeenCalledWith(
      'Draft a note',
      expect.objectContaining({ plan: expect.objectContaining({ version: 1 }) })
    )
    expect(mocks.show).toHaveBeenCalled()
    expect(mocks.hide).toHaveBeenCalled()
    expect(mocks.emitState).toHaveBeenLastCalledWith(
      expect.objectContaining({ taskId: 'task-1', status: 'done', summary: 'completed' })
    )
  })

  it('converts an unavailable vision recovery into an actionable failure', async () => {
    mocks.runElementTask.mockResolvedValueOnce({
      ok: false,
      summary: 'needs vision',
      steps: [],
      recovery: 'vision'
    })
    await expect(
      getAxRailHost().runTask('Open canvas item', 'task-2', 'Canvas', {
        windowTitle: 'Canvas',
        elements: []
      })
    ).resolves.toMatchObject({
      ok: false,
      summary: expect.stringContaining('Vision recovery is unavailable')
    })
  })

  it('uses the bounded writer for an editable field with planned public text', async () => {
    mocks.choose.mockResolvedValueOnce({
      step: { action: 'vision_required', why: 'A bounded free-text writer is required.' },
      writerTargetIndex: 1,
      result: { combinedConfidence: 0.8, probabilityMargin: 0.5, entropy: 0.2 }
    })
    mocks.runElementTask.mockImplementationOnce(async (_goal, deps) => {
      const decision = await deps.decideElement?.(
        'Current milestone: Write the note',
        {
          windowTitle: 'Notes',
          elements: [
            {
              index: 1,
              role: 'AXTextField',
              name: 'Body',
              value: '',
              x: 10,
              y: 10,
              width: 200,
              height: 40,
              cx: 110,
              cy: 30,
              enabled: true,
              actionable: true,
              executable: true
            }
          ]
        },
        {
          id: 'phase-write',
          title: 'Write the note',
          operation: { kind: 'type', value: 'hello world' }
        },
        false,
        false
      )
      expect(JSON.parse(decision ?? '{}')).toMatchObject({
        action: 'type',
        index: 1,
        text: 'hello world'
      })
      return { ok: true, summary: 'written', steps: ['typed'] }
    })

    await expect(
      getAxRailHost().runTask('Write a note', 'task-writer', 'Notes', {
        windowTitle: 'Notes',
        elements: []
      })
    ).resolves.toMatchObject({ ok: true, summary: 'written' })
  })

  it('refuses planned text for a private field', async () => {
    mocks.choose.mockResolvedValueOnce({
      step: { action: 'vision_required', why: 'A bounded free-text writer is required.' },
      writerTargetIndex: 2,
      result: { combinedConfidence: 0.7, probabilityMargin: 0.4, entropy: 0.3 }
    })
    mocks.runElementTask.mockImplementationOnce(async (_goal, deps) => {
      const decision = await deps.decideElement?.(
        'Current milestone: Enter the secret',
        {
          windowTitle: 'Login',
          elements: [
            {
              index: 2,
              role: 'AXSecureTextField',
              name: 'Password',
              value: '',
              cx: 100,
              cy: 100,
              enabled: true,
              actionable: true,
              executable: true,
              risk: 'private'
            }
          ]
        },
        {
          id: 'phase-secret',
          title: 'Enter the secret',
          operation: { kind: 'type', value: 'do-not-type' }
        },
        false,
        false
      )
      expect(JSON.parse(decision ?? '{}')).toMatchObject({
        action: 'human_required',
        why: 'The field needs private input.'
      })
      return { ok: false, summary: 'private input required', steps: [] }
    })

    await expect(
      getAxRailHost().runTask('Log in', 'task-private', 'Login', {
        windowTitle: 'Login',
        elements: []
      })
    ).resolves.toMatchObject({ ok: false, summary: 'private input required' })
  })

  it('escalates a failed specialist recovery to the heavy reasoner', async () => {
    const recover = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, detail: 'no grounded action' })
      .mockResolvedValueOnce({
        ok: true,
        performedActions: [{ type: 'key', keys: 'Enter' }]
      })
    mocks.runElementTask.mockImplementationOnce(async (_goal, deps) => {
      const recovered = await deps.recoverWithVision?.({
        summary: 'The accessibility action stalled.',
        steps: ['opened the app'],
        guidance: ['Use the visible button'],
        currentStep: 3
      })
      expect(recovered).toMatchObject({ ok: true })
      return { ok: true, summary: 'recovered', steps: ['opened the app'] }
    })

    await expect(
      getAxRailHost().runTask(
        'Open the visible item',
        'task-recovery',
        'Canvas',
        { windowTitle: 'Canvas', elements: [] },
        { recoverWithVision: recover }
      )
    ).resolves.toMatchObject({ ok: true, summary: 'recovered' })
    expect(recover).toHaveBeenCalledTimes(2)
    expect(recover.mock.calls[0]?.[1]).toMatchObject({ specialistOnly: true })
    expect(recover.mock.calls[1]?.[1]).toMatchObject({ reasonerOnly: true })
  })

  it('executes the supported accessibility actuator operations', async () => {
    mocks.runElementTask.mockImplementationOnce(async (_goal, deps) => {
      deps.control.markObservationReady()
      const element = {
        index: 1,
        role: 'AXTextField',
        name: 'Message',
        value: 'old text',
        cx: 120,
        cy: 80,
        enabled: true,
        actionable: true
      }
      await deps.actuator.click(element)
      await deps.actuator.hover(element)
      await deps.actuator.press(element)
      await deps.actuator.scroll(element, 'up')
      return { ok: true, summary: 'acted', steps: ['updated the message'] }
    })

    await expect(
      getAxRailHost().runTask('Update the message', 'task-actuator', 'Notes', {
        windowTitle: 'Notes',
        elements: []
      })
    ).resolves.toMatchObject({ ok: true, summary: 'acted' })
  })

  it('types, presses keys, and rejects unavailable native value control', async () => {
    mocks.runElementTask.mockImplementationOnce(async (_goal, deps) => {
      deps.control.markObservationReady()
      const element = {
        index: 1,
        role: 'AXTextField',
        name: 'Message',
        value: 'old text',
        cx: 120,
        cy: 80,
        enabled: true,
        actionable: true
      }
      await deps.actuator.scroll(element, 'left')
      await deps.actuator.type(element, 'new text')
      await deps.actuator.type(undefined, 'continued text')
      await deps.actuator.keys('Enter')
      return { ok: true, summary: 'acted', steps: ['updated the message'] }
    })

    await expect(
      getAxRailHost().runTask('Type the message', 'task-typing', 'Notes', {
        windowTitle: 'Notes',
        elements: []
      })
    ).resolves.toMatchObject({ ok: true, summary: 'acted' })
  })

  it('covers reverse scrolling and unavailable native value control', async () => {
    mocks.runElementTask.mockImplementationOnce(async (_goal, deps) => {
      deps.control.markObservationReady()
      const element = {
        index: 1,
        role: 'AXSlider',
        name: 'Volume',
        value: '50',
        cx: 120,
        cy: 80,
        enabled: true,
        actionable: true
      }
      await deps.actuator.scroll(element, 'down')
      await deps.actuator.scroll(element, 'right')
      await expect(deps.actuator.setValue(element, 75)).rejects.toThrow('ENOENT')
      return { ok: true, summary: 'acted', steps: ['checked the slider'] }
    })

    await expect(
      getAxRailHost().runTask('Adjust volume', 'task-slider', 'Settings', {
        windowTitle: 'Settings',
        elements: []
      })
    ).resolves.toMatchObject({ ok: true, summary: 'acted' })
  })
})
