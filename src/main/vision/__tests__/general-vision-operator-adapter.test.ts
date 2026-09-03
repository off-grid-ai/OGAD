import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  serializeComputerUsePolicyResponse,
  type GenerationRequest,
  type RuntimeModel
} from '@offgrid/models'
import type { TaskExecutionPlan } from '../../../shared/task-execution-plan'
import { desktopModelServices } from '../../model-services'
import {
  generalVisionOperatorAdapter,
  generalVisionPolicyFailure
} from '../model-adapters/general-vision-operator'
import { parseGeneralVisionToolResponse } from '../model-adapters/general-vision-tools'
import { resolveVisionModelAdapter } from '../model-adapters/registry'
import type { VisionPolicyResponse } from '../model-adapters/types'
import {
  createVisionGrounder,
  modelScreenshot,
  previousClickMarker,
  remoteVisionTransportError,
  runVisionPolicyRequest
} from '../vision-policy-runner'
import { VisionGuard } from '../vision-guard'
import { runVisionTaskGraph } from '../vision-task-graph'

interface ScriptedVisionResponse extends VisionPolicyResponse {
  reasoning?: string
  finishReason?: 'stop' | 'tool_calls'
}

let runtimeNumber = 0

async function scriptedVisionRuntime(responses: ScriptedVisionResponse[]): Promise<{
  routeId: string
  requests: GenerationRequest[]
  calls(): number
  dispose(): void
}> {
  runtimeNumber += 1
  const adapterId = `vision-test-runtime-${runtimeNumber}`
  const model: RuntimeModel = {
    id: adapterId,
    name: 'Vision test runtime',
    kind: 'computer_use',
    modality: 'computer_use',
    source: 'remote',
    adapterId,
    capabilities: {
      vision: true,
      computerUse: true,
      tools: true,
      toolSelection: true,
      thinking: true,
      streaming: true,
      structuredOutput: true
    },
    installed: true,
    ready: true,
    loaded: true
  }
  const unregisterInventory = desktopModelServices.llm.registerAdapter({
    id: adapterId,
    listModels: async () => [model]
  })
  const requests: GenerationRequest[] = []
  let callCount = 0
  const unregisterGeneration = desktopModelServices.generation.registerAdapter({
    id: adapterId,
    async *generate(_model, request) {
      const response = responses[Math.min(callCount, responses.length - 1)]!
      callCount += 1
      requests.push(request)
      if (response.reasoning) yield { reasoning: response.reasoning }
      if (response.content) yield { content: response.content }
      if (response.toolCalls.length) {
        yield {
          toolCallDeltas: response.toolCalls.map((call, index) => ({
            index,
            id: call.id,
            name: call.name,
            argumentsDelta: call.arguments
          }))
        }
      }
      yield {
        finishReason: response.finishReason ?? (response.toolCalls.length ? 'tool_calls' : 'stop')
      }
    }
  })
  await desktopModelServices.refresh()
  const routeId = desktopModelServices.llm
    .list('computer_use')
    .find((candidate) => candidate.adapterId === adapterId)?.routeId
  if (!routeId) throw new Error('The scripted vision route was not registered.')
  return {
    routeId,
    requests,
    calls: () => callCount,
    dispose() {
      unregisterGeneration()
      unregisterInventory()
    }
  }
}

const model = {
  id: 'unsloth/gemma-4-E4B-it-GGUF',
  primaryFile: 'gemma-4-E4B-it-Q4_K_M.gguf',
  projectorFile: 'mmproj-gemma-4-E4B-it-F16.gguf',
  availableFiles: ['gemma-4-E4B-it-Q4_K_M.gguf', 'mmproj-gemma-4-E4B-it-F16.gguf']
}
const bounds = { width: 1024, height: 640 }
const plan: TaskExecutionPlan = {
  version: 1,
  phases: [{ id: 'phase-1', title: 'Open the visible result' }]
}

