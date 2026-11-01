import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TaskExecutionPlan } from '../../../shared/task-execution-plan'
import {
  installFakeLlamaEngine,
  processAlive,
  unusedPort,
  useModelBrain,
  writeGguf,
  type BrainReply,
  type FakeLlamaEngine,
  type ModelBrain
} from '../../__tests__/harness/fake-llama-engine'

// The vision model is a llama-server executable whose replies come from this test; the chat
// engine owner, policy runner and task graph are real.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-general-vision-'))
const previous = { data: process.env.OFFGRID_DATA_DIR, bin: process.env.OFFGRID_BIN_DIR }
process.env.OFFGRID_DATA_DIR = PROFILE
process.env.OFFGRID_BIN_DIR = path.join(PROFILE, 'bin')
vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.OFFGRID_DATA_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { llm } from '../../llm'
import {
  bonsaiVisionOperatorAdapter,
  generalVisionOperatorAdapter,
  generalVisionPolicyFailure
} from '../model-adapters/general-vision-operator'
import { parseGeneralVisionToolResponse } from '../model-adapters/general-vision-tools'
import { resolveVisionModelAdapter } from '../model-adapters/registry'
import type { VisionPolicyMessage, VisionPolicyResponse } from '../model-adapters/types'
import {
  answerAfterThinking,
  createVisionGrounder,
  modelScreenshot,
  normalizedPolicyAnswer,
  previousClickMarker,
  remoteVisionProviderError,
  remoteVisionTransportError,
  runVisionPolicyRequest,
  serializeVisionPolicyResponse,
  visionPolicyMessagesForAttempt
} from '../vision-policy-runner'
import { VisionGuard } from '../vision-guard'
import { runVisionTaskGraph } from '../vision-task-graph'

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

/** The model's next replies, one per request; and every chat request it received. */
const replies: BrainReply[] = []
let engine: FakeLlamaEngine
let brain: ModelBrain
const chatRequests = (): ModelBrain['requests'] =>
  brain.requests.filter((request) => request.path.includes('chat/completions'))

beforeAll(async () => {
  engine = installFakeLlamaEngine(path.join(PROFILE, 'bin'))
  brain = await useModelBrain(engine, () => {
    const reply = replies.shift()
    if (reply === undefined) throw new Error('The model boundary has no queued reply.')
    return reply
  })
  // The vision model, loaded the way a Computer Use specialist is.
  for (const file of model.availableFiles) writeGguf(llm.getModelsDir(), file)
  llm.useRuntimeModel({ id: model.id, primary: model.primaryFile, mmproj: model.projectorFile })
  ;(llm as unknown as { port: number }).port = await unusedPort()
  await llm.init()
})

afterAll(async () => {
  llm.stop()
  await brain.close()
  for (const { pid } of engine.launches()) if (processAlive(pid)) process.kill(pid, 'SIGKILL')
  fs.rmSync(PROFILE, { recursive: true, force: true })
  if (previous.data === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previous.data
  if (previous.bin === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previous.bin
})

/** A native tool-call reply from a policy response. */
const toolReply = (
  value: VisionPolicyResponse,
  extra: Partial<Exclude<BrainReply, string | { json: unknown }>> = {}
): BrainReply => ({
  toolCalls: (value.toolCalls ?? []).map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments
  })),
  finishReason: 'tool_calls',
  ...extra
})

