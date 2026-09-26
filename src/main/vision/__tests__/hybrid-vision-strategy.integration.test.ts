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
import { uiTarsAdapter } from '../model-adapters/ui-tars'
import {
  activeModelProjectionIdentity,
  getComputerUseActiveModelProjection,
  withVisionTaskModelStrategy,
  type VisionTaskModelStrategyDependencies
} from '../vision-task-model-strategy'

const tempDirs: string[] = []

const modelLifecycleDependencies = {
  withDecision: async <T>(task: () => Promise<T>): Promise<T> => task(),
  withReasoning: async <T>(task: () => Promise<T>): Promise<T> => task(),
  decideOptions: async (_context: string, _question: string, options: readonly string[]) => ({
    choice: options.length - 1,
    confidence: 1,
    probabilities: options.map((_, index) => (index === options.length - 1 ? 1 : 0))
  })
}

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
  it('projects the implicit Chat reasoner in Decision + Specialist Computer Use', async () => {
    const chatModel = {
      id: 'chat/reasoner',
      primaryFile: 'chat.gguf',
      projectorFile: 'chat-mmproj.gguf',
      availableFiles: ['chat.gguf', 'chat-mmproj.gguf']
    }
    const dependencies: VisionTaskModelStrategyDependencies = {
      strategy: () => 'decision_plus_specialist',
      activeArtifacts: () => chatModel,
      activeRemote: () => null,
      selectedChatId: () => 'chat/reasoner',
      selectedSpecialistId: () => 'vision/specialist',
      selectedDecisionId: () => 'decision/selector',
      resolveIdentity: async (modelId) => ({ modelId, modelName: modelId }),
      withSpecialist: async (task) => ({ result: await task() }),
      runReasoner: async () => ({ content: '', toolCalls: [], finishReason: 'stop' }),
      ...modelLifecycleDependencies
    }

    const selected = await withVisionTaskModelStrategy(
      'desktop',
      async (session) => ({ adapterId: session.adapter.id, identity: session.identity }),
      dependencies
    )

    expect(selected).toEqual({
      adapterId: 'general-vision-operator',
      identity: {
        modelId: 'decision/selector + chat/reasoner + vision/specialist',
        modelName: 'decision/selector + chat/reasoner + vision/specialist'
      }
    })
    await expect(getComputerUseActiveModelProjection(dependencies)).resolves.toEqual({
      strategy: 'decision_plus_specialist',
      strategyLabel: 'Decision + Reasoning + Specialist',
      models: [
        {
          role: 'decision',
          modelId: 'decision/selector',
          modelName: 'decision/selector',
          remote: false
        },
        {
          role: 'reasoner',
          modelId: 'chat/reasoner',
          modelName: 'chat/reasoner',
          remote: false
        },
        {
          role: 'grounding_specialist',
          modelId: 'vision/specialist',
          modelName: 'vision/specialist',
          remote: false
        }
      ]
    })
    expect(
      activeModelProjectionIdentity(await getComputerUseActiveModelProjection(dependencies))
    ).toEqual({
      modelId: 'decision/selector + chat/reasoner + vision/specialist',
      modelName: 'decision/selector + chat/reasoner + vision/specialist'
    })
  })

  it('keeps Bonsai and the configured specialist as separate hybrid roles', async () => {
    const bonsai = {
      id: 'prism-ml/Ternary-Bonsai-2-27B-gguf',
      primaryFile: 'Ternary-Bonsai-2-27B-PQ2_0.gguf',
      projectorFile: 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
      availableFiles: ['Ternary-Bonsai-2-27B-PQ2_0.gguf', 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf']
    }
    const dependencies: VisionTaskModelStrategyDependencies = {
      strategy: () => 'text_plus_specialist',
      activeArtifacts: () => bonsai,
      activeRemote: () => null,
      selectedChatId: () => bonsai.id,
      selectedSpecialistId: () => 'specialist/model',
      resolveIdentity: async (modelId) => ({ modelId, modelName: modelId }),
      withSpecialist: async (task) => ({ result: await task() }),
      runReasoner: async () => ({
        content: '',
        toolCalls: [
          {
            id: 'completion-1',
            name: 'complete_milestone',
            arguments: JSON.stringify({
              summary: 'The requested result is visible.',
              visible_evidence: 'The result is visible.',
              continuation: { done: [], current: 'Confirm the result', next: [], irreversible: [] }
            })
          }
        ],
        finishReason: 'tool_calls'
      }),
      ...modelLifecycleDependencies
    }

    const selected = await withVisionTaskModelStrategy(
      'desktop',
      async (session) => ({
        adapterId: session.adapter.id,
        identity: session.identity
      }),
      dependencies
    )
    const projection = await getComputerUseActiveModelProjection(dependencies)

    expect(selected).toEqual({
      adapterId: 'general-vision-operator',
      identity: {
        modelId: `${bonsai.id} + specialist/model`,
        modelName: `${bonsai.id} + specialist/model`
      }
    })
    expect(projection).toEqual({
      strategy: 'text_plus_specialist',
      strategyLabel: 'Reasoning + Specialist',
      models: [
        { role: 'reasoner', modelId: bonsai.id, modelName: bonsai.id, remote: false },
        {
          role: 'grounding_specialist',
          modelId: 'specialist/model',
          modelName: 'specialist/model',
          remote: false
        }
      ]
    })
  })

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

  it('uses JEV for a bounded native action before reasoning or visual grounding', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-structured-selection-'))
    tempDirs.push(directory)
    const framePath = path.join(directory, 'frame.png')
    await sharp({
      create: { width: 320, height: 200, channels: 4, background: '#ffffff' }
    })
      .png()
      .toFile(framePath)

    const ground = createHybridVisionGrounder('desktop', {
      runReasoner: async () => {
        throw new Error('A confident native selection must not invoke the reasoner.')
      },
      withSpecialist: async () => {
        throw new Error('A confident native selection must not invoke the specialist.')
      },
      activeSpecialistAdapter: () => uiTarsAdapter,
      selectStructuredAction: async (_context, _question, options) => ({
        choice: 1,
        confidence: 0.9,
        probabilities: options.map((_, index) => (index === 1 ? 0.9 : 0.05))
      })
    })

    const result = await ground({
      goal: 'Open the relevant post.',
      currentMilestone: 'Open the relevant post.',
      image: framePath,
      history: [],
      retrievedFacts: [],
      policyHistory: [],
      guidance: [],
      semanticElements: [
        {
          index: 1,
          role: 'AXButton',
          name: 'View',
          value: '',
          point: { x: 20, y: 20 },
          actionable: true
        },
        {
          index: 2,
          role: 'AXLink',
          name: 'Local AI post',
          value: '',
          point: { x: 220, y: 120 },
          actionable: true
        }
      ],
      coordinateFrame: {
        encoded: { width: 320, height: 200 },
        source: { width: 320, height: 200 }
      }
    })

    expect(result.decision).toMatchObject({
      kind: 'actions',
      actions: [{ type: 'click', point: { x: 220, y: 120 } }]
    })
  })

  it('does not offer a verified no-op click target to JEV again', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-noop-selection-'))
    tempDirs.push(directory)
    const framePath = path.join(directory, 'frame.png')
    await sharp({
      create: { width: 320, height: 200, channels: 4, background: '#ffffff' }
    })
      .png()
      .toFile(framePath)

    const ground = createHybridVisionGrounder('desktop', {
      runReasoner: async () => {
        throw new Error('A different native target remains available.')
      },
      withSpecialist: async () => {
        throw new Error('A different native target remains available.')
      },
      activeSpecialistAdapter: () => uiTarsAdapter,
      selectStructuredAction: async (_context, _question, options) => {
        expect(options[0]).toContain('Local AI post')
        expect(options.join('\n')).not.toContain('Search input')
        return {
          choice: 0,
          confidence: 0.9,
          probabilities: options.map((_, index) => (index === 0 ? 0.9 : 0.1))
        }
      }
    })

    const coordinateFrame = {
      encoded: { width: 320, height: 200 },
      source: { width: 320, height: 200 }
    }
    const result = await ground({
      goal: 'Open the relevant post.',
      currentMilestone: 'Open the relevant post.',
      image: framePath,
      history: [],
      retrievedFacts: [],
      policyHistory: [],
      guidance: [],
      previousActionEffect: 'suspected_noop',
      previousVerifiedAction: {
        action: { type: 'click', point: { x: 80, y: 50 } },
        coordinateFrame
      },
      semanticElements: [
        {
          index: 1,
          role: 'AXTextField',
          name: 'Search input',
          value: '',
          point: { x: 80, y: 50 },
          actionable: true
        },
        {
          index: 2,
          role: 'AXLink',
          name: 'Local AI post',
          value: '',
          point: { x: 220, y: 120 },
          actionable: true
        }
      ],
      coordinateFrame
    })

    expect(result.decision).toMatchObject({
      kind: 'actions',
      actions: [{ type: 'click', point: { x: 220, y: 120 } }]
    })
  })

  it('uses Gemini recovery when the JEV service is unavailable', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-jev-recovery-'))
    tempDirs.push(directory)
    const framePath = path.join(directory, 'frame.png')
    await sharp({
      create: { width: 320, height: 200, channels: 4, background: '#ffffff' }
    })
      .png()
      .toFile(framePath)

    const ground = createHybridVisionGrounder('desktop', {
      runReasoner: async () =>
        toolResponse('complete_milestone', {
          summary: 'The requested result is visible.',
          visible_evidence: 'The relevant post is open.'
        }),
      withSpecialist: async () => {
        throw new Error('Completion must not invoke the specialist.')
      },
      activeSpecialistAdapter: () => uiTarsAdapter,
      selectStructuredAction: async () => {
        throw new Error('HTTP 520')
      }
    })

    const result = await ground({
      goal: 'Open the relevant post.',
      currentMilestone: 'Open the relevant post.',
      image: framePath,
      history: [],
      retrievedFacts: [],
      policyHistory: [],
      guidance: [],
      semanticElements: [
        {
          index: 1,
          role: 'AXLink',
          name: 'Local AI post',
          value: '',
          point: { x: 220, y: 120 },
          actionable: true
        }
      ],
      coordinateFrame: {
        encoded: { width: 320, height: 200 },
        source: { width: 320, height: 200 }
      }
    })

    expect(result.decision).toMatchObject({ kind: 'phase_complete' })
    expect(result.modelInput).toContain('Decision selector unavailable: HTTP 520')
  })

  it('lets Gemini verify an action result before JEV can choose another target', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-verification-owner-'))
    tempDirs.push(directory)
    const framePath = path.join(directory, 'frame.png')
    await sharp({
      create: { width: 320, height: 200, channels: 4, background: '#ffffff' }
    })
      .png()
      .toFile(framePath)

    const ground = createHybridVisionGrounder('desktop', {
      runReasoner: async () =>
        toolResponse('complete_milestone', {
          summary: 'Navigation is complete.',
          visible_evidence: 'The requested page is visible.'
        }),
      withSpecialist: async () => {
        throw new Error('Completion must not invoke the specialist.')
      },
      activeSpecialistAdapter: () => uiTarsAdapter,
      selectStructuredAction: async () => {
        throw new Error('JEV must not run during verification.')
      }
    })

    const result = await ground({
      goal: 'Open Instagram.',
      currentMilestone: 'Navigate to Instagram.',
      image: framePath,
      history: [],
      retrievedFacts: [],
      policyHistory: [
        {
          response: 'The prior action ran.',
          actionText: 'Open Instagram.',
          result: 'Fresh observation captured; verify the expected state.'
        }
      ],
      guidance: [],
      previousActionEffect: 'confirmed',
      semanticElements: [],
      coordinateFrame: {
        encoded: { width: 320, height: 200 },
        source: { width: 320, height: 200 }
      }
    })

    expect(result.decision).toMatchObject({ kind: 'phase_complete' })
  })

  it('uses Gemini recovery and UI-TARS grounding after JEV abstains', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-structured-recovery-'))
    tempDirs.push(directory)
    const framePath = path.join(directory, 'frame.png')
    await sharp({
      create: { width: 320, height: 200, channels: 4, background: '#ffffff' }
    })
      .png()
      .toFile(framePath)
    vi.spyOn(llm, 'chatMessages').mockResolvedValue("click(point='<point>160 100</point>')")
    let reasoningRecoveries = 0
    let specialistCalls = 0
    const ground = createHybridVisionGrounder('desktop', {
      runReasoner: async (request) => {
        const toolNames = (request.tools ?? []).map((tool) => {
          const value = tool as { function?: { name?: string } }
          return value.function?.name
        })
        expect(toolNames).not.toContain('click_accessibility_element')
        return toolResponse('ground_pointer_target', {
          action: 'click',
          target: 'the visible post card about local AI',
          summary: 'Open the relevant post.',
          visible_evidence: 'The relevant post card is visible in the feed.',
          expected_effect: 'The post detail opens.'
        })
      },
      withSpecialist: async (task) => {
        specialistCalls += 1
        return { result: await task() }
      },
      activeSpecialistAdapter: () => uiTarsAdapter,
      selectStructuredAction: async (_context, _question, options) => ({
        choice: options.length - 1,
        confidence: 0.9,
        probabilities: options.map((_, index) => (index === options.length - 1 ? 0.9 : 0.1))
      }),
      withReasoning: async (task) => {
        reasoningRecoveries += 1
        return task()
      }
    })

    const result = await ground({
      goal: 'Open the relevant post.',
      currentMilestone: 'Open the relevant post.',
      image: framePath,
      history: [],
      retrievedFacts: [],
      policyHistory: [],
      guidance: [],
      semanticElements: [
        {
          index: 1,
          role: 'AXMenuBarItem',
          name: 'View',
          value: '',
          point: { x: 20, y: 20 },
          actionable: true
        }
      ],
      coordinateFrame: {
        encoded: { width: 320, height: 200 },
        source: { width: 320, height: 200 }
      }
    })

    expect(result.decision).toMatchObject({
      kind: 'actions',
      actions: [{ type: 'click', point: { x: 160, y: 100 } }]
    })
    expect(reasoningRecoveries).toBe(1)
    expect(specialistCalls).toBe(1)
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
        return "click(point='<point>160 100</point>')"
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
        },
        ...modelLifecycleDependencies
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
