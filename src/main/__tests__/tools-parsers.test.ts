import { describe, it, expect } from 'vitest'
import { htmlToText, stripTags, decodeEntities, decodeDdgHref } from '../tools-parsers'

describe('decodeEntities', () => {
  it('decodes named entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &nbsp;e')).toBe('a & b <c> "d"  e')
  })

  it('decodes both apostrophe forms', () => {
    expect(decodeEntities('it&#39;s and it&apos;s')).toBe("it's and it's")
  })

  it('decodes numeric decimal entities', () => {
    // &#65; = A, &#8364; would be euro; use A and space
    expect(decodeEntities('&#72;&#105;')).toBe('Hi')
  })
})

describe('stripTags', () => {
  it('removes tags, decodes entities, and collapses whitespace', () => {
    expect(stripTags('<b>Hello</b>   &amp;  <i>world</i>')).toBe('Hello & world')
  })

  it('trims surrounding whitespace', () => {
    expect(stripTags('  <span> hi </span>  ')).toBe('hi')
  })
})

describe('htmlToText', () => {
  it('drops <script> and <style> contents entirely', () => {
    const html = '<p>keep</p><script>var x = 1;</script><style>.a{color:red}</style><p>me</p>'
    const out = htmlToText(html)
    expect(out).not.toContain('var x')
    expect(out).not.toContain('color:red')
    expect(out).toContain('keep')
    expect(out).toContain('me')
  })

  it('turns block-close tags into newlines (open tags collapse to a space)', () => {
    // </p> → newline; the second <p> open tag → ' '; [ \t]+ collapse keeps the space
    const out = htmlToText('<p>one</p><p>two</p>')
    expect(out).toBe('one\n two')
  })

  it('collapses 3+ blank lines down to a double newline', () => {
    // many block closes in a row produce many newlines → collapsed to \n\n
    const out = htmlToText('<div>a</div><br></br><br></br><br></br><div>b</div>')
    expect(out).not.toMatch(/\n{3,}/)
    expect(out).toContain('a')
    expect(out).toContain('b')
  })

  it('decodes entities in the extracted text', () => {
    expect(htmlToText('<p>Tom &amp; Jerry</p>')).toBe('Tom & Jerry')
  })
})

describe('decodeDdgHref', () => {
  it('unwraps a DuckDuckGo uddg redirect to the real URL', () => {
    const real = 'https://example.com/page?x=1'
    const href = '//duckduckgo.com/l/?uddg=' + encodeURIComponent(real)
    expect(decodeDdgHref(href)).toBe(real)
  })

  it('makes a protocol-relative non-redirect href https', () => {
    expect(decodeDdgHref('//example.com/foo')).toBe('https://example.com/foo')
  })

  it('passes an absolute non-redirect href through unchanged', () => {
    expect(decodeDdgHref('https://example.com/foo')).toBe('https://example.com/foo')
  })
})

describe('page text never carries markup it did not show', () => {
  it('decodes an escaped entity once, as the text the page shows', () => {
    expect(decodeEntities('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;')
  })

  it('drops a script whose closing tag has a space', () => {
    expect(htmlToText('<p>Kept</p><script>steal()</script >')).toBe('Kept')
  })
})
