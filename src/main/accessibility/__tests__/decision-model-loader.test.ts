import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  webSettings: vi.fn(),
  session: vi.fn(),
  installed: vi.fn(),
  load: vi.fn(),
  remote: vi.fn(),
  parseRemoteId: vi.fn(),
  openRouter: vi.fn(),
  useOpenRouter: vi.fn(),
  recordMetric: vi.fn(),
  recordCall: vi.fn(),
  runtime: {
    running: false,
    start: vi.fn(),
    shutdown: vi.fn(),
    decide: vi.fn()
  },
  llm: {
    activeModelInfo: vi.fn(),
    restart: vi.fn(),
    restoreSelectedModel: vi.fn(),
    decideOptions: vi.fn(),
    chatMessages: vi.fn()
  },
  DecisionRuntimeError: class DecisionRuntimeError extends Error {
    constructor(
      message: string,
      readonly code: 'missing' | 'startup' | 'out_of_memory'
    ) {
      super(message)
    }
  }
}))

vi.mock('../../llm', () => ({ llm: mocks.llm }))
vi.mock('../../computer-use-settings', () => ({ getComputerUseSettings: mocks.settings }))
vi.mock('../../web-use-settings', () => ({ getWebUseSettings: mocks.webSettings }))
vi.mock('../../models-manager', () => ({
  DECIDER_2B: { id: 'offgrid/default-decider' },
  KEV_4B_ID: 'offgrid/kev-4b',
  listInstalled: mocks.installed,
  loadComputerUseModel: mocks.load
}))
vi.mock('../decision-runtime', () => ({
  decisionRuntime: mocks.runtime,
  DecisionRuntimeError: mocks.DecisionRuntimeError
}))
vi.mock('../../../shared/remote-vision-server', () => ({
  parseRemoteVisionModelId: mocks.parseRemoteId
}))
vi.mock('../../actions/remote-screen-session', () => ({
  currentRemoteScreenTaskSession: mocks.session,
  runWithRemoteScreenTaskSession: vi.fn(async (_session, task) => task()),
  recordComputerUseMetric: mocks.recordMetric,
  recordComputerUseModelCall: mocks.recordCall
}))
vi.mock('../../vision/remote-vision-server', () => ({
  getRemoteVisionServerForModel: mocks.remote
}))
vi.mock('../remote-decision', () => ({
  decideWithOpenRouter: mocks.openRouter,
  usesOpenRouterDecisions: mocks.useOpenRouter
}))

import {
  decideWithDecisionModel,
  parseRemoteDecision,
  selectedDecisionModelId,
  withDecisionModel,
  withReasoningModel
} from '../decision-model-loader'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockReturnValue(null)
  mocks.webSettings.mockReturnValue({ decisionModelId: 'offgrid/kev-4b' })
  mocks.settings.mockReturnValue({
    decisionModelId: 'offgrid/selected-decider',
    modelStrategy: 'decision_plus_specialist'
  })
  mocks.installed.mockResolvedValue(['offgrid/selected-decider'])
  mocks.load.mockResolvedValue({ success: true })
  mocks.remote.mockReturnValue(null)
  mocks.parseRemoteId.mockReturnValue(null)
  mocks.useOpenRouter.mockReturnValue(false)
  mocks.runtime.running = false
  mocks.runtime.start.mockImplementation(async () => {
    mocks.runtime.running = true
  })
  mocks.runtime.shutdown.mockImplementation(async () => {
    mocks.runtime.running = false
  })
  mocks.runtime.decide.mockResolvedValue({ choice: 0, confidence: 1, probabilities: [1, 0] })
  mocks.llm.activeModelInfo.mockReturnValue({ id: 'offgrid/chat' })
  mocks.llm.restart.mockResolvedValue(undefined)
  mocks.llm.decideOptions.mockResolvedValue({ choice: 1, confidence: 1, probabilities: [0, 1] })
  mocks.llm.chatMessages.mockResolvedValue('{"choice":1,"probabilities":[1,3]}')
  mocks.recordCall.mockResolvedValue(undefined)
})

