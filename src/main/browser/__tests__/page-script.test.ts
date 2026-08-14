// @vitest-environment jsdom
/**
 * The browser rail's eyes, against a real DOM. The collector here IS the code
 * injected into pages over CDP (pageScriptSource serializes this exact
 * function graph), so these tests pin what the agent can and cannot see:
 * interactive elements indexed for reference, invisible controls dropped, and
 * identity fields flagged with their values never read.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  collectInteractiveElements,
  formatSnapshotForModel,
  pageScriptSource
} from '../page-script'

// jsdom has no layout engine - every rect is 0x0, which would hide everything
// from the collector. Geometry is pinned by the e2e against a real renderer;
// here the rects are stubbed so the CLASSIFICATION rules (tags, roles, style,
// identity) are what these tests measure.
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 120,
      height: 24,
      top: 10,
      left: 10,
      right: 130,
      bottom: 34,
      x: 10,
      y: 10
    } as DOMRect
  }
})

const page = (html: string): Document => {
  document.body.innerHTML = html
  return document
}

describe('collectInteractiveElements', () => {
  it('indexes interactive elements 1..n and skips static content', () => {
    const snapshot = collectInteractiveElements(
      page(`
        <h1>Flight check-in</h1>
        <p>Enter your booking reference.</p>
        <input aria-label="Booking reference" value="KX93F" />
        <button>Continue</button>
        <a href="/help">Help</a>
      `)
    )
    expect(snapshot.elements.map((el) => el.index)).toEqual([1, 2, 3])
    expect(snapshot.elements.map((el) => el.tag)).toEqual(['input', 'button', 'a'])
    expect(snapshot.text).toContain('Enter your booking reference.')
  })

  it('names elements by aria-label, text, then placeholder', () => {
    const snapshot = collectInteractiveElements(
      page(`
        <button aria-label="Close dialog">x</button>
        <button>Save changes</button>
        <input placeholder="Search flights" />
      `)
    )
    expect(snapshot.elements.map((el) => el.name)).toEqual([
      'Close dialog',
      'Save changes',
      'Search flights'
    ])
  })

  it('includes role-interactive elements and onclick handlers', () => {
    const snapshot = collectInteractiveElements(
      page(`
        <div role="button">Accept cookies</div>
        <span onclick="go()">Next</span>
        <div>plain text</div>
      `)
    )
    expect(snapshot.elements.map((el) => el.name)).toEqual(['Accept cookies', 'Next'])
    expect(snapshot.elements[0]?.role).toBe('button')
  })

  it('drops hidden inputs and display:none controls', () => {
    const snapshot = collectInteractiveElements(
      page(`
        <input type="hidden" value="csrf" />
        <button style="display:none">Ghost</button>
        <button>Real</button>
      `)
    )
    expect(snapshot.elements.map((el) => el.name)).toEqual(['Real'])
  })

  it('flags identity fields and never reads their values', () => {
    const snapshot = collectInteractiveElements(
      page(`
        <input type="email" value="ali@x.test" aria-label="Email" />
        <input type="password" value="hunter2" aria-label="Password" />
        <input autocomplete="one-time-code" value="123456" aria-label="Code" />
      `)
    )
    const [email, password, otp] = snapshot.elements
    expect(email?.identity).toBe(false)
    expect(email?.value).toBe('ali@x.test')
    expect(password?.identity).toBe(true)
    expect(otp?.identity).toBe(true)
    // The whole point of the boundary: the agent's snapshot must not carry
    // credentials even when the page has them filled in.
    expect(JSON.stringify(snapshot)).not.toContain('hunter2')
    expect(JSON.stringify(snapshot)).not.toContain('123456')
  })
})

describe('pageScriptSource', () => {
  it('the serialized graph is self-contained and returns the same snapshot as the direct call', () => {
    const doc = page('<button>Continue</button><input type="password" aria-label="pw" />')
    const direct = collectInteractiveElements(doc)
    // Run the serialized source exactly as CDP would (indirect eval, page scope).
    const injected = JSON.parse((0, eval)(pageScriptSource()) as string)
    expect(injected.elements).toEqual(JSON.parse(JSON.stringify(direct.elements)))
  })
})

describe('formatSnapshotForModel', () => {
  it('renders numbered elements with the identity marker and caps the list', () => {
    const doc = page(
      `${'<button>B</button>'.repeat(3)}<input type="password" aria-label="Password" />`
    )
    const rendered = formatSnapshotForModel(collectInteractiveElements(doc), 2)
    expect(rendered).toContain('[1] button "B"')
    expect(rendered).toContain('(2 more elements omitted)')
    expect(rendered).not.toContain('[3]')
  })
})
