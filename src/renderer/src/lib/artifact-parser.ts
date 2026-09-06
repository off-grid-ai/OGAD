import type { ArtifactKind } from './artifact-labels'

export interface Artifact {
  kind: ArtifactKind
  code: string
  title?: string
}

const JSX_SIGNAL =
  /(<[A-Za-z][^>]*>|<\/[A-Za-z]|=>\s*\(?\s*<|React\.|useState|ReactDOM|export default function|className=)/

/** Extract a renderable artifact from assistant markdown, if any. */
export function parseArtifact(content: string): Artifact | null {
  const reactBlocks = [...content.matchAll(/```(?:jsx|tsx|react)\s*\n([\s\S]*?)```/gi)].map(
    (block) => block[1]!.trim()
  )
  if (reactBlocks.length) return { kind: 'react', code: reactBlocks.join('\n\n') }

  const fenced = content.match(/```(html|svg|mermaid)\s*\n([\s\S]*?)```/i)
  if (fenced) {
    const language = fenced[1]!.toLowerCase()
    return {
      kind: language === 'svg' ? 'svg' : language === 'mermaid' ? 'mermaid' : 'html',
      code: fenced[2]!.trim()
    }
  }

  const scriptBlocks = [
    ...content.matchAll(/```(?:javascript|js|typescript|ts)\s*\n([\s\S]*?)```/gi)
  ].map((block) => block[1]!.trim())
  if (scriptBlocks.length && scriptBlocks.some((block) => JSX_SIGNAL.test(block))) {
    return { kind: 'react', code: scriptBlocks.join('\n\n') }
  }

  const svg = content.match(/<svg[\s\S]*<\/svg>/i)
  if (svg) return { kind: 'svg', code: svg[0] }

  const markdown = content.match(/```(?:markdown|md)\s*\n([\s\S]*?)```/i)
  if (markdown) return { kind: 'text', code: markdown[1]!.trim() }
  return null
}
