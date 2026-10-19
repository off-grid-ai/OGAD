// The name an artifact goes by: the page's own <title> or first heading, a component's name, a
// diagram's own title. One rule for the saved library (main) and the chat's artifact card
// (renderer), so a card and its saved copy carry the same name.

import type { ArtifactKindContract } from './ipc-contracts'

const FALLBACK: Record<ArtifactKindContract, string> = {
  html: 'HTML page',
  svg: 'SVG graphic',
  mermaid: 'Diagram',
  react: 'React component',
  text: 'Document',
  image: 'Image'
}

export function artifactTitle(kind: ArtifactKindContract, code: string): string {
  if (kind === 'html') {
    const t =
      /<title[^>]*>([^<]+)<\/title>/i.exec(code)?.[1] || /<h1[^>]*>([^<]+)<\/h1>/i.exec(code)?.[1]
    if (t?.trim()) return t.trim().slice(0, 80)
  }
  if (kind === 'mermaid') {
    // Its own title (front matter "title: ..." or a "title ..." line). The first line is the
    // diagram's type ("graph TD", "sequenceDiagram"): syntax, not a name.
    const title = /^\s*title:\s*(.+)$/m.exec(code)?.[1] ?? /^\s*title\s+(.+)$/m.exec(code)?.[1]
    return (
      title
        ?.trim()
        .replace(/^["']|["']$/g, '')
        .slice(0, 60) || FALLBACK.mermaid
    )
  }
  if (kind === 'text') {
    const heading = /^\s{0,3}#{1,3}\s+(.+)$/m.exec(code)?.[1]?.trim()
    if (heading) return heading.slice(0, 80)
  }
  if (kind === 'react') {
    const fn = /function\s+([A-Za-z0-9_]+)/.exec(code)?.[1]
    if (fn && fn !== 'App') return fn
  }
  return FALLBACK[kind]
}
