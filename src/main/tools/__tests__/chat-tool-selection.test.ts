/**
 * A chat turn must not stall on the embedding model. A fresh install downloads MiniLM before
 * its first use, and offline it may never arrive, so tool routing waits a bounded time and then
 * routes by words. The embedding model is the only boundary faked here; selection, lexical
 * ranking and budgeting are production code.
 */
import { describe, expect, it } from 'vitest'
import { selectChatToolSchemas } from '../chat-tool-selection'

const tool = (name: string, description: string): unknown => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties: {} } }
})

const WEATHER = tool('weather_lookup', 'Look up the weather forecast for a city')
const CALENDAR = tool('calendar_events', 'Availability, events and scheduling on your calendar')
const names = (tools: unknown[]): string[] =>
  tools.map((t) => (t as { function: { name: string } }).function.name)

describe('chat tool selection while the embedding model is unavailable', () => {
  it('offers the tools a request needs once the wait elapses instead of waiting for the download', async () => {
    const neverLoads = (): Promise<number[]> => new Promise(() => {})
    const started = Date.now()

    const result = await selectChatToolSchemas(
      'what is the weather in Pune?',
      [WEATHER, CALENDAR],
      [],
      {
        contextSize: 16_384,
        conversationId: 'chat-tool-selection-wait',
        embed: neverLoads,
        semanticWaitMs: 50
      }
    )

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(names(result.tools)).toContain('weather_lookup')
  })

  it('does not hide a needed tool whose name the request never says while MiniLM loads', async () => {
    const neverLoads = (): Promise<number[]> => new Promise(() => {})
    const reminders = tool('reminders_create', 'Create a reminder in the Reminders app')

    const result = await selectChatToolSchemas(
      'nudge me to send the deck at 6pm today',
      [WEATHER, reminders],
      [],
      {
        contextSize: 16_384,
        conversationId: 'chat-tool-selection-loading',
        embed: neverLoads,
        semanticWaitMs: 50
      }
    )

    expect(names(result.tools)).toContain('reminders_create')
  })

  it('still ranks by meaning when the embedding model answers in time', async () => {
    // Scheduling words share a dimension; nothing else does.
    const embed = async (text: string): Promise<number[]> =>
      /meeting|calendar|event|schedul/i.test(text) ? [1, 0] : [0, 1]

    const result = await selectChatToolSchemas(
      'am I free for a meeting at 3?',
      [WEATHER, CALENDAR],
      [],
      {
        contextSize: 16_384,
        conversationId: 'chat-tool-selection-semantic',
        embed,
        semanticWaitMs: 1_000
      }
    )

    expect(names(result.tools)).toContain('calendar_events')
  })
})