describe('decision model lifecycle', () => {
  it('uses Web Use Kev for loading and decisions, not the Computer Use model', async () => {
    mocks.session.mockReturnValue({ taskKind: 'web_use' })
    mocks.installed.mockResolvedValue(['offgrid/kev-4b'])
    expect(selectedDecisionModelId()).toBe('offgrid/kev-4b')
    await withDecisionModel(() => decideWithDecisionModel('page', 'next?', ['A', 'B']))
    expect(mocks.runtime.start).toHaveBeenCalledWith('offgrid/kev-4b')
    expect(mocks.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'offgrid/kev-4b' })
    )
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('does not inherit the Computer Use selection when Web Use has no selection', () => {
    mocks.session.mockReturnValue({ taskKind: 'web_use' })
    mocks.webSettings.mockReturnValue({ decisionModelId: null })
    expect(selectedDecisionModelId()).toBe('offgrid/default-decider')
    mocks.session.mockReturnValue({ taskKind: 'computer_use' })
    expect(selectedDecisionModelId()).toBe('offgrid/selected-decider')
  })
  it('selects the configured model and requires it to be installed', async () => {
    expect(selectedDecisionModelId()).toBe('offgrid/selected-decider')
    mocks.settings.mockReturnValueOnce({ decisionModelId: null })
    expect(selectedDecisionModelId()).toBe('offgrid/default-decider')

    mocks.installed.mockResolvedValueOnce([])
    await expect(withDecisionModel(async () => 'never')).rejects.toThrow('not downloaded')
  })

  it('keeps one dedicated runtime for nested decisions and shuts it down afterward', async () => {
    const result = await withDecisionModel(async () => {
      const nested = await withDecisionModel(async () => 'nested')
      expect(nested).toBe('nested')
      return decideWithDecisionModel('state', 'next?', ['A', 'B'])
    })

    expect(result.choice).toBe(0)
    expect(mocks.runtime.start).toHaveBeenCalledTimes(1)
    expect(mocks.runtime.shutdown).toHaveBeenCalledTimes(1)
    expect(mocks.recordMetric).toHaveBeenCalledWith('deciderCalls')
    expect(mocks.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'decider', stage: 'structured_option_selection' })
    )
  })

  it('restarts a stopped dedicated runtime once before a decision', async () => {
    await withDecisionModel(async () => {
      mocks.runtime.running = false
      await expect(decideWithDecisionModel('state', 'next?', ['A', 'B'])).resolves.toMatchObject({
        choice: 0
      })
    })
    expect(mocks.runtime.start).toHaveBeenCalledTimes(2)
  })

  it('uses the explicit shared-model fallback after local memory pressure', async () => {
    mocks.runtime.start.mockRejectedValueOnce(
      new mocks.DecisionRuntimeError('out of memory', 'out_of_memory')
    )

    const result = await withDecisionModel(() =>
      decideWithDecisionModel('state', 'next?', ['A', 'B'])
    )

    expect(result.choice).toBe(1)
    expect(mocks.load).toHaveBeenCalledWith('offgrid/selected-decider')
    expect(mocks.llm.restoreSelectedModel).toHaveBeenCalled()
    expect(mocks.llm.restart).toHaveBeenCalledTimes(2)
  })

  it('does not use the shared fallback for Kev or ordinary startup errors', async () => {
    mocks.settings.mockReturnValue({ decisionModelId: 'offgrid/kev-4b' })
    mocks.installed.mockResolvedValue(['offgrid/kev-4b'])
    mocks.runtime.start.mockRejectedValueOnce(
      new mocks.DecisionRuntimeError('Kev failed', 'out_of_memory')
    )
    await expect(withDecisionModel(async () => 'never')).rejects.toThrow('Kev failed')

    mocks.settings.mockReturnValue({ decisionModelId: 'offgrid/selected-decider' })
    mocks.installed.mockResolvedValue(['offgrid/selected-decider'])
    mocks.runtime.start.mockRejectedValueOnce(new mocks.DecisionRuntimeError('failed', 'startup'))
    await expect(withDecisionModel(async () => 'never')).rejects.toThrow('failed')
  })
})

describe('decision transports', () => {
  it('parses labels, strips reasoning, normalizes probabilities, and rejects bad choices', () => {
    expect(
      parseRemoteDecision(
        '<think>hidden</think>```json\n{"choice":"B","probabilities":[1,3]}\n```',
        2
      )
    ).toEqual({ choice: 1, confidence: 0.75, probabilities: [0.25, 0.75] })
    expect(parseRemoteDecision('{"choice":0,"probabilities":[-1,"bad"]}', 2)).toEqual({
      choice: 0,
      confidence: 1,
      probabilities: [1, 0]
    })
    expect(() => parseRemoteDecision('{"choice":9}', 2)).toThrow('invalid choice')
  })

  it('uses a remote chat endpoint and records failed model calls', async () => {
    const remote = { provider: 'custom', endpoint: 'https://remote/v1', model: 'remote/model' }
    mocks.parseRemoteId.mockReturnValue({ serverId: 'remote', modelId: 'remote/model' })
    mocks.remote.mockReturnValue(remote)

    await expect(decideWithDecisionModel('state', 'next?', ['A', 'B'])).resolves.toEqual({
      choice: 1,
      confidence: 0.75,
      probabilities: [0.25, 0.75]
    })
    expect(mocks.llm.chatMessages).toHaveBeenCalled()

    mocks.llm.chatMessages.mockRejectedValueOnce(new Error('remote stopped'))
    await expect(decideWithDecisionModel('state', 'next?', ['A', 'B'])).rejects.toThrow(
      'remote stopped'
    )
    expect(mocks.recordCall).toHaveBeenLastCalledWith(
      expect.objectContaining({ error: expect.any(Error) })
    )
  })

  it('uses the provider-specific remote decision transport when advertised', async () => {
    const remote = { provider: 'openrouter', endpoint: 'https://openrouter.ai', model: 'jev' }
    mocks.parseRemoteId.mockReturnValue({ serverId: 'remote', modelId: 'jev' })
    mocks.remote.mockReturnValue(remote)
    mocks.useOpenRouter.mockReturnValue(true)
    mocks.openRouter.mockResolvedValue({ choice: 0, confidence: 1, probabilities: [1, 0] })

    await expect(decideWithDecisionModel('state', 'next?', ['A', 'B'])).resolves.toMatchObject({
      choice: 0
    })
    expect(mocks.openRouter).toHaveBeenCalled()
  })
})

describe('reasoning model restoration', () => {
  it('swaps back to reasoning and restores the decision model', async () => {
    mocks.llm.activeModelInfo.mockReturnValue({ id: 'offgrid/selected-decider' })
    await expect(withReasoningModel(async () => 'reasoned')).resolves.toBe('reasoned')
    expect(mocks.llm.restoreSelectedModel).toHaveBeenCalled()
    expect(mocks.load).toHaveBeenCalledWith('offgrid/selected-decider')
    expect(mocks.llm.restart).toHaveBeenCalledTimes(2)
  })

  it('runs directly when the dedicated runtime or chat model is active', async () => {
    mocks.runtime.running = true
    await expect(withReasoningModel(async () => 'dedicated')).resolves.toBe('dedicated')
    mocks.runtime.running = false
    mocks.llm.activeModelInfo.mockReturnValue({ id: 'offgrid/chat' })
    await expect(withReasoningModel(async () => 'chat')).resolves.toBe('chat')
  })
})
