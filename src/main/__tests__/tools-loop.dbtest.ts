// Integration tests for the agentic tool loop — the REAL toolChat + REAL LLMService,
// over a real in-process fake llama-server socket and a real temp SQLite DB. The ONLY
// things faked are true external boundaries: the native engine (its tokens replayed as
// real SSE over http, see harness/fake-llama-server), Electron's userData dir, and the
// network (global fetch, for the web tools). No mock of our own code, no canned llm, no
// toHaveBeenCalled — the real streaming, real tool-call assembly, real dispatch/runTool,
// and the real built-in tools all execute. We assert terminal artifacts (the produced
// result, the streamed answer, r.imageRequest/r.unified, and what the model was sent).
import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { TickOutcome } from '@offgrid/use'
import { startFakeLlamaServer, type FakeLlamaServer } from './harness/fake-llama-server'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-tools-it-'))
// These cases test the tool loop, not embeddings: route by words at once instead of downloading
// the embedding model into this fresh folder on every run.
process.env.OFFGRID_EMBEDDINGS_OFFLINE = '1'
vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

// Imported AFTER the electron boundary is stubbed so their top-level app.getPath resolves.
import {
  toolChat,
  listTools,
  setToolEnabled,
  registerToolExtension,
  unregisterToolExtension,
  getToolExtensions,
  readUrlText
} from '../tools'
import { llm } from '../llm'
import { toolPromptChars, toolPromptTokens } from '../tools/prompt-budget'
import { HOOKS, registerHook, unregisterHook } from '../bootstrap/hookRegistry'
import { NativeActionToolExtension, type ActionsPort } from '../tools/nativeActionToolExtension'

let fake: FakeLlamaServer
type FakeTurn = Parameters<FakeLlamaServer['enqueue']>[number]

/** Queue the model turns consumed by the normal tool-calling loop. */
function enqueueReactiveAfterEmptyPlan(...turns: FakeTurn[]): void {
  fake.enqueue(...turns)
}

