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
        toolResponse('delegate_grounded_action', {
          instruction: 'Click the visible Continue button.',
          summary: 'Continue to the next screen.',
          visible_evidence: 'A Continue button is visible in the center.'
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
            guard: new VisionGuard(),
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
        strategyLabel: 'Text + Specialist',
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