function response(name: string, argumentsValue: Record<string, unknown>): VisionPolicyResponse {
  return {
    content: '',
    toolCalls: [{ id: `call-${name}`, name, arguments: JSON.stringify(argumentsValue) }]
  }
}

function perform(
  action: Record<string, unknown> = { type: 'click', point: { x: 280, y: 355 } }
): VisionPolicyResponse {
  return response('perform_action', {
    direction: 'aligned',
    summary: 'Open the visible result.',
    visible_evidence: 'The result control is visible.',
    action,
    action_reason: 'The structured point is inside the visible control.'
  })
}

function complete(): VisionPolicyResponse {
  return response('complete_milestone', {
    summary: 'The requested result is visible.',
    visible_evidence: 'The result panel is visible in the screenshot.'
  })
}

async function writeFrame(name: string): Promise<string> {
  const imagePath = path.join(os.tmpdir(), `offgrid-${name}-${process.pid}.png`)
  fs.writeFileSync(
    imagePath,
    await sharp({
      create: { width: bounds.width, height: bounds.height, channels: 3, background: '#000000' }
    })
      .png()
      .toBuffer()
  )
  return imagePath
}

describe('general vision native tool policy', () => {
  it('builds one required native-tool request with no JSON final-answer grammar', () => {
    const adapter = resolveVisionModelAdapter(model)
    const request = adapter.buildRequest({
      goal: 'Find a one-way flight from SFO to PNQ.',
      operatorEnvironment: 'embedded_browser',
      currentMilestone: 'Enter the flight details.',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      coordinateFrame: { encoded: bounds, source: { width: 1064, height: 1464 } },
      history: [],
      recentSteps: ['Opened the flight site.'],
      olderVisualFacts: [],
      verifiedActions: []
    })

    expect(adapter.id).toBe('general-vision-operator')
    expect(request.toolChoice).toBe('required')
    expect(request.tools).toHaveLength(4)
    expect(
      request.tools?.map((tool) => (tool as { function: { name: string } }).function.name)
    ).toEqual(['complete_milestone', 'perform_action', 'rethink', 'call_user'])
    expect(request.responseFormat).toBeUndefined()
    expect(request.requireFinalAnswer).toBeUndefined()
    const serialized = JSON.stringify(request)
    expect(serialized).toContain('Enter the flight details')
    expect(serialized).toContain('1024 pixels wide and 640 pixels high')
    expect(serialized).toContain('structured navigate action')
    expect(serialized).not.toContain("click(point='")
    expect(serialized).not.toContain('json_schema')
  })

  it('maps a typed normalized point to encoded pixels without an action-text parser', () => {
    expect(parseGeneralVisionToolResponse(perform(), bounds)).toMatchObject({
      kind: 'actions',
      actions: [{ type: 'click', point: { x: 287, y: 227 } }]
    })
  })

  it('routes milestone, rethink, and user handoff from their top-level tools', () => {
    expect(parseGeneralVisionToolResponse(complete(), bounds)).toMatchObject({
      kind: 'phase_complete'
    })
    expect(
      parseGeneralVisionToolResponse(
        response('rethink', {
          direction: 'off_course',
          summary: 'The visible page is on the wrong path.',
          visible_evidence: 'The requested site is not visible.'
        }),
        bounds
      )
    ).toMatchObject({ kind: 'rethink', direction: 'off_course' })
    expect(
      parseGeneralVisionToolResponse(
        response('call_user', {
          reason: 'Enter the one-time code.',
          visible_evidence: 'A one-time-code field is visible.'
        }),
        bounds
      )
    ).toMatchObject({ kind: 'handoff', reason: 'Enter the one-time code.' })
  })

  it('rejects missing, multiple, unsupported, and malformed native calls', () => {
    expect(
      generalVisionPolicyFailure({ content: '{"fake":"complete"}', toolCalls: [] }, bounds)
    ).toContain('0 tool calls')
    expect(
      generalVisionPolicyFailure(
        { content: '', toolCalls: [...perform().toolCalls, ...complete().toolCalls] },
        bounds
      )
    ).toContain('2 tool calls')
    expect(generalVisionPolicyFailure(response('unknown_tool', {}), bounds)).toContain(
      'unsupported vision tool'
    )
    expect(
      generalVisionPolicyFailure(
        { content: '', toolCalls: [{ id: 'bad', name: 'perform_action', arguments: '{' }] },
        bounds
      )
    ).toContain('arguments were not a JSON object')
  })

  it('rejects extra fields and invalid structured actions', () => {
    expect(
      generalVisionPolicyFailure(
        perform({ type: 'click', point: { x: 280, y: 355 }, extra: true }),
        bounds
      )
    ).toBe('action was not one supported structured action')
    expect(
      generalVisionPolicyFailure(perform({ type: 'click', point: { x: 1200, y: 355 } }), bounds)
    ).toBe('action was not one supported structured action')
    expect(
      generalVisionPolicyFailure(
        response('perform_action', {
          direction: 'aligned',
          summary: 'Open it.',
          visible_evidence: 'It is visible.',
          action: { type: 'click', point: { x: 200, y: 300 } },
          action_reason: 'It is in the control.',
          extra: true
        }),
        bounds
      )
    ).toContain('unexpected fields: extra')
  })

  it('uses native calls even when answer text claims a different transition', async () => {
    const imagePath = await writeFrame('native-tools')
    const actuated: unknown[] = []
    const reasoning: string[] = []
    const runtime = await scriptedVisionRuntime([
      {
        content: '{"command":{"name":"complete_milestone"}}',
        toolCalls: [...perform().toolCalls],
        reasoning: 'The control is visible.',
        finishReason: 'tool_calls'
      },
      {
        content: '',
        toolCalls: [...complete().toolCalls],
        finishReason: 'tool_calls'
      }
    ])

    try {
      const result = await runVisionTaskGraph('Open the visible result.', {
        screen: {
          capture: async () => ({ image: imagePath, bounds }),
          actuate: async (action) => {
            actuated.push(action)
          }
        },
        guard: new VisionGuard({ taskId: 'operator-adapter-test', kind: 'computer_use' }),
        decide: createVisionGrounder(
          generalVisionOperatorAdapter,
          'embedded_browser',
          runtime.routeId
        ),
        parseResponse: generalVisionOperatorAdapter.parseResponse,
        waitForUser: async () => undefined,
        plan,
        onReasoning: (event) => {
          if (event.content) reasoning.push(event.content)
        }
      })

      expect(result.summary).toBe('The requested result is visible.')
      expect(result).toMatchObject({ ok: true })
      expect(actuated).toEqual([{ type: 'click', point: { x: 287, y: 227 } }])
      expect(reasoning).toContain('The control is visible.')
    } finally {
      runtime.dispose()
      fs.rmSync(imagePath, { force: true })
    }
  })

  it('re-observes after the bounded native-tool retry returns no transition', async () => {
    const imagePath = await writeFrame('native-tool-retry')
    const invalid = { content: 'I think the milestone is complete.', toolCalls: [] }
    const runtime = await scriptedVisionRuntime([
      { ...invalid, finishReason: 'stop' },
      { ...invalid, finishReason: 'stop' },
      {
        content: '',
        toolCalls: [...complete().toolCalls],
        finishReason: 'tool_calls'
      },
      {
        content: '',
        toolCalls: [...complete().toolCalls],
        finishReason: 'tool_calls'
      }
    ])
    let captures = 0

    try {
      const result = await runVisionTaskGraph('Confirm the visible result.', {
        screen: {
          capture: async () => {
            captures += 1
            return { image: imagePath, bounds }
          },
          actuate: async () => {
            throw new Error('invalid tool output must not actuate')
          }
        },
        guard: new VisionGuard({ taskId: 'operator-adapter-test', kind: 'computer_use' }),
        decide: createVisionGrounder(generalVisionOperatorAdapter, 'desktop', runtime.routeId),
        parseResponse: generalVisionOperatorAdapter.parseResponse,
        waitForUser: async () => undefined,
        plan
      })

      expect(result).toMatchObject({ ok: true, summary: 'The requested result is visible.' })
      expect(captures).toBe(3)
      expect(runtime.calls()).toBe(4)
      expect(result.steps).toContain(
        'the model returned 0 tool calls; exactly one is required; re-observing'
      )
    } finally {
      runtime.dispose()
      fs.rmSync(imagePath, { force: true })
    }
  })

  it('returns the final invalid native response after the bounded retry', async () => {
    const invalid = { content: 'text is not a transition', toolCalls: [] }
    const runtime = await scriptedVisionRuntime([{ ...invalid, finishReason: 'stop' }])
    const request = generalVisionOperatorAdapter.buildRequest({
      goal: 'Open the control.',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      coordinateFrame: { encoded: bounds, source: bounds },
      history: [],
      recentSteps: [],
      olderVisualFacts: []
    })
    request.generationRouteId = runtime.routeId

    try {
      await expect(runVisionPolicyRequest(request)).resolves.toEqual(invalid)
      expect(runtime.calls()).toBe(2)
    } finally {
      runtime.dispose()
    }
  })

  it('uses the application launcher instead of guessing an unidentified Dock icon', () => {
    const request = generalVisionOperatorAdapter.buildRequest({
      goal: 'Open the requested desktop application.',
      operatorEnvironment: 'desktop',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      coordinateFrame: { encoded: bounds, source: bounds },
      history: [],
      recentSteps: [],
      olderVisualFacts: []
    })
    const userText = JSON.stringify(request.messages[1]?.content)

    expect(userText).toContain('Do not identify an application from icon color or position alone')
    expect(userText).toContain('operating system application launcher or search')
  })

  it('keeps native calls in audit history without using the serialization for routing', () => {
    const serialized = serializeComputerUsePolicyResponse(perform())
    expect(serialized).toContain('perform_action')
    const audit = JSON.parse(serialized) as { tool_calls: Array<{ arguments: string }> }
    expect(JSON.parse(audit.tool_calls[0]!.arguments)).toMatchObject({
      action: { type: 'click' }
    })
  })

  it('projects the previous click marker into the current frame', () => {
    expect(
      previousClickMarker({
        goal: 'Use the control.',
        image: '/tmp/current.png',
        history: [],
        retrievedFacts: [],
        policyHistory: [],
        guidance: [],
        previousVerifiedAction: {
          action: { type: 'click', point: { x: 285, y: 148 } },
          coordinateFrame: {
            encoded: { width: 1000, height: 1000 },
            source: { width: 1000, height: 1000 }
          }
        },
        coordinateFrame: {
          encoded: { width: 500, height: 500 },
          source: { width: 500, height: 500 }
        }
      })
    ).toEqual({ x: 143, y: 74 })
  })

  it('persists the exact annotated model image for task history', async () => {
    const file = path.join(os.tmpdir(), `offgrid-model-frame-${Date.now()}.png`)
    const original = await sharp({
      create: { width: 100, height: 100, channels: 4, background: '#ffffff' }
    })
      .png()
      .toBuffer()
    fs.writeFileSync(file, original)

    const prepared = await modelScreenshot({
      goal: 'Use the control.',
      image: file,
      history: [],
      retrievedFacts: [],
      policyHistory: [],
      guidance: [],
      previousVerifiedAction: {
        action: { type: 'click', point: { x: 50, y: 50 } },
        coordinateFrame: {
          encoded: { width: 100, height: 100 },
          source: { width: 100, height: 100 }
        }
      },
      coordinateFrame: {
        encoded: { width: 100, height: 100 },
        source: { width: 100, height: 100 }
      }
    })

    const persisted = fs.readFileSync(file)
    expect(persisted.equals(original)).toBe(false)
    expect(prepared.dataUrl).toBe(`data:image/png;base64,${persisted.toString('base64')}`)
    fs.unlinkSync(file)
  })

  it('persists the exact normalized grid image used by every Web Use model', async () => {
    const file = path.join(os.tmpdir(), `offgrid-model-grid-${Date.now()}.png`)
    const original = await sharp({
      create: { width: 1000, height: 600, channels: 4, background: '#ffffff' }
    })
      .png()
      .toBuffer()
    fs.writeFileSync(file, original)

    const prepared = await modelScreenshot({
      goal: 'Use the control.',
      image: file,
      history: [],
      retrievedFacts: [],
      policyHistory: [],
      guidance: [],
      coordinateFrame: {
        encoded: { width: 1000, height: 600 },
        source: { width: 1000, height: 600 }
      }
    })

    const persisted = fs.readFileSync(file)
    expect(persisted.equals(original)).toBe(false)
    expect(prepared.dataUrl).toBe(`data:image/png;base64,${persisted.toString('base64')}`)
    expect(await sharp(persisted).metadata()).toMatchObject({ width: 1000, height: 600 })
    const raw = await sharp(persisted).removeAlpha().raw().toBuffer()
    const rgbAt = (x: number, y: number): number[] => {
      const offset = (y * 1000 + x) * 3
      return [raw[offset]!, raw[offset + 1]!, raw[offset + 2]!]
    }
    expect(rgbAt(20, 200)).not.toEqual([255, 255, 255])
    expect(rgbAt(10, 200)).toEqual([255, 255, 255])
    fs.unlinkSync(file)
  })

  it('sends the exact persisted numbered-grid bytes through the production model request', async () => {
    const file = path.join(os.tmpdir(), `offgrid-production-model-grid-${Date.now()}.png`)
    fs.writeFileSync(
      file,
      await sharp({
        create: { width: bounds.width, height: bounds.height, channels: 4, background: '#ffffff' }
      })
        .png()
        .toBuffer()
    )
    const runtime = await scriptedVisionRuntime([
      {
        content: '',
        toolCalls: [...complete().toolCalls],
        finishReason: 'tool_calls'
      }
    ])

    try {
      const grounding = await createVisionGrounder(
        generalVisionOperatorAdapter,
        'desktop',
        runtime.routeId
      )({
        goal: 'Confirm the visible result.',
        image: file,
        history: [],
        retrievedFacts: [],
        policyHistory: [],
        guidance: [],
        coordinateFrame: { encoded: bounds, source: bounds }
      })
      const persistedDataUrl = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
      const userContent = runtime.requests[0]?.messages?.find(
        (message) => message.role === 'user'
      )?.content
      const modelImageUrl = Array.isArray(userContent)
        ? userContent.find((part) => part.type === 'image')?.uri
        : undefined

      expect(modelImageUrl).toBe(persistedDataUrl)
      expect(grounding.screenshotDataUrl).toBe(persistedDataUrl)
    } finally {
      runtime.dispose()
      fs.rmSync(file, { force: true })
    }
  })

  it('rejects mismatched image and coordinate dimensions before model inference', async () => {
    const file = path.join(os.tmpdir(), `offgrid-model-frame-mismatch-${Date.now()}.png`)
    fs.writeFileSync(
      file,
      await sharp({
        create: { width: 200, height: 100, channels: 4, background: '#ffffff' }
      })
        .png()
        .toBuffer()
    )

    await expect(
      modelScreenshot({
        goal: 'Use the control.',
        image: file,
        history: [],
        retrievedFacts: [],
        policyHistory: [],
        guidance: [],
        coordinateFrame: {
          encoded: { width: 100, height: 100 },
          source: { width: 200, height: 100 }
        }
      })
    ).rejects.toThrow('image is 200x100, coordinate frame is 100x100')
    fs.unlinkSync(file)
  })

  it('preserves safe remote transport and provider error detail', () => {
    const transport = new Error('fetch failed', {
      cause: Object.assign(new Error('the peer closed'), { code: 'UND_ERR_SOCKET' })
    })
    expect(remoteVisionTransportError(transport).message).toContain('the peer closed')
  })
})
