import { describe, expect, it } from 'vitest'
import { remoteScreenDecision } from '../remote-screen-privacy'

const OPENROUTER = {
  name: 'OpenRouter work model',
  provider: 'openrouter' as const,
  endpoint: 'https://openrouter.ai/api/v1',
  screenFramesAllowed: false
}

describe('remote screen privacy decision', () => {
  it.each(['web_use', 'computer_use'] as const)(
    'blocks %s before a remote Same as Chat model receives a frame',
    (taskKind) => {
      expect(
        remoteScreenDecision({
          taskKind,
          modelStrategy: 'same_as_chat',
          activeServer: OPENROUTER
        })
      ).toMatchObject({
        allowed: false,
        remote: true,
        serverName: 'OpenRouter work model',
        destination: 'openrouter.ai',
        message: expect.stringContaining('did not send your screen')
      })
    }
  )

  it('allows the acknowledged remote destination', () => {
    expect(
      remoteScreenDecision({
        taskKind: 'web_use',
        modelStrategy: 'same_as_chat',
        activeServer: { ...OPENROUTER, screenFramesAllowed: true }
      })
    ).toMatchObject({ allowed: true, remote: true })
  })

  it('gates a remote text reasoner in the text plus specialist strategy', () => {
    expect(
      remoteScreenDecision({
        taskKind: 'computer_use',
        modelStrategy: 'text_plus_specialist',
        activeServer: OPENROUTER
      })
    ).toMatchObject({ allowed: false, remote: true })
  })

  it('does not block local transports or a local specialist', () => {
    expect(
      remoteScreenDecision({
        taskKind: 'computer_use',
        modelStrategy: 'same_as_chat',
        activeServer: { ...OPENROUTER, provider: 'ollama' }
      })
    ).toEqual({ allowed: true, remote: false })
    expect(
      remoteScreenDecision({
        taskKind: 'web_use',
        modelStrategy: 'separate_specialist',
        activeServer: OPENROUTER
      })
    ).toEqual({ allowed: true, remote: false })
  })
})
