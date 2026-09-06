// Tests for parseArtifact (lib/artifact-parser.ts) - the PURE function that
// decides which renderable artifact (if any) a model response contains. It is the
// single source of truth for artifact detection, so each detection branch and the
// precedence between them is exercised here. One case per branch.
//
// parseArtifact is a pure string -> Artifact|null function, so it loads in the default
// (node) test environment without a window/document.
import { describe, it, expect } from 'vitest'
import { parseArtifact } from '../../lib/artifact-parser'

describe('parseArtifact - React blocks (highest precedence)', () => {
  it('detects a single jsx fence as a react artifact', () => {
    const a = parseArtifact('```jsx\nconst App = () => <div>hi</div>;\n```')
    expect(a).toEqual({ kind: 'react', code: 'const App = () => <div>hi</div>;' })
  })

  it('detects a tsx fence as react', () => {
    const a = parseArtifact('```tsx\nexport default function App(){ return <p/>; }\n```')
    expect(a?.kind).toBe('react')
  })

  it('detects a react fence as react', () => {
    const a = parseArtifact('```react\nfunction App(){ return null; }\n```')
    expect(a?.kind).toBe('react')
  })

  it('COMBINES multiple react blocks into one shared scope (multi-file responses)', () => {
    const content =
      '```jsx\nconst Child = () => <span/>;\n```\n\ntext\n\n```jsx\nconst App = () => <Child/>;\n```'
    const a = parseArtifact(content)
    expect(a?.kind).toBe('react')
    // both blocks joined with a blank line between
    expect(a?.code).toBe('const Child = () => <span/>;\n\nconst App = () => <Child/>;')
  })

  it('react fence wins even when an html fence is also present', () => {
    const content = '```html\n<h1>hi</h1>\n```\n```jsx\nconst App = () => <div/>;\n```'
    expect(parseArtifact(content)?.kind).toBe('react')
  })

  it('trims whitespace inside a react block', () => {
    const a = parseArtifact('```jsx\n   const App = () => <div/>;   \n```')
    expect(a?.code).toBe('const App = () => <div/>;')
  })
})

describe('parseArtifact - html/svg/mermaid fences', () => {
  it('maps an html fence to kind html', () => {
    expect(parseArtifact('```html\n<div>x</div>\n```')).toEqual({
      kind: 'html',
      code: '<div>x</div>'
    })
  })

  it('maps an svg fence to kind svg', () => {
    expect(parseArtifact('```svg\n<svg></svg>\n```')).toEqual({ kind: 'svg', code: '<svg></svg>' })
  })

  it('maps a mermaid fence to kind mermaid', () => {
    expect(parseArtifact('```mermaid\ngraph TD; A-->B;\n```')).toEqual({
      kind: 'mermaid',
      code: 'graph TD; A-->B;'
    })
  })

  it('is case-insensitive on the fence language', () => {
    expect(parseArtifact('```HTML\n<div/>\n```')?.kind).toBe('html')
  })
})

describe('parseArtifact - plain js/ts blocks that look like React', () => {
  it('promotes a js block containing a JSX signal to react', () => {
    const a = parseArtifact('```js\nfunction App(){ return <div className="x"/>; }\n```')
    expect(a?.kind).toBe('react')
  })

  it('promotes a ts block containing useState to react', () => {
    const a = parseArtifact('```ts\nconst [n,setN] = useState(0);\n```')
    expect(a?.kind).toBe('react')
  })

  it('promotes a typescript block with an arrow-returning-jsx signal', () => {
    const a = parseArtifact('```typescript\nconst A = () => (\n  <p/>\n);\n```')
    expect(a?.kind).toBe('react')
  })

  it('combines multiple JSX-signalled plain blocks', () => {
    const content = '```js\nconst A = () => <i/>;\n```\n```js\nconst B = () => <A/>;\n```'
    const a = parseArtifact(content)
    expect(a?.kind).toBe('react')
    expect(a?.code).toBe('const A = () => <i/>;\n\nconst B = () => <A/>;')
  })

  it('does NOT treat a plain js block WITHOUT a JSX signal as an artifact', () => {
    expect(parseArtifact('```js\nconst sum = a + b;\nconsole.log(sum);\n```')).toBeNull()
  })
})

describe('parseArtifact - bare svg without a fence', () => {
  it('detects an unfenced <svg>...</svg> as an svg artifact', () => {
    const a = parseArtifact('here is art:\n<svg width="10"><rect/></svg>\nthanks')
    expect(a?.kind).toBe('svg')
    expect(a?.code).toBe('<svg width="10"><rect/></svg>')
  })
})

describe('parseArtifact - markdown/doc fence -> text', () => {
  it('maps a markdown fence to a text artifact', () => {
    expect(parseArtifact('```markdown\n# Title\nbody\n```')).toEqual({
      kind: 'text',
      code: '# Title\nbody'
    })
  })

  it('maps a md fence to a text artifact', () => {
    expect(parseArtifact('```md\n- one\n- two\n```')).toEqual({
      kind: 'text',
      code: '- one\n- two'
    })
  })
})

describe('parseArtifact - no artifact', () => {
  it('returns null for plain prose', () => {
    expect(parseArtifact('Sure, here is how you do it in words only.')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseArtifact('')).toBeNull()
  })

  it('returns null for a fenced block in an unsupported language', () => {
    expect(parseArtifact('```python\nprint("hi")\n```')).toBeNull()
  })
})

describe('parseArtifact - precedence ordering', () => {
  it('html/svg/mermaid fence wins over a bare unfenced svg later in the text', () => {
    const content = '```html\n<div/>\n```\n<svg><g/></svg>'
    expect(parseArtifact(content)?.kind).toBe('html')
  })

  it('JSX-signalled plain block wins over a bare svg and a markdown fence', () => {
    const content = '```js\nconst A = () => <b/>;\n```\n<svg/>\n```md\ndoc\n```'
    expect(parseArtifact(content)?.kind).toBe('react')
  })

  it('picks a bare svg (with a closing tag) when there are no fences at all', () => {
    expect(parseArtifact('intro <svg><g/></svg> outro')?.kind).toBe('svg')
  })

  it('does NOT match a self-closing <svg/> (the detector requires a </svg> close tag)', () => {
    expect(parseArtifact('intro <svg/> outro')).toBeNull()
  })
})
