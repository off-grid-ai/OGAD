import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskExecutionPlan } from '../../../shared/task-execution-plan'
import { llm } from '../../llm'
import {
  generalVisionOperatorAdapter,
  generalVisionPolicyFailure,
  parseGeneralVisionOperatorResponse
} from '../model-adapters/general-vision-operator'
import { resolveVisionModelAdapter } from '../model-adapters/registry'
import type { VisionPolicyResponse } from '../model-adapters/types'
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

describe('general vision native tool policy', () => {
  afterEach(() => vi.restoreAllMocks())

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
    expect(parseGeneralVisionOperatorResponse(perform(), bounds)).toMatchObject({
      kind: 'actions',
      actions: [{ type: 'click', point: { x: 287, y: 227 } }]
    })
  })

  it('routes milestone, rethink, and user handoff from their top-level tools', () => {
    expect(parseGeneralVisionOperatorResponse(complete(), bounds)).toMatchObject({
      kind: 'phase_complete'
    })
    expect(
      parseGeneralVisionOperatorResponse(
        response('rethink', {
          direction: 'off_course',
          summary: 'The visible page is on the wrong path.',
          visible_evidence: 'The requested site is not visible.'
        }),
        bounds
      )
    ).toMatchObject({ kind: 'rethink', direction: 'off_course' })
    expect(
      parseGeneralVisionOperatorResponse(
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
    vi.spyOn(llm, 'streamChat')
      .mockImplementationOnce(async (_messages, onDelta) => {
        onDelta('The control is visible.', 'reasoning')
        return {
          content: '{"command":{"name":"complete_milestone"}}',
          toolCalls: [...perform().toolCalls],
          finishReason: 'tool_calls'
        }
      })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [...complete().toolCalls],
        finishReason: 'tool_calls'
      })

    try {
      const result = await runVisionTaskGraph('Open the visible result.', {
        screen: {
          capture: async () => ({ image: imagePath, bounds }),
          actuate: async (action) => {
            actuated.push(action)
          }
        },
        guard: new VisionGuard(),
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
    const stream = vi
      .spyOn(llm, 'streamChat')
      .mockResolvedValueOnce({ ...invalid, finishReason: 'stop' })
      .mockResolvedValueOnce({ ...invalid, finishReason: 'stop' })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [...complete().toolCalls],
        finishReason: 'tool_calls'
      })
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
        guard: new VisionGuard(),
        decide: createVisionGrounder(generalVisionOperatorAdapter),
        parseResponse: generalVisionOperatorAdapter.parseResponse,
        waitForUser: async () => undefined,
        plan
      })

      expect(result).toMatchObject({ ok: true, summary: 'The requested result is visible.' })
      expect(captures).toBe(2)
      expect(stream).toHaveBeenCalledTimes(3)
      expect(result.steps).toContain(
        'the model returned 0 tool calls; exactly one is required; re-observing'
      )
    } finally {
      fs.rmSync(imagePath, { force: true })
    }
  })

  it('returns the final invalid native response after the bounded retry', async () => {
    const invalid = { content: 'text is not a transition', toolCalls: [] }
    const stream = vi.spyOn(llm, 'streamChat').mockResolvedValue({
      ...invalid,
      finishReason: 'stop'
    })
    const request = generalVisionOperatorAdapter.buildRequest({
      goal: 'Open the control.',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      coordinateFrame: { encoded: bounds, source: bounds },
      history: [],
      recentSteps: [],
      olderVisualFacts: []
    })

    await expect(runVisionPolicyRequest(request)).resolves.toEqual(invalid)
    expect(stream).toHaveBeenCalledTimes(2)
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
      expect.objectContaining({ role: 'system', content: expect.stringContaining('missing tool') })
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

  it('preserves safe remote transport and provider error detail', () => {
    const transport = new Error('fetch failed', {
      cause: Object.assign(new Error('the peer closed'), { code: 'UND_ERR_SOCKET' })
    })
    expect(remoteVisionTransportError(transport).message).toContain('the peer closed')
    expect(
      remoteVisionProviderError(429, {
        error: { metadata: { raw: 'Rate limited.', provider_name: 'Provider' } }
      }).message
    ).toContain('Rate limited.')
  })
})
