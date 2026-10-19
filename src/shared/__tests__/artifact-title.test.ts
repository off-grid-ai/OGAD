import { describe, expect, it } from 'vitest'
import { artifactTitle } from '../artifact-title'

describe('artifactTitle', () => {
  it('names a page by its title, then its first heading', () => {
    expect(
      artifactTitle('html', '<html><head><title>Liquid Chrome Orb</title></head></html>')
    ).toBe('Liquid Chrome Orb')
    expect(artifactTitle('html', '<body><h1>Voxel Pagoda</h1></body>')).toBe('Voxel Pagoda')
  })

  it('names a component by its function and a document by its heading', () => {
    expect(artifactTitle('react', 'export default function Hero() { return null }')).toBe('Hero')
    expect(artifactTitle('text', '# Off Grid AI overview\n\nRun models locally.')).toBe(
      'Off Grid AI overview'
    )
  })

  it('names a diagram by its own title, never by its type line', () => {
    expect(artifactTitle('mermaid', '---\ntitle: Rollout plan\n---\nflowchart LR\n  A --> B')).toBe(
      'Rollout plan'
    )
    expect(artifactTitle('mermaid', 'pie\n  title Time spent\n  "Work" : 60')).toBe('Time spent')
    expect(artifactTitle('mermaid', 'graph TD\n  A[Scope] --> B[Kickoff]')).toBe('Diagram')
  })

  it('falls back to what the artifact is when it names nothing', () => {
    expect(artifactTitle('html', '<div>Alpha</div>')).toBe('HTML page')
    expect(artifactTitle('react', 'function App() { return null }')).toBe('React component')
    expect(artifactTitle('text', 'plain words')).toBe('Document')
  })
})
