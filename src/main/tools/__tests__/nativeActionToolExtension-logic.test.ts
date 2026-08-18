import { describe, expect, it } from 'vitest'
import {
  NATIVE_TOOL_SPECS,
  findNativeToolSpec,
  buildNativeToolSchemas
} from '../nativeActionToolExtension-logic'
import { shouldGate } from '../../actions/approval'

describe('native tool specs', () => {
  it('routes watch/open intents to open_url (real browser) and operate intents to web_task (in-app)', () => {
    // The hybrid taxonomy: "open/play/watch X" ends up in the user's OWN
    // browser via open_url (deep-linked to a search URL for a site search);
    // web_task is only for OPERATING a page (log in / fill / order) in the
    // controlled in-app browser. open_url must own play/watch and show the
    // deep-link; web_task must disclaim simple open/watch and point back.
    const openUrl = findNativeToolSpec('open_url')?.description ?? ''
    const webTask = findNativeToolSpec('web_task')?.description ?? ''
    expect(openUrl).toMatch(/own browser/i)
    expect(openUrl).toMatch(/play|watch/i)
    expect(openUrl).toMatch(/results\?search_query/)
    expect(webTask).toMatch(/operate/i)
    expect(webTask).toMatch(/open or watch/i)
    expect(webTask).toMatch(/open_url/)
  })

  it('exposes calendar and reminder tools with matching helper commands', () => {
    expect(NATIVE_TOOL_SPECS.map((s) => s.name)).toEqual([
      'calendar_create_event',
      'calendar_list_events',
      'reminders_create',
      'reminders_list',
      'contacts_search',
      'messages_send',
      'mail_send',
      'open_url',
      'web_task',
      'computer_task'
    ])
    expect(findNativeToolSpec('calendar_create_event')?.command).toBe('calendar.createEvent')
    expect(findNativeToolSpec('calendar_list_events')?.command).toBe('calendar.listEvents')
    expect(findNativeToolSpec('reminders_create')?.command).toBe('reminders.create')
    expect(findNativeToolSpec('reminders_list')?.command).toBe('reminders.list')
    expect(findNativeToolSpec('contacts_search')?.command).toBe('contacts.search')
    expect(findNativeToolSpec('messages_send')?.command).toBe('messages.send')
    expect(findNativeToolSpec('mail_send')?.command).toBe('mail.send')
    expect(findNativeToolSpec('open_url')?.command).toBe('system.openURL')
  })

  it('gates the send actions and runs the read lookups without approval', () => {
    for (const name of ['messages_send', 'mail_send']) {
      expect(shouldGate(findNativeToolSpec(name)!.risk)).toBe(true)
    }
    expect(shouldGate(findNativeToolSpec('contacts_search')!.risk)).toBe(false)
  })

  it('treats open_url as a navigate that runs without approval', () => {
    expect(findNativeToolSpec('open_url')!.risk).toBe('navigate')
    expect(shouldGate(findNativeToolSpec('open_url')!.risk)).toBe(false)
  })

  it('confirms a sent message and email without echoing arguments', () => {
    expect(findNativeToolSpec('messages_send')!.formatResult({ sent: true })).toBe(
      'Sent the message.'
    )
    expect(findNativeToolSpec('mail_send')!.formatResult({ sent: true })).toBe('Sent the email.')
  })

  it('classifies every create tool as a gating mutate and every list tool as a read', () => {
    for (const name of ['calendar_create_event', 'reminders_create']) {
      expect(shouldGate(findNativeToolSpec(name)!.risk)).toBe(true)
    }
    for (const name of ['calendar_list_events', 'reminders_list']) {
      expect(shouldGate(findNativeToolSpec(name)!.risk)).toBe(false)
    }
  })

  it('formats a created reminder with the shared confirmation shape', () => {
    expect(findNativeToolSpec('reminders_create')!.formatResult({ id: 'R1' })).toBe(
      'Created the reminder (id R1).'
    )
  })

  it('returns undefined for an unknown tool name', () => {
    expect(findNativeToolSpec('calendar_delete_everything')).toBeUndefined()
  })

  it('gates the mutating create tool and runs the read-only list tool freely', () => {
    expect(shouldGate(findNativeToolSpec('calendar_create_event')!.risk)).toBe(true)
    expect(shouldGate(findNativeToolSpec('calendar_list_events')!.risk)).toBe(false)
  })

  it('builds an approval title from the event title', () => {
    expect(findNativeToolSpec('calendar_create_event')!.title({ title: 'Sync with Ali' })).toBe(
      'Create the calendar event "Sync with Ali"'
    )
  })

  it('formats a create result into a confirmation, with and without an id', () => {
    const spec = findNativeToolSpec('calendar_create_event')!
    expect(spec.formatResult({ id: 'E1' })).toBe('Created the calendar event (id E1).')
    expect(spec.formatResult({})).toBe('Created the calendar event.')
  })

  it('builds OpenAI function schemas for every spec', () => {
    const schemas = buildNativeToolSchemas()
    expect(schemas).toHaveLength(NATIVE_TOOL_SPECS.length)
    expect(schemas[0]).toMatchObject({
      type: 'function',
      function: { name: 'calendar_create_event', parameters: { required: ['title', 'start'] } }
    })
  })
})
