import { describe, expect, it } from 'vitest'
import { taskDisplayTitle, taskRequestText } from '../task-display-title'

describe('task display title', () => {
  it('names a Chat task by the user request, without the model-facing label or the long link', () => {
    const goal = [
      'Current user request (authoritative):',
      'Use Web Use to open https://getoffgridai.co/pricing and calculate Team pricing for 40 people. Then tell me the monthly total.',
      '',
      'Completed prerequisites (already done; continue from this state):',
      "- open_url opened https://getoffgridai.co/pricing in the user's default browser",
      '',
      'Structured task summary:',
      'Navigate to the pricing page, select Team, enter 40 seats, read the total.'
    ].join('\n')

    expect(taskDisplayTitle(goal)).toBe(
      'Open getoffgridai.co/pricing and calculate Team pricing for 40 people'
    )
  })

  it('names an MCP task by its summary when no user request travels with it', () => {
    expect(
      taskDisplayTitle(
        'Structured task summary:\nBook the 9:40 train to Pune on https://www.irctc.co.in/nget/train-search?from=CSMT'
      )
    ).toBe('Book the 9:40 train to Pune on irctc.co.in')
  })

  it('keeps a plain title unchanged, so it can be applied more than once', () => {
    const title = 'Calculate Team pricing for 40 people'
    expect(taskDisplayTitle(title)).toBe(title)
    expect(taskDisplayTitle(taskDisplayTitle(title))).toBe(title)
  })

  it('shortens a long request to a readable name at a word boundary', () => {
    const title = taskDisplayTitle(
      'Current user request (authoritative):\nfind three flights from Mumbai to Bengaluru next Friday morning under twelve thousand rupees with a window seat and free cancellation'
    )
    expect(title.length).toBeLessThanOrEqual(80)
    expect(title.endsWith('…')).toBe(true)
    expect(title.startsWith('Find three flights from Mumbai to Bengaluru')).toBe(true)
    expect(title).not.toMatch(/\s…$/)
  })

  it('returns nothing for an empty goal so the caller can fall back', () => {
    expect(taskDisplayTitle('')).toBe('')
    expect(taskDisplayTitle(undefined)).toBe('')
  })
})

describe('task request text', () => {
  it('keeps the whole request for a See more view, without the model labels', () => {
    const goal =
      'Current user request (authoritative):\nOpen Slack and send the full release report.\nKeep every detail.\n\nStructured task summary:\nSend report.'
    expect(taskRequestText(goal)).toBe(
      'Open Slack and send the full release report.\nKeep every detail.'
    )
    expect(taskRequestText('play Drake on Spotify')).toBe('play Drake on Spotify')
  })
})
