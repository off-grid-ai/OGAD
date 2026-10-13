import { describe, expect, it } from 'vitest'
import { isToolAllowedForOrigin, toolOriginOf, type ToolOrigin } from '../tool-origin'

const startTab = { browserId: 'chrome-1', tabId: 42 }

describe('tool context origin', () => {
  it.each<{
    label: string
    context?: { origin?: ToolOrigin; acting?: boolean; startTab?: unknown }
    origin?: ToolOrigin
    acting?: boolean
    webAllowed: boolean
    computerAllowed: boolean
  }>([
    { label: 'no context', webAllowed: true, computerAllowed: true },
    {
      label: 'desktop',
      context: { origin: 'desktop' },
      origin: 'desktop',
      webAllowed: true,
      computerAllowed: true
    },
    {
      label: 'bridge with acting false',
      context: { origin: 'bridge', acting: false },
      origin: 'bridge',
      acting: false,
      webAllowed: false,
      computerAllowed: false
    },
    {
      label: 'bridge with acting true',
      context: { origin: 'bridge', acting: true },
      origin: 'bridge',
      acting: true,
      webAllowed: true,
      computerAllowed: false
    },
    {
      label: 'startTab only',
      context: { startTab },
      origin: 'bridge',
      acting: true,
      webAllowed: true,
      computerAllowed: false
    },
    {
      label: 'startTab with acting false',
      context: { startTab, acting: false },
      origin: 'bridge',
      acting: false,
      webAllowed: false,
      computerAllowed: false
    },
    {
      label: 'bridge with startTab and no acting mode',
      context: { origin: 'bridge', startTab },
      origin: 'bridge',
      webAllowed: false,
      computerAllowed: false
    },
    {
      label: 'desktop with startTab',
      context: { origin: 'desktop', startTab },
      origin: 'bridge',
      acting: true,
      webAllowed: true,
      computerAllowed: false
    }
  ])('$label', ({ context, origin, acting, webAllowed, computerAllowed }) => {
    const resolved = toolOriginOf(context)
    expect(resolved).toEqual({ origin, acting })
    expect(isToolAllowedForOrigin('web_use', resolved.origin, resolved)).toBe(webAllowed)
    expect(isToolAllowedForOrigin('computer_use', resolved.origin, resolved)).toBe(computerAllowed)
  })
})

describe('extension origin rule', () => {
  it.each(['tool', 'connector', undefined] as const)(
    'requires a read declaration for category %s',
    (category) => {
      const extension = { category, isReadOnlyTool: (name: string) => name === 'read_connector' }
      expect(isToolAllowedForOrigin('read_connector', 'bridge', { extension })).toBe(true)
      expect(isToolAllowedForOrigin('write_connector', 'bridge', { extension })).toBe(false)
      expect(isToolAllowedForOrigin('write_connector', 'bridge', { extension, acting: true })).toBe(
        true
      )
      expect(isToolAllowedForOrigin('write_connector', 'desktop', { extension })).toBe(true)
      expect(isToolAllowedForOrigin('write_connector', undefined, { extension })).toBe(true)
    }
  )

  it('preserves native risk and computer restrictions even with a read declaration', () => {
    const extension = { isReadOnlyTool: () => true }
    expect(isToolAllowedForOrigin('web_use', 'bridge', { extension })).toBe(false)
    expect(isToolAllowedForOrigin('computer_use', 'bridge', { extension, acting: true })).toBe(
      false
    )
    expect(isToolAllowedForOrigin('calendar_list_events', 'bridge', { extension })).toBe(true)
  })

  it('refuses undeclared extensions and preserves core built-ins', () => {
    expect(
      isToolAllowedForOrigin('schedule_task', 'bridge', { extension: { category: 'tool' } })
    ).toBe(false)
    expect(isToolAllowedForOrigin('unknown_tool', 'bridge', { extension: {} })).toBe(false)
    expect(isToolAllowedForOrigin('calculator', 'bridge', { extension: {} })).toBe(true)
    expect(isToolAllowedForOrigin('calculator', 'bridge')).toBe(true)
  })
})

describe('unowned tool admission', () => {
  it.each(['web_search', 'brave_search', 'read_url'])(
    'refuses outbound fetch tool %s for every bridge mode',
    (name) => {
      for (const acting of [undefined, false, true]) {
        expect(isToolAllowedForOrigin(name, 'bridge', { acting })).toBe(false)
        expect(isToolAllowedForOrigin(name, 'desktop', { acting })).toBe(true)
      }
    }
  )

  it.each([
    ['offgrid_guide', true],
    ['calculator', true],
    ['read_screen', true],
    ['search_memory', true],
    ['search_knowledge_base', true],
    ['get_datetime', true],
    ['generate_image', false],
    ['memory_write', false],
    ['reminders_create', false],
    ['unknown_tool', false],
    [undefined, false]
  ])('classifies %s and preserves authorized origins', (name, readOnly) => {
    expect(isToolAllowedForOrigin(name, 'bridge')).toBe(readOnly)
    expect(isToolAllowedForOrigin(name, 'bridge', { acting: false })).toBe(readOnly)
    expect(isToolAllowedForOrigin(name, 'bridge', { acting: true })).toBe(true)
    expect(isToolAllowedForOrigin(name, 'desktop')).toBe(true)
    expect(isToolAllowedForOrigin(name)).toBe(true)
  })
})
