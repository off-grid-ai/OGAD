/**
 * Semantic tool routing. rankConnectorToolsSemantic ranks connector tools by
 * embedding similarity to the message, so a tool matches on MEANING, not shared
 * words. The decisive test: a "meetings" query (no lexical overlap with a
 * "calendar events" tool) ranks the calendar tool first — where the lexical
 * scorer gives it 0. A fake embed stands in for the model at the one boundary
 * (embeddings backend); the ranking, cache, and cosine math are production code.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  contextualToolRoutingText,
  rankConnectorToolsSemantic,
  selectRelevantToolsSemantic,
  _clearToolVecCache
} from '../tool-embedding-ranking'
import { scoreTool, terms } from '../tool-ranking'

const tool = (name: string, description: string): unknown => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties: {} } }
})

const CALENDAR = tool('calendar_events', 'Meetings, availability and scheduling on your calendar')
const SLACK = tool('slack_send', 'Post a message to a Slack channel or direct message')
const GITHUB = tool('github_issue', 'Open an issue on a code repository')
const BUILTIN = tool('web_search', 'Search the web')

// A concept-space fake embedding: each keyword maps to a dimension, a text embeds
// to the (normalized) sum of its concept dimensions. So texts that share MEANING
// share dimensions even with no shared surface words — exactly what a real model
// gives us, deterministically.
const CONCEPTS: Record<string, number> = {
  // scheduling concept
  meeting: 0,
  meetings: 0,
  calendar: 0,
  event: 0,
  events: 0,
  schedule: 0,
  scheduling: 0,
  availability: 0,
  // messaging concept
  message: 1,
  slack: 1,
  channel: 1,
  post: 1,
  // code concept
  code: 2,
  issue: 2,
  repository: 2,
  github: 2,
  research: 3,
  internet: 3,
  web: 3,
  search: 3
}

const fakeEmbed = async (text: string): Promise<number[]> => {
  const v = [0, 0, 0, 0]
  for (const w of terms(text)) {
    const dim = CONCEPTS[w]
    if (dim !== undefined) {
      v[dim]! += 1
    }
  }
  const mag = Math.hypot(...v) || 1
  return v.map((x) => x / mag) // normalized, like the real backend
}

describe('rankConnectorToolsSemantic', () => {
  beforeEach(() => _clearToolVecCache())

  it('ranks by meaning: a "meeting" query surfaces the calendar tool despite zero shared words', async () => {
    // Singular "meeting" appears NOWHERE in the calendar tool's text (which says
    // "Meetings"/"calendar"/"scheduling") — and the lexical scorer doesn't stem,
    // so it rates the calendar tool 0. Only meaning connects them.
    const query = 'do I have a meeting later'
    expect(scoreTool(terms(query), CALENDAR)).toBe(0)

    const ranked = await rankConnectorToolsSemantic(query, [BUILTIN, SLACK, GITHUB, CALENDAR], 1, {
      embed: fakeEmbed
    })
    // Built-in stays first; calendar leads the connectors on semantic similarity.
    expect((ranked[0] as { function: { name: string } }).function.name).toBe('web_search')
    expect((ranked[1] as { function: { name: string } }).function.name).toBe('calendar_events')
  })

  it('routes a messaging query to the Slack tool', async () => {
    const ranked = await rankConnectorToolsSemantic(
      'send a note to the team channel',
      [BUILTIN, CALENDAR, GITHUB, SLACK],
      1,
      { embed: fakeEmbed }
    )
    expect((ranked[1] as { function: { name: string } }).function.name).toBe('slack_send')
  })

  it('caches tool embeddings by content (embeds each tool once across turns)', async () => {
    const calls: string[] = []
    const counting = async (t: string): Promise<number[]> => {
      calls.push(t)
      return fakeEmbed(t)
    }
    const tools = [BUILTIN, SLACK, CALENDAR]
    await rankConnectorToolsSemantic('meetings', tools, 1, { embed: counting })
    const afterFirst = calls.length
    await rankConnectorToolsSemantic('messages', tools, 1, { embed: counting })
    // Second turn only embeds the new QUERY, not the (cached) tools.
    expect(calls.length).toBe(afterFirst + 1)
  })

  it('leaves order unchanged for ≤1 connector or an empty query', async () => {
    const tools = [BUILTIN, SLACK]
    expect(await rankConnectorToolsSemantic('meetings', tools, 1, { embed: fakeEmbed })).toEqual(
      tools
    )
    const three = [BUILTIN, SLACK, CALENDAR]
    expect(await rankConnectorToolsSemantic('', three, 1, { embed: fakeEmbed })).toEqual(three)
  })

  it('a tool that fails to embed is ranked last, not fatal to the turn', async () => {
    const flaky = async (t: string): Promise<number[]> => {
      if (t.includes('github')) {
        throw new Error('embed failed')
      }
      return fakeEmbed(t)
    }
    const ranked = await rankConnectorToolsSemantic(
      'do I have meetings',
      [BUILTIN, GITHUB, CALENDAR],
      1,
      { embed: flaky }
    )
    const names = ranked.map((t) => (t as { function: { name: string } }).function.name)
    expect(names[0]).toBe('web_search')
    expect(names[names.length - 1]).toBe('github_issue') // failed embed sinks to last
  })
})

describe('contextual semantic tool selection', () => {
  beforeEach(() => _clearToolVecCache())

  it('carries a recent user goal into a referential follow-up without intent keywords', async () => {
    const routingText = contextualToolRoutingText('please continue with more depth', [
      {
        role: 'user',
        content: 'Research recent Off Grid AI activity on the internet.'
      },
      {
        role: 'assistant',
        content: 'I can search the web if you want me to.'
      }
    ])

    expect(routingText).toContain('Research recent Off Grid AI activity on the internet.')
    expect(routingText).not.toContain('I can search the web')
    const selected = await selectRelevantToolsSemantic(routingText, [CALENDAR, BUILTIN], {
      embed: fakeEmbed
    })

    expect(selected).toEqual([BUILTIN])
  })

  it('keeps the current request first and bounds old user context', () => {
    const routingText = contextualToolRoutingText('continue', [
      { role: 'user', content: 'oldest goal' },
      { role: 'user', content: 'newer goal' },
      { role: 'user', content: 'newest goal' }
    ])

    expect(routingText.startsWith('Current user request: continue')).toBe(true)
    expect(routingText).not.toContain('oldest goal')
    expect(routingText.indexOf('newest goal')).toBeLessThan(routingText.indexOf('newer goal'))
  })
})
