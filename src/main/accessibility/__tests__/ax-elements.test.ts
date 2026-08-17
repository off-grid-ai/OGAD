/**
 * The AX element contract: the helper's structured output parses into a
 * numbered, actionable list, and the model-facing format matches the browser
 * collector's. These tests ARE the contract the Swift helper must honour.
 */
import { describe, expect, it } from 'vitest'
import { formatAxElementsForModel, parseAxElements } from '../ax-elements'

const sample = [
  '[WINDOW_TITLE] Slack - direct messages',
  '{"role":"AXButton","label":"Send","x":1200,"y":790,"w":60,"h":30,"press":true,"enabled":true}',
  '{"role":"AXTextField","label":"Message sidd","x":400,"y":780,"w":700,"h":40,"press":false,"enabled":true,"value":"hi"}',
  '{"role":"AXButton","label":"Attach","x":360,"y":790,"w":24,"h":24,"press":true,"enabled":true}'
].join('\n')

describe('parseAxElements', () => {
  it('parses the window title and numbers the elements 1..n', () => {
    const snap = parseAxElements(sample)
    expect(snap.windowTitle).toBe('Slack - direct messages')
    expect(snap.elements.map((e) => e.index)).toEqual([1, 2, 3])
    expect(snap.elements.map((e) => e.role)).toEqual(['AXButton', 'AXTextField', 'AXButton'])
  })

  it('computes the element center from the frame for clicking', () => {
    const [send] = parseAxElements(sample).elements
    // 1200 + 60/2 = 1230 ; 790 + 30/2 = 805
    expect(send).toMatchObject({ name: 'Send', cx: 1230, cy: 805, actionable: true })
  })

  it('carries value and actionability, and defaults enabled to true', () => {
    const field = parseAxElements(sample).elements[1]
    expect(field).toMatchObject({ role: 'AXTextField', value: 'hi', actionable: false })
    // enabled omitted on a line -> true (only an explicit false disables)
    expect(field?.enabled).toBe(true)
  })

  it('marks a disabled element and a non-pressable one', () => {
    const snap = parseAxElements(
      '{"role":"AXButton","label":"Send","x":0,"y":0,"w":10,"h":10,"press":true,"enabled":false}'
    )
    expect(snap.elements[0]).toMatchObject({ enabled: false, actionable: true })
  })

  it('fails closed: skips malformed lines, blank lines, and text-mode markers', () => {
    const snap = parseAxElements(
      [
        '[WINDOW_TITLE] App',
        '[BROWSER_URL] https://x.test', // a text-mode marker - ignored
        'some plain text line', // text-mode content - ignored
        '{not json', // malformed - skipped
        '{"label":"no role","x":1,"y":1,"w":1,"h":1}', // no role - skipped
        '{"role":"AXButton","label":"Ok","x":10,"y":10,"w":20,"h":20,"press":true}'
      ].join('\n')
    )
    expect(snap.elements.map((e) => e.name)).toEqual(['Ok'])
  })
})

describe('formatAxElementsForModel', () => {
  it('renders a numbered list with names, values, and the disabled marker', () => {
    const rendered = formatAxElementsForModel(parseAxElements(sample))
    expect(rendered).toContain('Window: Slack - direct messages')
    expect(rendered).toContain('[1] AXButton "Send"')
    expect(rendered).toContain('[2] AXTextField "Message sidd" value="hi"')
  })

  it('caps the list and says how many were omitted', () => {
    const many = ['[WINDOW_TITLE] Big']
    for (let i = 0; i < 5; i += 1) {
      many.push(`{"role":"AXButton","label":"b${i}","x":0,"y":0,"w":2,"h":2,"press":true}`)
    }
    const rendered = formatAxElementsForModel(parseAxElements(many.join('\n')), 2)
    expect(rendered).toContain('(3 more elements omitted)')
    expect(rendered).not.toContain('[3]')
  })
})