describe('general vision native tool policy', () => {
  afterEach(() => {
    replies.length = 0
  })

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

  it('uses the Bonsai Qwen3.8 operator profile without changing other general models', () => {
    const bonsai = {
      id: 'prism-ml/Ternary-Bonsai-2-27B-gguf',
      primaryFile: 'Ternary-Bonsai-2-27B-PQ2_0.gguf',
      projectorFile: 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
      availableFiles: ['Ternary-Bonsai-2-27B-PQ2_0.gguf', 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf']
    }
    const adapter = resolveVisionModelAdapter(bonsai)
    const request = adapter.buildRequest({
      goal: 'Open the visible result.',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      coordinateFrame: { encoded: bounds, source: bounds },
      history: [],
      recentSteps: [],
      olderVisualFacts: []
    })

    expect(adapter).toBe(bonsaiVisionOperatorAdapter)
    expect(request).toMatchObject({
      temperature: 1,
      topP: 0.95,
      topK: 20,
      minP: 0,
      presencePenalty: 0,
      repeatPenalty: 1,
      preserveThinking: true,
      enableThinking: true,
      separateReasoning: true
    })
    const performTool = request.tools?.find(
      (tool) => (tool as { function: { name: string } }).function.name === 'perform_action'
    ) as { function: { parameters: { required: string[] } } }
    expect(performTool.function.parameters.required).toEqual(
      expect.arrayContaining(['intent', 'expected_state'])
    )

    expect(resolveVisionModelAdapter(model)).toBe(generalVisionOperatorAdapter)
    expect(
      resolveVisionModelAdapter({
        id: 'unsloth/Qwen3.8-27B-GGUF',
        primaryFile: 'Qwen3.8-27B-UD-Q4_K_M.gguf',
        projectorFile: 'mmproj-F16.gguf',
        availableFiles: ['Qwen3.8-27B-UD-Q4_K_M.gguf', 'mmproj-F16.gguf']
      })
    ).toBe(bonsaiVisionOperatorAdapter)
  })

  it('replays a bounded ordered trajectory with reasoning and tool results', () => {
    const request = bonsaiVisionOperatorAdapter.buildRequest({
      goal: 'Continue the task.',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      coordinateFrame: { encoded: bounds, source: bounds },
      history: Array.from({ length: 6 }, (_, index) => ({
        response: `tool-call-${index + 1}`,
        actionText: `action-${index + 1}`,
        reasoning: `reasoning-${index + 1}`,
        result: `result-${index + 1}`
      })),
      recentSteps: [],
      olderVisualFacts: [],
      continuation: {
        done: ['Attempted: Click reel A.'],
        next: 'Open a different relevant reel.',
        remember: 'Do not repeat an earlier target.'
      }
    })
    const transcript = request.messages.map((message) => JSON.stringify(message.content)).join('\n')

    expect(transcript).toContain('<think>reasoning-1</think>')
    expect(transcript).toContain('tool-call-6')
    expect(transcript).toContain('Tool result: result-6')
    expect(transcript.indexOf('tool-call-1')).toBeLessThan(transcript.indexOf('tool-call-6'))
    expect(transcript).toContain('Attempted: Click reel A.')
    expect(transcript).toContain('Open a different relevant reel.')
  })

  it('returns Bonsai intent and expected state through the direct action contract', () => {
    const decision = parseGeneralVisionToolResponse(
      response('perform_action', {
        direction: 'aligned',
        summary: 'Open the visible result.',
        visible_evidence: 'The result control is visible.',
        action: { type: 'click', point: { x: 280, y: 355 } },
        action_reason: 'The point is inside the control.',
        intent: 'Open the result panel.',
        expected_state: 'The result panel is visible.'
      }),
      bounds
    )

    expect(decision).toMatchObject({
      kind: 'actions',
      expectedEffect: 'The result panel is visible.'
    })
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
    replies.push(
      toolReply(perform(), {
        reasoning: 'The control is visible.',
        content: '{"command":{"name":"complete_milestone"}}'
      }),
      toolReply(complete())
    )

    try {
      const result = await runVisionTaskGraph('Open the visible result.', {
        screen: {
          capture: async () => ({ image: imagePath, bounds }),
          actuate: async (action) => {
            actuated.push(action)
          }
        },
        guard: new VisionGuard({ taskId: 'operator-adapter-test', kind: 'computer_use' }),
        decide: createVisionGrounder(generalVisionOperatorAdapter, 'embedded_browser'),
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
      fs.rmSync(imagePath, { force: true })
    }
  })

  it('re-observes after the bounded native-tool retry returns no transition', async () => {
    const imagePath = await writeFrame('native-tool-retry')
    const invalid = { content: 'I think the milestone is complete.', toolCalls: [] }
    const before = chatRequests().length
    replies.push(
      { content: invalid.content, finishReason: 'stop' },
      { content: invalid.content, finishReason: 'stop' },
      toolReply(perform()),
      toolReply(complete())
    )
    let captures = 0
    const actuated: unknown[] = []

    try {
      const result = await runVisionTaskGraph('Confirm the visible result.', {
        screen: {
          capture: async () => {
            captures += 1
            return { image: imagePath, bounds }
          },
          actuate: async (action) => {
            actuated.push(action)
          }
        },
        guard: new VisionGuard({ taskId: 'operator-adapter-test', kind: 'computer_use' }),
        decide: createVisionGrounder(generalVisionOperatorAdapter),
        parseResponse: generalVisionOperatorAdapter.parseResponse,
        waitForUser: async () => undefined,
        plan
      })

      expect(result).toMatchObject({ ok: true, summary: 'The requested result is visible.' })
      expect(captures).toBe(3)
      expect(chatRequests().length - before).toBe(4)
      expect(actuated).toEqual([{ type: 'click', point: { x: 287, y: 227 } }])
      expect(result.steps).toContain(
        'the model returned 0 tool calls; exactly one is required; re-observing'
      )
    } finally {
      fs.rmSync(imagePath, { force: true })
    }
  })

  it('returns the final invalid native response after the bounded retry', async () => {
    const invalid = { content: 'text is not a transition', toolCalls: [] }
    const before = chatRequests().length
    replies.push(
      { content: invalid.content, finishReason: 'stop' },
      { content: invalid.content, finishReason: 'stop' }
    )
    const request = generalVisionOperatorAdapter.buildRequest({
      goal: 'Open the control.',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      coordinateFrame: { encoded: bounds, source: bounds },
      history: [],
      recentSteps: [],
      olderVisualFacts: []
    })

    await expect(runVisionPolicyRequest(request)).resolves.toEqual(invalid)
    expect(chatRequests().length - before).toBe(2)
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

    expect(userText).toContain('click an app only when its identity is visible')
    expect(userText).toContain('operating-system launcher or search')
  })

  it('keeps native calls in audit history without using the serialization for routing', () => {
    const serialized = serializeVisionPolicyResponse(perform())
    expect(serialized).toContain('perform_action')
    const audit = JSON.parse(serialized) as { tool_calls: Array<{ arguments: string }> }
    expect(JSON.parse(audit.tool_calls[0]!.arguments)).toMatchObject({
      action: { type: 'click' }
    })
  })

  it('keeps final-answer and retry helpers for specialist text protocols', () => {
    expect(answerAfterThinking('<think>private</think>\nAction: wait()')).toBe('Action: wait()')
    expect(normalizedPolicyAnswer('```json\n{"safe":true}\n```')).toBe('{"safe":true}')
    const messages = [{ role: 'system' as const, content: 'policy' }]
    expect(visionPolicyMessagesForAttempt(messages, 2, 'bad', 'missing tool')).toEqual([
      ...messages,
      { role: 'assistant', content: 'bad' },
      // A USER turn: templates that require system-first (Holo 3.1) raise on a later system
      // message, which made every retry 500 instead of recovering.
      expect.objectContaining({ role: 'user', content: expect.stringContaining('missing tool') })
    ])
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

  it('persists the exact unmarked image used by every Web Use model', async () => {
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
    expect(persisted.equals(original)).toBe(true)
    expect(prepared.dataUrl).toBe(`data:image/png;base64,${persisted.toString('base64')}`)
    expect(await sharp(persisted).metadata()).toMatchObject({ width: 1000, height: 600 })
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
    replies.push(toolReply(complete()))
    const before = chatRequests().length
    /** The screenshot the model received, as it arrived at the engine. */
    const modelImage = (): string => {
      const messages = (chatRequests()[before]?.body.messages ?? []) as VisionPolicyMessage[]
      const userContent = messages.find((message) => message.role === 'user')?.content
      const image = Array.isArray(userContent)
        ? userContent.find((part) => part.type === 'image_url')
        : undefined
      return image?.type === 'image_url' ? image.image_url.url : ''
    }

    try {
      const grounding = await createVisionGrounder(generalVisionOperatorAdapter)({
        goal: 'Confirm the visible result.',
        image: file,
        history: [],
        retrievedFacts: [],
        policyHistory: [],
        guidance: [],
        coordinateFrame: { encoded: bounds, source: bounds }
      })
      const persistedDataUrl = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`

      expect(modelImage()).toBe(persistedDataUrl)
      expect(grounding.screenshotDataUrl).toBe(persistedDataUrl)
    } finally {
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
    // A server that is down is said in words, never as the endpoint it was reached at.
    const refused = remoteVisionTransportError(
      new Error('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:17878'), {
          code: 'ECONNREFUSED'
        })
      })
    ).message
    expect(refused).toContain('not answering')
    expect(refused).not.toContain('127.0.0.1')
    expect(
      remoteVisionProviderError(429, {
        error: { metadata: { raw: 'Rate limited.', provider_name: 'Provider' } }
      }).message
    ).toContain('Rate limited.')
  })
})
