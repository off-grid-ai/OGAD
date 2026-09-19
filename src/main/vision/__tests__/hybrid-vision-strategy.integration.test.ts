import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { llm } from '../../llm'
import type { TaskExecutionPlan } from '../../../shared/task-execution-plan'
import type { VisionPolicyRequest, VisionPolicyResponse } from '../model-adapters/types'
import { VisionGuard } from '../vision-guard'
import { runVisionTaskGraph } from '../vision-task-graph'
import { createHybridVisionGrounder } from '../hybrid-vision-grounder'
import {
  getComputerUseActiveModelProjection,
  withVisionTaskModelStrategy,
  type VisionTaskModelStrategyDependencies
} from '../vision-task-model-strategy'

const tempDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function toolResponse(name: string, value: Record<string, unknown>): VisionPolicyResponse {
  return {
    content: '',
    toolCalls: [{ id: `call-${name}`, name, arguments: JSON.stringify(value) }]
  }
}

function imageFrom(request: VisionPolicyRequest): string {
  const user = request.messages.find((message) => message.role === 'user')
  const parts = Array.isArray(user?.content) ? user.content : []
  const image = parts.find((part) => part.type === 'image_url')
  if (!image || image.type !== 'image_url') throw new Error('The request has no screen image.')
  return image.image_url.url
}

describe('Text + Specialist visual task journey', () => {
  it('turns one public URL decision into one deterministic navigation action', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-hybrid-navigation-'))
    tempDirs.push(directory)
    const framePath = path.join(directory, 'frame.png')
    await sharp({
      create: { width: 320, height: 200, channels: 4, background: '#ffffff' }
    })
      .png()
      .toFile(framePath)

    const ground = createHybridVisionGrounder('desktop', {
      runReasoner: async () =>
        toolResponse('navigate_to_url', {
          url: 'https://example.com/path',
          summary: 'Open the supplied website.',
          visible_evidence: 'The task brief supplies the destination URL.',
          expected_effect: 'The website opens in the default browser.'
        }),
      withSpecialist: async () => {
        throw new Error('Navigation must not load the grounding specialist.')
      },
      activeSpecialistAdapter: () => {
        throw new Error('Navigation must not request the grounding specialist adapter.')
      }
    })

    const result = await ground({
      goal: 'Open https://example.com/path in the default browser.',
      image: framePath,
      history: [],
      retrievedFacts: [],
      policyHistory: [],
      guidance: [],
      coordinateFrame: {
        encoded: { width: 320, height: 200 },
        source: { width: 320, height: 200 }
      }
    })

    expect(result.decision).toMatchObject({
      kind: 'actions',
      actions: [{ type: 'navigate', url: 'https://example.com/path' }]
    })
  })

  it.each([
    ['Computer Use', 'desktop'],
    ['Web Use', 'embedded_browser']
  ] as const)(
    'uses Chat for %s decisions and the specialist only for grounded action selection',
    async (_label, environment) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-hybrid-vision-'))
      tempDirs.push(directory)
      const framePaths = [path.join(directory, 'frame-1.png'), path.join(directory, 'frame-2.png')]
      await Promise.all(
        framePaths.map((framePath, index) =>
          sharp({
            create: {
              width: 320,
              height: 200,
              channels: 4,
              background: index === 0 ? '#ffffff' : '#eeeeee'
            }
          })
            .png()
            .toFile(framePath)
        )
      )

      const chatModel = {
        id: 'chat/reasoner',
        primaryFile: 'chat.gguf',
        projectorFile: 'chat-mmproj.gguf',
        availableFiles: ['chat.gguf', 'chat-mmproj.gguf']
      }
      const specialistModel = {
        id: 'mradermacher/UI-TARS-1.5-7B-GGUF',
        primaryFile: 'ui-tars.gguf',
        projectorFile: 'ui-tars-mmproj.gguf',
        availableFiles: ['ui-tars.gguf', 'ui-tars-mmproj.gguf']
      }
      let activeModel = chatModel
      const reasonerScreens: string[] = []
      const specialistScreens: string[] = []
      const swapEvents: string[] = []
      const reasonerResponses = [
        toolResponse('ground_pointer_target', {
          action: 'click',
          target: 'Continue button',
          summary: 'Continue to the next screen.',
          visible_evidence: 'A Continue button is visible in the center.',
          expected_effect: 'The next screen opens.'
        }),
        toolResponse('complete_milestone', {
          summary: 'The next screen is open.',
          visible_evidence: 'The requested destination is visible.'
        })
      ]
      vi.spyOn(llm, 'chatMessages').mockImplementation(async (messages) => {
        const user = messages.find((message) => message.role === 'user')
        const parts = Array.isArray(user?.content) ? user.content : []
        const image = parts.find((part) => part.type === 'image_url')
        if (image?.type === 'image_url') specialistScreens.push(image.image_url.url)
        return "click(point='<point>500 500</point>')"
      })

      const plan: TaskExecutionPlan = {
        version: 1,
        phases: [{ id: 'continue', title: 'Open the next screen' }]
      }
      let captureIndex = 0
      const actions: unknown[] = []
      let taskIdentity: { modelId: string; modelName: string } | undefined
      const dependencies: VisionTaskModelStrategyDependencies = {
        strategy: () => 'text_plus_specialist',
        activeArtifacts: () => activeModel,
        activeRemote: () => null,
        selectedChatId: () => chatModel.id,
        selectedSpecialistId: () => specialistModel.id,
        resolveIdentity: async (modelId) => ({ modelId, modelName: modelId }),
        withSpecialist: async (task) => {
          swapEvents.push('load-specialist')
          activeModel = specialistModel
          try {
            return { result: await task() }
          } finally {
            activeModel = chatModel
            swapEvents.push('restore-chat')
          }
        },
        runReasoner: async (request) => {
          reasonerScreens.push(imageFrom(request))
          return reasonerResponses.shift()!
        }
      }
      const projection = await getComputerUseActiveModelProjection(dependencies)

      const result = await withVisionTaskModelStrategy(
        environment,
        async (session) => {
          taskIdentity = session.identity
          return runVisionTaskGraph('Open the next screen.', {
            screen: {
              capture: async () => ({
                image: framePaths[captureIndex++]!,
                bounds: { width: 320, height: 200 }
              }),
              actuate: async (action) => {
                actions.push(action)
              }
            },
            guard: new VisionGuard({ taskId: 'hybrid-strategy-test', kind: 'computer_use' }),
            decide: session.decide,
            parseResponse: session.adapter.parseResponse,
            waitForUser: async () => undefined,
            plan
          })
        },
        dependencies
      )

      expect(result).toMatchObject({ ok: true, summary: 'The next screen is open.' })
      expect(actions).toEqual([{ type: 'click', point: { x: 160, y: 100 } }])
      expect(swapEvents).toEqual(['load-specialist', 'restore-chat'])
      expect(reasonerScreens[0]).toBe(specialistScreens[0])
      expect(reasonerScreens).toHaveLength(2)
      expect(specialistScreens).toHaveLength(1)
      expect(taskIdentity).toEqual({
        modelId: `${chatModel.id} + ${specialistModel.id}`,
        modelName: `${chatModel.id} + ${specialistModel.id}`
      })
      expect(projection).toEqual({
        strategy: 'text_plus_specialist',
        strategyLabel: 'Reasoning + Specialist',
        models: [
          {
            role: 'reasoner',
            modelId: chatModel.id,
            modelName: chatModel.id,
            remote: false
          },
          {
            role: 'grounding_specialist',
            modelId: specialistModel.id,
            modelName: specialistModel.id,
            remote: false
          }
        ]
      })
    }
  )
})