beforeAll(async () => {
  fake = await startFakeLlamaServer()
  // Point the REAL LLMService at the fake engine socket and mark it ready — init() then
  // no-ops (early-returns when initialized), so no native binary spawns. Every other line
  // of the service runs for real against the socket.
  const svc = llm as unknown as { port: number; initialized: boolean; paused: boolean }
  svc.port = fake.port
  svc.initialized = true
  svc.paused = false
})
beforeEach(() => fake.reset())
afterAll(async () => {
  await fake.close()
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('agentic tool loop — real toolChat + real LLMService over a fake llama socket', () => {
  it('resolves a pending Action chat decision before the model can infer another Action', async () => {
    registerHook(HOOKS.actionsResolveChatDecision, ({ conversationId, message }) => {
      return conversationId === 'execution-chat-17' && message === 'approved. please proceed'
        ? { answer: 'Approved. Off Grid AI is running this now.' }
        : null
    })
    try {
      const result = await toolChat('approved. please proceed', [], {
        conversationId: 'execution-chat-17'
      })

      expect(result.answer).toBe('Approved. Off Grid AI is running this now.')
      expect(result.toolCalls).toEqual([])
      expect(fake.requests).toEqual([])
    } finally {
      unregisterHook(HOOKS.actionsResolveChatDecision)
    }
  })

  it('streams reasoning + content and returns the answer when no tool is called', async () => {
    enqueueReactiveAfterEmptyPlan({ reasoning: 'Let me think', content: 'Hi there' })
    const deltas: { text: string; kind: string }[] = []
    const steps: string[] = []
    const r = await toolChat('hi', [], {
      onDelta: (t, k) => deltas.push({ text: t, kind: k }),
      onStep: (c) => steps.push(c.name)
    })

    expect(r.answer).toBe('Hi there')
    // Deltas arrive chunked (real streaming): the reasoning channel fired, and the content
    // deltas concatenate to the answer.
    expect(deltas.some((d) => d.kind === 'reasoning')).toBe(true)
    expect(
      deltas
        .filter((d) => d.kind === 'content')
        .map((d) => d.text)
        .join('')
    ).toBe('Hi there')
    expect(steps).toEqual([]) // no tool call -> no step
  })

  it('asks once more when a turn ends with no answer, and says why if there is still none', async () => {
    // Reported: God showed "No response returned." after its searches, with no reason given.
    enqueueReactiveAfterEmptyPlan(
      { content: '', finishReason: 'length' },
      { content: 'Here is what I found.' }
    )
    expect((await toolChat('what did Morgan send me?', [])).answer).toBe('Here is what I found.')
    expect(fake.requests).toHaveLength(2)

    fake.reset()
    enqueueReactiveAfterEmptyPlan(
      { content: '', finishReason: 'length' },
      { content: '', finishReason: 'length' }
    )
    const { answer } = await toolChat('and yesterday?', [])
    expect(answer).toMatch(/whole output allowance \(\d+ tokens\)/)
  })

  it('sends the user Max-output setting to the model, not the old hardcoded 1024 cap (essay cut-off)', async () => {
    // The agentic path used to force maxTokens: 1024, so a long "All memory" answer was truncated
    // mid-sentence at ~1024 tokens regardless of the setting/window. Now it inherits the setting.
    const svc = llm as unknown as { maxTokens: number }
    const prev = svc.maxTokens
    svc.maxTokens = 2000 // distinctive user cap that fits the smallest test context
    try {
      enqueueReactiveAfterEmptyPlan({ content: 'a long answer' })
      await toolChat('write a lot', [])
      const round1 = fake.requests[0] as { max_tokens?: number }
      expect(round1.max_tokens).toBe(2000) // inherits the user's setting…
      expect(round1.max_tokens).not.toBe(1024) // …never the removed hardcap
    } finally {
      svc.maxTokens = prev
    }
  })

  it('uses the remaining context window for an auto tool-loop answer', async () => {
    const svc = llm as unknown as { maxTokens: number }
    const prev = svc.maxTokens
    svc.maxTokens = 0 // MAX_TOKENS_AUTO
    try {
      enqueueReactiveAfterEmptyPlan({ content: 'ok' })
      await toolChat('hi', [])
      const maxTokens = (fake.requests[0] as { max_tokens?: number }).max_tokens
      expect(maxTokens).toBeGreaterThan(1024)
      expect(maxTokens).toBeLessThan(llm.effectiveContextSize())
    } finally {
      svc.maxTokens = prev
    }
  })

  it('executes a tool call, fires onStep before running it, feeds the result back, then answers', async () => {
    fake.enqueue({ toolCalls: [{ name: 'get_datetime', args: {} }] }, { content: 'It is now.' })
    const steps: string[] = []
    const r = await toolChat('get_datetime: what time is it', [], {
      onStep: (c) => steps.push(c.name)
    })

    expect(steps).toEqual(['get_datetime']) // step surfaced BEFORE execution
    expect(r.toolCalls.map((c) => c.name)).toEqual(['get_datetime'])
    expect(r.toolCalls[0]!.result).toBeTruthy() // real get_datetime output
    expect(r.answer).toBe('It is now.')
    // The loop fed the result back: round-2 request carries the assistant tool_call turn + the tool result.
    const round2 = fake.requests[1] as { messages?: Array<{ role: string }> }
    expect(round2.messages?.some((m) => m.role === 'tool')).toBe(true)
    expect(round2.messages?.some((m) => m.role === 'assistant')).toBe(true)
  })

  it('resolves a contact and sends the Chat message directly with the Pro approval hook active', async () => {
    const approvalCopies: unknown[] = []
    registerHook(HOOKS.actionsProposeApproval, (request) => {
      approvalCopies.push(request)
      return true
    })
    const proposals: Array<{ input: unknown; meta: unknown }> = []
    const actions: ActionsPort = {
      propose: async (input, meta) => {
        proposals.push({ input, meta })
        return { accepted: true, id: 'message-ali-1', deduped: false }
      },
      waitForOutcome: async () =>
        ({
          id: 'message-ali-1',
          outcome: 'done',
          record: { attemptLog: [] }
        }) as unknown as TickOutcome,
      whenParked: () => new Promise<void>(() => {}),
      kick: () => {}
    }
    const extension = new NativeActionToolExtension(
      {
        run: async ({ command }) =>
          command === 'contacts.search'
            ? { ok: true, result: [{ name: 'Ali', phone: '+15551111' }] }
            : { ok: false, error: `Unexpected inline command: ${command}` },
        taskUseEnabled: () => true,
        actions
      },
      'darwin'
    )
    registerToolExtension(extension)
    fake.enqueue(
      { toolCalls: [{ name: 'contacts_search', args: { query: 'Ali' } }] },
      {
        toolCalls: [{ name: 'messages_send', args: { to: '+15551111', text: 'I am on my way' } }]
      },
      { content: 'Your message was sent.' }
    )

    try {
      const result = await toolChat('contacts_search Ali, then messages_send I am on my way', [], {
        conversationId: 'chat-ali'
      })

      expect(result.toolsOffered).toEqual(
        expect.arrayContaining(['contacts_search', 'messages_send'])
      )
      expect(result.toolCalls.map(({ name }) => name)).toEqual(['contacts_search', 'messages_send'])
      expect(result.toolCalls.at(-1)?.result).toBe('Sent the message.')
      expect(result.answer).toBe('Your message was sent.')
      expect(proposals).toEqual([
        {
          input: expect.objectContaining({
            type: 'message',
            args: { to: '+15551111', text: 'I am on my way' }
          }),
          meta: { source: 'chat', sourceRef: 'chat-ali' }
        }
      ])
      expect(approvalCopies).toEqual([])
      expect(JSON.stringify(result)).not.toMatch(/queued for.*approval/i)
    } finally {
      unregisterToolExtension(extension.id, extension)
      unregisterHook(HOOKS.actionsProposeApproval)
    }
  })

  it('proposes the explicit Skyscanner Web Use tool call selected by the model', async () => {
    const query =
      'Use web_use to go to skyscanner.com and help me find the cheapest flight to book for a one way trip from San Francisco 2026 to Pune on 1st September 2026 with a budget range of $500 - $3000'
    const proposals: Array<{ input: unknown; meta: unknown }> = []
    const actions: ActionsPort = {
      propose: async (input, meta) => {
        proposals.push({ input, meta })
        return { accepted: true, id: 'web-skyscanner-1', deduped: false }
      },
      waitForOutcome: async () =>
        ({
          id: 'web-skyscanner-1',
          outcome: 'done',
          record: { attemptLog: [] }
        }) as unknown as TickOutcome,
      whenParked: () => new Promise<void>(() => {}),
      kick: () => {}
    }
    const extension = new NativeActionToolExtension(
      {
        run: async () => ({ ok: true, result: undefined }),
        taskUseEnabled: () => true,
        actions
      },
      'darwin'
    )
    registerToolExtension(extension)
    fake.enqueue(
      {
        reasoning: 'The request is complete, so Web Use can start.',
        toolCalls: [{ name: 'web_use', args: { goal: query, url: 'https://skyscanner.com' } }]
      },
      { content: 'Web Use is ready.' }
    )
    const steps: string[] = []
    try {
      const result = await toolChat(query, [], {
        conversationId: 'chat-skyscanner',
        onStep: ({ name }) => steps.push(name)
      })

      expect(steps).toEqual(['web_use'])
      expect(result.toolCalls.map(({ name }) => name)).toEqual(['web_use'])
      expect(result.answer).toBe(
        'Task reference: web-skyscanner-1. Web Use started. Live progress and the final result will appear in this chat. Do not call web_use again for this goal.'
      )
      expect(fake.requests).toHaveLength(1)
      expect(proposals).toEqual([
        {
          input: {
            type: 'web_use',
            intent: query,
            args: { goal: expect.stringContaining(query), url: 'https://skyscanner.com' },
            risk: 'mutate'
          },
          meta: { source: 'chat', sourceRef: 'chat-skyscanner' }
        }
      ])
    } finally {
      unregisterToolExtension(extension.id, extension)
    }
  })

  it('starts the complete Web Use goal selected from the full conversation', async () => {
    const originalRequest =
      'Go to skyscanner.com and help me find the cheapest flight to book for a one way trip from San Francisco 2026 to Pune on 1st September 2026 with a budget range of $500 - $3000'
    const followUp = 'web_use: 1. SFO 2. Nothing really 3. 1 stop'
    const completeGoal =
      'Find the cheapest one-way flight from SFO to Pune on September 1, 2026, within $500-$3,000, with at most one stop and no airline or cabin preference.'
    const proposals: Array<{ input: unknown; meta: unknown }> = []
    const actions: ActionsPort = {
      propose: async (input, meta) => {
        proposals.push({ input, meta })
        return { accepted: true, id: 'web-flight-follow-up', deduped: false }
      },
      waitForOutcome: async () =>
        ({
          id: 'web-flight-follow-up',
          outcome: 'done',
          record: { attemptLog: [] }
        }) as unknown as TickOutcome,
      whenParked: () => new Promise<void>(() => {}),
      kick: () => {}
    }
    const extension = new NativeActionToolExtension(
      {
        run: async () => ({ ok: true, result: undefined }),
        taskUseEnabled: () => true,
        actions
      },
      'darwin'
    )
    registerToolExtension(extension)
    fake.enqueue(
      {
        reasoning: 'The earlier request and follow-up provide the full task.',
        toolCalls: [
          {
            name: 'web_use',
            args: { goal: completeGoal, url: 'https://skyscanner.com' }
          }
        ]
      },
      { content: 'Web Use is ready.' }
    )
    const activities: string[] = []

    try {
      const history = [
        { role: 'user', content: originalRequest },
        { role: 'assistant', content: 'Which airport and how many stops?' }
      ]
      const second = await toolChat(followUp, history, {
        conversationId: 'chat-flight-follow-up',
        onActivity: ({ label }) => activities.push(label)
      })

      expect(second.answer).toBe(
        'Task reference: web-flight-follow-up. Web Use started. Live progress and the final result will appear in this chat. Do not call web_use again for this goal.'
      )
      expect(second.toolCalls).toEqual([
        expect.objectContaining({ name: 'web_use', status: 'pending' })
      ])
      expect(activities).toEqual(['Preparing actions…'])
      expect(proposals).toEqual([
        {
          input: {
            type: 'web_use',
            intent: completeGoal,
            args: { goal: expect.stringContaining(completeGoal), url: 'https://skyscanner.com' },
            risk: 'mutate'
          },
          meta: { source: 'chat', sourceRef: 'chat-flight-follow-up' }
        }
      ])
      const submittedGoal = String(
        (proposals[0]?.input as { args?: { goal?: string } }).args?.goal ?? ''
      )
      expect(submittedGoal).toContain(followUp)
      expect(submittedGoal).toContain(completeGoal)
    } finally {
      unregisterToolExtension(extension.id, extension)
    }
  })

  it('runs a reactive Web Use call without an application-side intake gate', async () => {
    const proposals: unknown[] = []
    const actions: ActionsPort = {
      propose: async (input) => {
        proposals.push(input)
        return { accepted: true, id: 'reactive-web-task', deduped: false }
      },
      waitForOutcome: async () =>
        ({
          id: 'reactive-web-task',
          outcome: 'done',
          record: { attemptLog: [] }
        }) as unknown as TickOutcome,
      whenParked: () => new Promise<void>(() => {}),
      kick: () => {}
    }
    const extension = new NativeActionToolExtension(
      {
        run: async () => ({ ok: true, result: undefined }),
        taskUseEnabled: () => true,
        actions
      },
      'darwin'
    )
    registerToolExtension(extension)
    fake.enqueue(
      {
        toolCalls: [
          {
            name: 'web_use',
            args: { goal: 'Find a flight', url: 'https://skyscanner.com' }
          }
        ]
      },
      { content: 'I have initiated Web Use.' }
    )

    try {
      const result = await toolChat('web_use do it', [], { conversationId: 'chat-reactive-intake' })
      expect(result.answer).toBe(
        'Task reference: reactive-web-task. Web Use started. Live progress and the final result will appear in this chat. Do not call web_use again for this goal.'
      )
      expect(result.toolCalls[0]?.status).toBe('pending')
      expect(proposals).toHaveLength(1)
      expect(fake.requests).toHaveLength(1)
    } finally {
      unregisterToolExtension(extension.id, extension)
    }
  })

  it('in assistant mode, acting is always offered and the model is told when to use it', async () => {
    // God's tools do not depend on the words of the message: the model decides from the prompt.
    const extension = new NativeActionToolExtension(
      { run: async () => ({ ok: true, result: undefined }), taskUseEnabled: () => true },
      'darwin'
    )
    registerToolExtension(extension)
    const first = (): {
      tools?: { function?: { name?: string } }[]
      messages?: { content?: unknown }[]
    } => fake.requests[0] as never
    const offered = (): string[] => (first().tools ?? []).map((t) => t.function?.name ?? '')
    try {
      fake.enqueue({ content: 'Pick one with good reviews.' })
      const question = await toolChat('what is a good cooking video on youtube?', [], {
        assistantOnly: true
      })
      expect(question.toolCalls).toEqual([])
      expect(offered()).toContain('web_use')
      expect(String(first().messages?.[0]?.content)).toContain(
        'Answer questions directly. Call web_use only when the user asks you to do something on a website.'
      )

      // A request that shares no words with the tool still has it.
      fake.reset()
      fake.enqueue({ content: 'ok' })
      await toolChat('can you do a sanity check of this entire website?', [], {
        assistantOnly: true
      })
      expect(offered()).toContain('web_use')
    } finally {
      unregisterToolExtension(extension.id, extension)
    }
  })

  it('passes the tool schemas + tool_choice to the model on the first round', async () => {
    enqueueReactiveAfterEmptyPlan({ content: 'ok' })
    await toolChat('get_datetime: what time is it', [])
    const round1 = fake.requests[0] as { tools?: unknown[]; tool_choice?: string }
    expect(Array.isArray(round1.tools)).toBe(true)
    expect((round1.tools ?? []).length).toBeGreaterThan(0)
    expect(round1.tool_choice).toBe('auto')
  })

  it('keeps the first message unchanged on the next turn so the engine reuses its prompt cache', async () => {
    type Round = { tools?: { function?: { name?: string } }[]; messages?: { content?: unknown }[] }
    const names = (round: Round): string[] => (round.tools ?? []).map((t) => t.function?.name ?? '')
    const firstQuestion = 'calculator: what is (3+4)*2'
    fake.enqueue({ content: 'It is 14.' })
    await toolChat(firstQuestion, [], { conversationId: 'chat-prompt-cache' })
    const turn1 = fake.requests[0] as Round

    fake.reset()
    fake.enqueue({ content: 'It is noon.' })
    await toolChat(
      'get_datetime: what time is it',
      [
        { role: 'user', content: firstQuestion },
        { role: 'assistant', content: 'It is 14.' }
      ],
      { conversationId: 'chat-prompt-cache' }
    )
    const turn2 = fake.requests[0] as Round

    // The earlier tools lead in the same order, the new pick follows, and the system text holds.
    expect(names(turn2).slice(0, names(turn1).length)).toEqual(names(turn1))
    expect(names(turn2)).toContain('get_datetime')
    expect(turn2.messages?.[0]?.content).toEqual(turn1.messages?.[0]?.content)

    // Another conversation starts from its own message, not this chat's tools.
    fake.reset()
    fake.enqueue({ content: 'It is noon.' })
    await toolChat('get_datetime: what time is it', [], { conversationId: 'chat-fresh' })
    expect(names(fake.requests[0] as Round)[0]).toBe('get_datetime')
  })

  it('uses the configured tool-step budget beyond the old five-step cap', async () => {
    await llm.setSettings({ maxToolCalls: 7 })
    try {
      enqueueReactiveAfterEmptyPlan(
        ...Array.from({ length: 7 }, (_, step) => ({
          toolCalls: [{ name: 'calculator', args: { expression: `${String(step)}+1` } }]
        })),
        { content: 'Finished after seven tool calls.' }
      )
      const r = await toolChat('calculator: keep going', [])

      expect(r.toolCalls).toHaveLength(7)
      expect(r.answer).toBe('Finished after seven tool calls.')
      expect(fake.requests).toHaveLength(8)
    } finally {
      await llm.setSettings({ maxToolCalls: 25 })
    }
  })

  it('runs the calculator the model asks for, feeds the real result back, and answers', async () => {
    fake.enqueue(
      { toolCalls: [{ name: 'calculator', args: { expression: '(3+4)*2' } }] },
      { content: 'The answer is 14.' }
    )
    const r = await toolChat('calculator: what is (3+4)*2', [])
    expect(r.toolCalls.map((c) => ({ name: c.name, result: c.result }))).toContainEqual({
      name: 'calculator',
      result: '14'
    })
    expect(r.answer).toContain('14')
    expect(JSON.stringify((fake.requests[1] as { messages?: unknown[] }).messages ?? [])).toContain(
      '14'
    )
  })

  it('recovers a tool call the model emitted as TEXT (no native tool_calls) and runs it', async () => {
    // The small on-device models we ship often print <tool_call>{…} as content
    // instead of using the tool_calls channel. The loop must recover it, run the
    // tool for real, feed the result back, and still answer — not narrate a dead
    // "I would calculate…". Round 1 has NO toolCalls, only text.
    fake.enqueue(
      {
        content:
          'Let me compute that.\n<tool_call>{"name":"calculator","arguments":{"expression":"2+2"}}</tool_call>'
      },
      { content: 'It is 4.' }
    )
    const steps: string[] = []
    const r = await toolChat('calculator: what is 2+2', [], { onStep: (c) => steps.push(c.name) })

    expect(steps).toEqual(['calculator']) // recovered from text + surfaced before running
    expect(r.toolCalls.map((c) => ({ name: c.name, result: c.result }))).toContainEqual({
      name: 'calculator',
      result: '4'
    })
    expect(r.answer).toContain('4')
    // The recovered call was fed back as a real tool turn on round 2.
    const round2 = fake.requests[1] as { messages?: Array<{ role: string }> }
    expect(round2.messages?.some((m) => m.role === 'tool')).toBe(true)
  })

  it('forces a real final answer when the configured emergency limit is reached', async () => {
    await llm.setSettings({ maxToolCalls: 3 })
    try {
      enqueueReactiveAfterEmptyPlan(
        ...Array.from({ length: 3 }, (_, step) => ({
          toolCalls: [{ name: 'calculator', args: { expression: `${String(step)}+1` } }]
        })),
        { content: 'Based on the tools, here is your answer.' }
      )
      const r = await toolChat('calculator: keep going', [])
      expect(r.toolCalls).toHaveLength(3)
      expect(r.answer).toBe('Based on the tools, here is your answer.')
      expect(r.answer).not.toMatch(/too many tool steps/i)
      const lastReq = fake.requests[fake.requests.length - 1] as { tools?: unknown[] }
      expect(lastReq.tools ?? []).toHaveLength(0)
    } finally {
      await llm.setSettings({ maxToolCalls: 25 })
    }
  })

  it('never saves a second Gemma tool request or raw tool output after the limit', async () => {
    await llm.setSettings({ maxToolCalls: 1 })
    try {
      enqueueReactiveAfterEmptyPlan(
        { toolCalls: [{ name: 'calculator', args: { expression: '2+2' } }] },
        {
          content: '<|tool_call>call:web_use{query:<|"|>Off Grid AI information<|"|>}<tool_call|>'
        }
      )
      const deltas: string[] = []

      const result = await toolChat('calculator: calculate 2+2, then search for Off Grid AI', [], {
        onDelta: (text, kind) => {
          if (kind === 'content') deltas.push(text)
        }
      })

      expect(result.toolCalls).toHaveLength(1)
      expect(result.answer).toBe('Stopped after too many tool steps.')
      expect(result.answer).not.toMatch(/tool_call|web_use/i)
      expect(deltas.join('')).toBe('')
    } finally {
      await llm.setSettings({ maxToolCalls: 25 })
    }
  })

  it('counts parallel tool calls against the configured emergency limit', async () => {
    await llm.setSettings({ maxToolCalls: 2 })
    try {
      enqueueReactiveAfterEmptyPlan(
        {
          toolCalls: [
            { name: 'calculator', args: { expression: '1+1' } },
            { name: 'calculator', args: { expression: '2+2' } },
            { name: 'calculator', args: { expression: '3+3' } }
          ]
        },
        { content: 'Stopped after the configured two calls.' }
      )

      const r = await toolChat('calculator: use only the allowed calls', [])

      expect(r.toolCalls).toHaveLength(2)
      expect(r.answer).toBe('Stopped after the configured two calls.')
      const lastReq = fake.requests[fake.requests.length - 1] as { tools?: unknown[] }
      expect(lastReq.tools ?? []).toHaveLength(0)
    } finally {
      await llm.setSettings({ maxToolCalls: 25 })
    }
  })

  it('does not save successful tool output as the answer when the final model turn is empty', async () => {
    enqueueReactiveAfterEmptyPlan(
      { toolCalls: [{ name: 'calculator', args: { expression: '2+2' } }] },
      { content: '' },
      { content: '' }
    )
    const deltas: string[] = []

    const result = await toolChat('calculator: what is 2+2', [], {
      onDelta: (text, kind) => {
        if (kind === 'content') deltas.push(text)
      }
    })

    // Never the tool's raw output: an empty turn is asked once more, then explained.
    expect(result.answer).not.toContain('4')
    expect(result.answer).toMatch(/without an answer/)
    expect(deltas.join('')).toBe('')
  })

  it('bounds each tool result to the room left in the active model window', async () => {
    const raw = 'x'.repeat(30_000)
    const extension = {
      id: 'large-result-ext',
      schemas: () => [
        {
          type: 'function',
          function: {
            name: 'large_result',
            description: 'Return a large result',
            parameters: { type: 'object', properties: {} }
          }
        }
      ],
      canHandle: (name: string) => name === 'large_result',
      execute: async () => raw
    }
    registerToolExtension(extension)
    const service = llm as unknown as { ctxSize: number }
    const previousContext = service.ctxSize
    service.ctxSize = 2_048
    try {
      enqueueReactiveAfterEmptyPlan(
        { toolCalls: [{ name: 'large_result', args: {} }] },
        { content: 'Used the bounded result.' }
      )

      const result = await toolChat('large_result: read it', [], { connectors: true })

      expect(result.toolCalls[0]!.result.length).toBeLessThan(raw.length)
      expect(result.toolCalls[0]!.result).toMatch(
        /result truncated: showing the first \d+ of 30000 characters/
      )
      expect(result.toolCalls[0]!.result.length).toBeLessThanOrEqual(2_048 * 4)
      expect(JSON.stringify(fake.requests[1])).not.toContain(raw)
    } finally {
      service.ctxSize = previousContext
      unregisterToolExtension(extension.id, extension)
    }
  })

  it('rejects a non-arithmetic calculator expression (real guard branch)', async () => {
    enqueueReactiveAfterEmptyPlan(
      { toolCalls: [{ name: 'calculator', args: { expression: 'process.exit(1)' } }] },
      { content: 'Cannot compute that.' }
    )
    const r = await toolChat('calculator evil', [])
    expect(r.toolCalls[0]!.result).toMatch(/only basic arithmetic/i)
  })

  it('tolerates malformed tool arguments (non-JSON args string)', async () => {
    // The engine can emit invalid JSON for arguments; the real accumulator/parse must not throw.
    enqueueReactiveAfterEmptyPlan(
      { toolCalls: [{ name: 'get_datetime', argsRaw: 'not-json' }] },
      { content: 'done' }
    )
    const r = await toolChat('get_datetime time', [])
    expect(r.toolCalls[0]!.name).toBe('get_datetime')
    expect(r.answer).toBe('done')
  })

  it('surfaces an actionable server error (context overflow) instead of a bare status', async () => {
    enqueueReactiveAfterEmptyPlan({
      errorStatus: 400,
      errorBody: JSON.stringify({
        error: { message: 'the request exceeds the available context size' }
      })
    })
    await expect(toolChat('anything', [])).rejects.toThrow(/context window|connectors/i)
  })

  // --- generate_image (gated + deferred side-channel) ---------------------------
  it('offers generate_image only when an image model is available', async () => {
    enqueueReactiveAfterEmptyPlan({ content: 'ok' })
    await toolChat('generate_image draw a cat', [], { imageAvailable: true })
    const withImg = fake.requests[0] as { tools: { function: { name: string } }[] }
    expect(withImg.tools.map((t) => t.function.name)).toContain('generate_image')

    fake.reset()
    enqueueReactiveAfterEmptyPlan({ content: 'ok' })
    await toolChat('generate_image draw a cat', [], { imageAvailable: false })
    const withoutImg = fake.requests[0] as { tools?: { function: { name: string } }[] }
    expect((withoutImg.tools ?? []).map((t) => t.function.name)).not.toContain('generate_image')
  })

  it('records the requested prompt as imageRequest, fires onStep, and still returns the answer', async () => {
    enqueueReactiveAfterEmptyPlan(
      {
        toolCalls: [
          {
            name: 'generate_image',
            args: { prompt: 'a red bicycle on a beach', enhance_prompt: false }
          }
        ]
      },
      { content: 'Here is your image.' }
    )
    const steps: string[] = []
    const r = await toolChat('generate_image a picture of a red bicycle', [], {
      imageAvailable: true,
      onStep: (c) => steps.push(c.name)
    })
    expect(steps).toEqual(['generate_image'])
    expect(r.imageRequest).toEqual({
      prompt: 'a red bicycle on a beach',
      enhancePrompt: false
    })
    expect(r.toolCalls[0]!.result).toMatch(/will appear in the chat/i) // placeholder fed back
    expect(r.answer).toBe('Here is your image.')
  })

  it('keeps every generate_image request in tool-call order', async () => {
    enqueueReactiveAfterEmptyPlan(
      {
        toolCalls: [
          { name: 'generate_image', args: { prompt: 'first' } },
          { name: 'generate_image', args: { prompt: 'second' } }
        ]
      },
      { content: 'done' }
    )
    const r = await toolChat('generate_image two pictures', [], { imageAvailable: true })
    expect(r.imageRequests).toEqual([{ prompt: 'first' }, { prompt: 'second' }])
  })

  it('does not record an imageRequest when the prompt is empty', async () => {
    enqueueReactiveAfterEmptyPlan(
      { toolCalls: [{ name: 'generate_image', args: { prompt: '   ' } }] },
      { content: 'I could not tell what to draw.' }
    )
    const r = await toolChat('generate_image draw', [], { imageAvailable: true })
    expect(r.imageRequest).toBeUndefined()
    expect(r.toolCalls[0]!.result).toMatch(/no image prompt/i)
  })

  // --- connector/extension routing (a test-provided extension = the MCP boundary) ----
  it('routes a connector tool through the registered extension and returns its real result', async () => {
    registerToolExtension({
      id: 'test-ext',
      schemas: () => [
        {
          type: 'function',
          function: {
            name: 'ext_tool',
            description: 'x',
            parameters: { type: 'object', properties: {} }
          }
        }
      ],
      canHandle: (n) => n === 'ext_tool',
      execute: async () => 'ext-result',
      systemHint: () => 'Extra hint.'
    })
    expect(getToolExtensions().some((e) => e.id === 'test-ext')).toBe(true)
    fake.enqueue({ toolCalls: [{ name: 'ext_tool', args: {} }] }, { content: 'used the connector' })
    const r = await toolChat('ext_tool do it', [], { connectors: true })
    // Terminal artifact: the extension actually ran and its result flowed back into the loop.
    expect(r.toolCalls[0]).toMatchObject({ name: 'ext_tool', result: 'ext-result' })
    expect(r.answer).toBe('used the connector')
  })

  // --- abort: a cancelled turn runs NO tool side effect (D15) --------------------
  it('a cancelled turn runs NO tool — Stop after the tool_call streams, before execution', async () => {
    let ran = false
    registerToolExtension({
      id: 'abort-ext',
      schemas: () => [
        {
          type: 'function',
          function: {
            name: 'abort_tool',
            description: 'x',
            parameters: { type: 'object', properties: {} }
          }
        }
      ],
      canHandle: (n) => n === 'abort_tool',
      execute: async () => {
        ran = true
        return 'should-never-run'
      },
      systemHint: () => ''
    })
    // The server streams the tool_call then HANGS; we hit Stop mid-turn — after the call
    // arrived but before runTool. The real abort guard must skip execution.
    fake.enqueue({ toolCalls: [{ name: 'abort_tool', args: {} }], hold: true })
    const ac = new AbortController()
    const p = toolChat('do the thing', [], { connectors: true, signal: ac.signal })
    await new Promise((r) => setTimeout(r, 60)) // let the tool_call frame stream + the server hang
    ac.abort()
    await p
    expect(ran).toBe(false) // the MCP write tool never fired after Stop
  })

  // --- DIP guard: the loop must not re-introduce per-tool-name branching ----------
  it('dispatches every tool uniformly — no c.name special-casing in the loop', () => {
    const src = fs.readFileSync(path.join(__dirname, '../tools.ts'), 'utf8')
    expect(src).not.toMatch(/c\.name === ['"]search_memory['"]/)
    expect(src).not.toMatch(/c\.name === ['"]generate_image['"]/)
  })
})

describe('tools registry surface (real settings DB)', () => {
  it('listTools reports every built-in as enabled by default; disabling one persists + reflects', () => {
    // Real getSetting/saveSetting against the temp DB — no mock.
    const all = listTools()
    expect(all.length).toBeGreaterThan(0)
    expect(all.map((t) => t.name)).toContain('calculator')
    expect(all.every((t) => t.enabled)).toBe(true)

    setToolEnabled('calculator', false)
    expect(listTools().find((t) => t.name === 'calculator')?.enabled).toBe(false)
    setToolEnabled('calculator', true) // restore for other tests
    expect(listTools().find((t) => t.name === 'calculator')?.enabled).toBe(true)
  })
})

describe('web tools — real parsers over fetch faked at the network boundary', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('readUrlText strips tags + decodes entities into readable text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () =>
          '<html><body><script>x()</script><h1>Title &amp; more</h1><p>Hello&nbsp;world</p></body></html>'
      }))
    )
    const text = await readUrlText('example.com') // no scheme -> https:// prepended
    expect(text).toContain('Title & more')
    expect(text).toContain('Hello world')
    expect(text).not.toContain('<h1>')
    expect(text).not.toContain('x()')
  })

  it('readUrlText throws on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => '' }))
    )
    await expect(readUrlText('https://example.com')).rejects.toThrow(/HTTP 500/)
  })

  it('web_search parses DuckDuckGo result links + snippets through the real loop', async () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2FAchilles">Achilles - Wikipedia</a>
      <a class="result__snippet">A hero of the Trojan War.</a>`
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, text: async () => html }))
    )
    enqueueReactiveAfterEmptyPlan(
      { toolCalls: [{ name: 'web_search', args: { query: 'achilles' } }] },
      { content: 'Here is what I found.' }
    )
    const r = await toolChat('search achilles', [])
    expect(r.toolCalls[0]!.result).toContain('en.wikipedia.org/Achilles')
    expect(r.toolCalls[0]!.result).toContain('Achilles - Wikipedia')
    expect(r.toolCalls[0]!.result).toContain('Trojan War')
  })

  it('web_search falls back when DuckDuckGo returns an anti-bot page', async () => {
    const fetchResponses = [
      {
        ok: true,
        status: 202,
        text: async () =>
          '<html><div class="anomaly-modal__title">Unfortunately, bots.</div></html>'
      },
      {
        ok: true,
        status: 200,
        text: async () => `<?xml version="1.0"?><rss><channel><item>
          <title>Wednesday Solutions</title>
          <link>https://www.wednesday.is/</link>
          <description>Product engineering and design.</description>
        </item></channel></rss>`
      }
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fetchResponses.shift()!)
    )
    enqueueReactiveAfterEmptyPlan(
      { toolCalls: [{ name: 'web_search', args: { query: 'Wednesday Solutions' } }] },
      { content: 'Here is what I found.' }
    )

    const r = await toolChat('search Wednesday Solutions', [])

    expect(r.toolCalls[0]!.result).toContain('https://www.wednesday.is/')
    expect(r.toolCalls[0]!.result).toContain('Product engineering and design.')
  })

  it('does not leak <tool_call> markup into the visible content stream (still runs the tool)', async () => {
    // Round 1 emits the call as TEXT. The user must NOT see the raw <tool_call>{…}
    // flash in the answer stream, but the tool must still run and the turn answer.
    fake.enqueue(
      {
        content:
          'Let me compute. <tool_call>{"name":"calculator","arguments":{"expression":"6*7"}}</tool_call>'
      },
      { content: 'It is 42.' }
    )
    const contentDeltas: string[] = []
    const r = await toolChat('calculator: what is 6*7', [], {
      onDelta: (t, k) => {
        if (k === 'content') contentDeltas.push(t)
      }
    })
    const streamed = contentDeltas.join('')
    expect(streamed).not.toContain('<tool_call>') // markup filtered from the visible stream
    expect(streamed).not.toContain('calculator') // the JSON args never flashed either
    expect(r.toolCalls.map((c) => c.result)).toContain('42') // ...but the tool DID run
    expect(r.answer).toContain('42')
  })

  it('backfills the user query when the model calls web_search with an empty query', async () => {
    // A small model calls web_search with no query. The loop must backfill the
    // user's message so a real search runs instead of erroring on an empty query.
    let searchedUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        searchedUrl = url
        return {
          ok: true,
          text: async () =>
            '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Ex</a>'
        }
      })
    )
    fake.enqueue(
      { toolCalls: [{ name: 'web_search', args: {} }] }, // NO query
      { content: 'Found it.' }
    )
    const steps: { name: string; args: Record<string, unknown> }[] = []
    const r = await toolChat('tell me about achilles the hero', [], {
      onStep: (c) => steps.push(c)
    })

    // The user's message was backfilled as the query — surfaced in onStep AND sent to the network.
    expect(steps[0]!.args.query).toBe('tell me about achilles the hero')
    expect(decodeURIComponent(searchedUrl)).toContain('achilles the hero')
    expect(r.toolCalls[0]!.result).toContain('example.com')
  })
  // --- harness recovery: errors, misnamed tools, repeats, stale results -------------
  it('feeds an unknown tool back to the model with the real tool names instead of ending the answer', async () => {
    enqueueReactiveAfterEmptyPlan(
      { toolCalls: [{ name: 'teleport', args: { to: 'Athens' } }] },
      { content: 'I cannot teleport, but here is the answer.' }
    )
    const r = await toolChat('calculator: what is 2+2', [])

    expect(r.answer).toBe('I cannot teleport, but here is the answer.')
    expect(r.toolCalls[0]).toMatchObject({ name: 'teleport', status: 'failed' })
    expect(r.toolCalls[0]!.result).toMatch(/no tool named "teleport"\. Available tools: .*calculator/)
    expect(JSON.stringify(fake.requests[1])).toContain('no tool named')
  })

  it('runs the offered tool a small model meant when it calls it by another name', async () => {
    enqueueReactiveAfterEmptyPlan(
      { toolCalls: [{ name: 'calculate', args: { expression: '2+3' } }] },
      { content: 'It is 5.' }
    )
    const steps: string[] = []
    const r = await toolChat('calculator: what is 2+3', [], { onStep: (c) => steps.push(c.name) })

    expect(steps).toEqual(['calculator'])
    expect(r.toolCalls[0]).toMatchObject({ name: 'calculator', result: '5', status: 'completed' })
    expect(r.answer).toBe('It is 5.')
  })

  it('lets the model recover after a tool throws, without claiming the failed call succeeded', async () => {
    const extension = {
      id: 'throwing-ext',
      schemas: () => [
        {
          type: 'function',
          function: {
            name: 'flaky_lookup',
            description: 'Look something up',
            parameters: { type: 'object', properties: { id: { type: 'string' } } }
          }
        }
      ],
      canHandle: (name: string) => name === 'flaky_lookup',
      execute: async (_name: string, args: Record<string, unknown>) => {
        if (args.id === 'bad') throw new Error('record bad was not found')
        return 'record good: active'
      }
    }
    registerToolExtension(extension)
    try {
      enqueueReactiveAfterEmptyPlan(
        { toolCalls: [{ name: 'flaky_lookup', args: { id: 'bad' } }] },
        { toolCalls: [{ name: 'flaky_lookup', args: { id: 'good' } }] },
        { content: 'Record good is active.' }
      )
      const r = await toolChat('flaky_lookup: check the record', [], { connectors: true })

      expect(r.answer).toBe('Record good is active.')
      expect(r.toolCalls.map((c) => c.status)).toEqual(['failed', 'completed'])
      expect(r.toolCalls[0]!.result).toMatch(/flaky_lookup failed: record bad was not found/)
      expect(r.toolCalls[0]!.result).toMatch(/do not claim it succeeded/i)
    } finally {
      unregisterToolExtension(extension.id, extension)
    }
  })

  it('does not rerun a repeated identical call, and ends tool use when the model keeps repeating', async () => {
    enqueueReactiveAfterEmptyPlan(
      { toolCalls: [{ name: 'calculator', args: { expression: '2+2' } }] },
      { toolCalls: [{ name: 'calculator', args: { expression: '2+2' } }] },
      { toolCalls: [{ name: 'calculator', args: { expression: '2+2' } }] },
      { content: 'It is 4.' }
    )
    const steps: string[] = []
    const r = await toolChat('calculator: what is 2+2', [], { onStep: (c) => steps.push(c.name) })

    expect(steps).toEqual(['calculator']) // only the first call ran
    expect(r.toolCalls).toHaveLength(1)
    expect(r.answer).toBe('It is 4.')
    expect(JSON.stringify(fake.requests[2])).toContain('already called calculator')
    const finalRequest = fake.requests[3] as { tools?: unknown[]; messages?: unknown[] }
    expect(finalRequest.tools ?? []).toHaveLength(0)
    expect(JSON.stringify(finalRequest.messages)).toContain('kept repeating the same calculator call')
  })

  it('elides older bulky tool results once the window fills, keeping the latest two whole', async () => {
    const pageText = (page: number): string => `page${String(page)} `.repeat(1_000)
    const extension = {
      id: 'big-page-ext',
      schemas: () => [
        {
          type: 'function',
          function: {
            name: 'big_page',
            description: 'Read one long page',
            parameters: { type: 'object', properties: { page: { type: 'number' } } }
          }
        }
      ],
      canHandle: (name: string) => name === 'big_page',
      execute: async (_name: string, args: Record<string, unknown>) => pageText(Number(args.page))
    }
    registerToolExtension(extension)
    const service = llm as unknown as { ctxSize: number }
    const previousContext = service.ctxSize
    service.ctxSize = 8_192
    try {
      enqueueReactiveAfterEmptyPlan(
        ...[1, 2, 3, 4].map((page) => ({ toolCalls: [{ name: 'big_page', args: { page } }] })),
        { content: 'Compared all four pages.' }
      )
      const r = await toolChat('big_page: compare four pages', [], { connectors: true })

      expect(r.answer).toBe('Compared all four pages.')
      const finalRequest = fake.requests[4] as {
        messages: { role: string; content: unknown }[]
      }
      const toolContents = finalRequest.messages
        .filter((m) => m.role === 'tool')
        .map((m) => String(m.content))
      expect(toolContents).toHaveLength(4)
      expect(toolContents[0]).toMatch(
        /^\[big_page result elided to save context: \d+ characters\. Call big_page again/
      )
      expect(toolContents[2]).toBe(pageText(3))
      expect(toolContents[3]).toBe(pageText(4))
    } finally {
      service.ctxSize = previousContext
      unregisterToolExtension(extension.id, extension)
    }
  })
  it('folds a conversation that fills the window into a structured summary the next round uses', async () => {
    const history = [
      { role: 'user', content: 'Plan a trip to Lisbon in May for two' },
      { role: 'assistant', content: `Four-day plan ${'museum detail '.repeat(1_500)}OLD-PLAN-END` },
      { role: 'user', content: 'Make it three days' },
      { role: 'assistant', content: 'Here is the three-day plan.' }
    ]
    const summary =
      '## Goal\nA three-day Lisbon trip in May for two.\n## Where we left off\nThe three-day plan.'
    const service = llm as unknown as { ctxSize: number }
    const previousContext = service.ctxSize
    service.ctxSize = 4_096
    try {
      enqueueReactiveAfterEmptyPlan({ content: summary }, { content: 'Added a day trip to Sintra.' })
      const activities: unknown[] = []
      const deltas: string[] = []
      const r = await toolChat('Add a day trip', history, {
        onActivity: (activity) => activities.push(activity),
        onDelta: (text, kind) => {
          if (kind === 'content') deltas.push(text)
        }
      })

      expect(r.answer).toBe('Added a day trip to Sintra.')
      expect(deltas.join('')).toBe('Added a day trip to Sintra.') // the summary never streams
      expect(activities).toContainEqual({ kind: 'compacted', label: 'Compacted', summary })
      const summaryRequest = fake.requests[0] as {
        tools?: unknown[]
        messages: { role: string; content: string }[]
      }
      expect(summaryRequest.tools ?? []).toHaveLength(0)
      expect(summaryRequest.messages[0]!.content).toContain('## Facts and preferences')
      expect(summaryRequest.messages[1]!.content).toContain('User: Make it three days')
      const answerRequest = JSON.stringify(fake.requests[1])
      expect(answerRequest).toContain('Summary of the earlier conversation')
      expect(answerRequest).toContain('A three-day Lisbon trip in May for two.')
      expect(answerRequest).not.toContain('OLD-PLAN-END')
    } finally {
      service.ctxSize = previousContext
    }
  })

  it('accepts an English summary of CJK history with more characters but fewer tokens', async () => {
    const history = [{ role: 'user', content: '请安排旅行并保留所有偏好。'.repeat(230) }]
    const summary =
      `## Goal\nPlan the trip.\n## Facts and preferences\n${'Visit museums and allow time for rest. '.repeat(98)}`.trim()
    const previousSettings = llm.getSettings()
    await llm.setSettings({ ctxSize: 2_048 })
    try {
      fake.enqueue({ content: summary }, { content: 'The trip plan is ready.' })
      const activities: unknown[] = []
      const result = await toolChat('Continue the plan.', history, {
        onActivity: (activity) => activities.push(activity)
      })

      expect(result.answer).toBe('The trip plan is ready.')
      expect(activities).toContainEqual({ kind: 'compacted', label: 'Compacted', summary })
      expect(fake.requests).toHaveLength(2)
      const answer = fake.requests[1] as {
        messages: { role: string; content: string }[]
        tools?: unknown[]
      }
      const original = [answer.messages[0], ...history, answer.messages.at(-1)]
      expect(toolPromptChars(answer.messages, answer.tools)).toBeGreaterThan(
        toolPromptChars(original, answer.tools)
      )
      expect(toolPromptTokens(answer.messages, answer.tools)).toBeLessThan(
        toolPromptTokens(original, answer.tools)
      )
      expect(toolPromptTokens(original, answer.tools)).toBeGreaterThanOrEqual(2_048 * 0.8)
      expect(toolPromptTokens(answer.messages, answer.tools)).toBeLessThan(2_048 * 0.8)
      expect(answer.messages[1]!.content).toContain(summary)
      expect(answer.messages[1]!.content).not.toContain(history[0]!.content)
    } finally {
      await llm.setSettings(previousSettings)
    }
  })

  it('falls back to short excerpts when the summary call returns nothing usable', async () => {
    const history = [
      { role: 'user', content: 'Plan a trip to Lisbon' },
      { role: 'assistant', content: `Plan ${'museum detail '.repeat(1_500)}OLD-PLAN-END` }
    ]
    const service = llm as unknown as { ctxSize: number }
    const previousContext = service.ctxSize
    service.ctxSize = 4_096
    try {
      enqueueReactiveAfterEmptyPlan({ content: '' }, { content: 'Added a day trip.' })
      const activities: unknown[] = []
      const r = await toolChat('Add a day trip', history, {
        onActivity: (activity) => activities.push(activity)
      })

      expect(r.answer).toBe('Added a day trip.')
      expect(activities).toContainEqual({ kind: 'compacted', label: 'Compacted' })
      const answerRequest = JSON.stringify(fake.requests[1])
      expect(answerRequest).toContain('Earlier chat excerpts')
      expect(answerRequest).not.toContain('OLD-PLAN-END')
    } finally {
      service.ctxSize = previousContext
    }
  })
})
