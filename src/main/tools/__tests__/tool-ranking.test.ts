/**
 * Smart tool routing. rankConnectorTools reorders connector tools by relevance to
 * the user's message so the context budgeter (which drops from the end) keeps the
 * relevant ones. The decisive test runs the REAL budgetTools after ranking and
 * asserts the on-topic tool survives a budget that only fits one connector, while
 * the off-topic one is dropped — the actual behavior the user gets.
 */
import { describe, it, expect } from 'vitest'
import { terms, scoreTool, rankConnectorTools, selectRelevantTools } from '../tool-ranking'
import { budgetTools, MAX_TOOL_TOKENS } from '../tool-budget'

const tool = (name: string, description: string): unknown => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties: {} } }
})

const CALENDAR = tool(
  'calendar_list_events',
  'List events on your Google Calendar and availability'
)
const SLACK = tool('slack_send_message', 'Send a message to a Slack channel or DM')
const GITHUB = tool('github_create_issue', 'Open a new issue on a GitHub repository')
const BUILTIN = tool('web_search', 'Search the web and return results')

describe('browser-sized tool catalogs', () => {
  it('keeps a relevant tool within the shared budget for a 149-tool catalog', () => {
    const calendar = {
      type: 'function',
      function: {
        name: 'calendar_list_events',
        description: 'List calendar meetings',
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 10 }, (_, index) => [
              `field${index}`,
              {
                type: 'string',
                description: 'Calendar field guidance. '.repeat(120)
              }
            ])
          )
        }
      }
    }
    const catalog = [
      calendar,
      ...Array.from({ length: 148 }, (_, index) =>
        tool(`inventory_${index}`, 'Inventory warehouse stock. '.repeat(100))
      )
    ]
    expect(JSON.stringify(catalog).length).toBeGreaterThan(223_000)
    const result = budgetTools(
      selectRelevantTools('List calendar meetings', catalog),
      MAX_TOOL_TOKENS,
      0
    )
    expect(result.estTokens).toBeLessThanOrEqual(MAX_TOOL_TOKENS)
    expect(result.tools.map((entry) => (entry as typeof calendar).function.name)).toEqual([
      'calendar_list_events'
    ])
  })
})

describe('terms', () => {
  it('drops stop words + 1-char noise, lowercases', () => {
    expect(terms("What's on my Calendar today")).toEqual(['calendar', 'today'])
  })
})

describe('scoreTool', () => {
  it('weighs a name match above a description-only match, 0 for no overlap', () => {
    const qt = terms('calendar events')
    expect(scoreTool(qt, CALENDAR)).toBeGreaterThan(scoreTool(qt, SLACK))
    expect(scoreTool(terms('deploy the kubernetes cluster'), CALENDAR)).toBe(0)
  })
})

describe('rankConnectorTools', () => {
  it('keeps built-ins first and orders connectors by relevance to the query', () => {
    const ranked = rankConnectorTools(
      'add an event to my calendar tomorrow',
      [BUILTIN, SLACK, GITHUB, CALENDAR],
      1
    )
    // built-in unmoved
    expect((ranked[0] as { function: { name: string } }).function.name).toBe('web_search')
    // calendar (relevant) now leads the connector tools
    expect((ranked[1] as { function: { name: string } }).function.name).toBe('calendar_list_events')
  })

  it('leaves order unchanged when nothing matches, the query is empty, or ≤1 connector', () => {
    const tools = [BUILTIN, SLACK, GITHUB]
    expect(rankConnectorTools('deploy kubernetes', tools, 1)).toEqual(tools) // no match
    expect(rankConnectorTools('', tools, 1)).toEqual(tools) // no query signal
    expect(rankConnectorTools('slack', [BUILTIN, SLACK], 1)).toEqual([BUILTIN, SLACK]) // 1 connector
  })

  it('ranking makes the RELEVANT tool survive a tight budget (real budgetTools)', () => {
    const all = [BUILTIN, SLACK, GITHUB, CALENDAR]
    // A budget that fits the built-in + exactly one connector tool.
    const budget = 120
    const keepFirst = 1

    // Without ranking: the budgeter drops from the end → calendar (last) is dropped.
    const unranked = budgetTools(all, budget, keepFirst)
    const unrankedNames = unranked.tools.map(
      (t) => (t as { function: { name: string } }).function.name
    )
    expect(unranked.droppedCount).toBeGreaterThan(0)
    expect(unrankedNames).not.toContain('calendar_list_events')

    // With ranking for a calendar query: calendar moves up front and SURVIVES.
    const ranked = rankConnectorTools('what meetings are on my calendar', all, keepFirst)
    const budgeted = budgetTools(ranked, budget, keepFirst)
    const keptNames = budgeted.tools.map((t) => (t as { function: { name: string } }).function.name)
    expect(keptNames).toContain('web_search') // built-in never dropped
    expect(keptNames).toContain('calendar_list_events') // relevant tool kept
  })
})

describe('email across several accounts', () => {
  const tool = (name: string, description: string): unknown => ({
    type: 'function',
    function: { name, description }
  })
  // A catalog shaped like a real one: three Google accounts, one Microsoft account, and a
  // Notion connector whose user tools mention email addresses. All synthetic.
  const catalog = [
    tool(
      'mcp__4__notion-get-users',
      '[Notion] List all users in the workspace, with their names and email addresses.'
    ),
    tool('mcp__4__notion-create-comment', '[Notion] Add a comment to a page or discussion.'),
    ...[7, 8, 9].map((id) =>
      tool(
        `mcp__${id}__search_messages`,
        `[Google (person${id}@example.test)] Search this account's email in Gmail (inbox and other mail) and return message subjects, senders, recipients, dates, snippets, and links.`
      )
    ),
    tool(
      'mcp__10__search_messages',
      "[Microsoft (person@example.test)] Read or search this account's email in Outlook (inbox and other mail). Returns message previews and pagination."
    )
  ]
  const names = (tools: unknown[]): string[] =>
    tools.map((t) => (t as { function: { name: string } }).function.name)

  it('offers every account mailbox for "top emails across my email accounts"', () => {
    const picked = names(
      selectRelevantTools(
        'Tell me the top 10 emails today across all of my email accounts',
        catalog
      )
    )
    expect(picked).toEqual(
      expect.arrayContaining([
        'mcp__7__search_messages',
        'mcp__8__search_messages',
        'mcp__9__search_messages',
        'mcp__10__search_messages'
      ])
    )
    expect(picked.indexOf('mcp__7__search_messages')).toBeLessThan(
      picked.indexOf('mcp__4__notion-get-users') === -1
        ? Infinity
        : picked.indexOf('mcp__4__notion-get-users')
    )
  })

  it('folds plurals both ways', () => {
    expect(terms('emails calendars inboxes class')).toEqual([
      'email',
      'calendar',
      'inboxe',
      'class'
    ])
  })
})
