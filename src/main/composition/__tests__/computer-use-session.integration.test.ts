import { describe, expect, it } from 'vitest'
import {
  ComputerUseSessionApplicationService,
  type ComputerUseSessionApplicationPorts
} from '@offgrid/models/computer-use'
import { createComputerUseSessionApplication } from '../computer-use-session'

interface TestModel {
  readonly name: string
}

describe('Desktop Computer Use session composition', () => {
  it('runs a direct-chat turn through the real Shared session application', async () => {
    const chatModel = { name: 'local-vision-model' }
    const ports: ComputerUseSessionApplicationPorts<
      { readonly displayId: string },
      TestModel,
      { readonly prompt: string },
      { readonly action: string }
    > = {
      strategy: () => 'same_as_chat',
      observeChatModel: async () => ({ modelId: 'vision-chat', model: chatModel }),
      observeSpecialistModel: async () => {
        throw new Error('The direct-chat strategy must not load a specialist.')
      },
      observeActiveSpecialistModel: async () => {
        throw new Error('The direct-chat strategy must not load an active specialist.')
      },
      resolveIdentity: async (modelId) => ({ modelId, modelName: 'Vision Chat' }),
      runWithSpecialist: async () => {
        throw new Error('The direct-chat strategy must not switch models.')
      },
      createDirectDecision:
        ({ environment, selection }) =>
        async ({ prompt }) => ({
          action: `${selection.model.name}:${environment.displayId}:${prompt}`
        }),
      createHybridDecision: () => {
        throw new Error('The direct-chat strategy must not create a hybrid decision.')
      }
    }

    const application = createComputerUseSessionApplication(ports)

    expect(application).toBeInstanceOf(ComputerUseSessionApplicationService)
    await expect(
      application.withSession({ displayId: 'main' }, async (session) => ({
        model: session.model,
        identity: session.identity,
        decision: await session.decide({ prompt: 'Open settings' })
      }))
    ).resolves.toEqual({
      model: chatModel,
      identity: { modelId: 'vision-chat', modelName: 'Vision Chat' },
      decision: { action: 'local-vision-model:main:Open settings' }
    })
  })
})
