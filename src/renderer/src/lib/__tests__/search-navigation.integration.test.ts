import { describe, expect, it } from 'vitest'
import type { SearchHit } from '../../types'
import { navigateSearchHit, type SearchNavigationPorts } from '../search-navigation'

const baseHit: Omit<SearchHit, 'kind' | 'refId' | 'url' | 'ts'> = {
  key: 'result:1',
  title: 'Result',
  snippet: 'Local result',
  surface: 'Test',
  imagePath: null,
  score: 1
}

function hit(kind: SearchHit['kind'], refId: number, url: string | null = null, ts = 0): SearchHit {
  return { ...baseHit, kind, refId, url, ts }
}

describe('universal-search typed navigation seam', () => {
  it('routes every result kind without leaking source-kind branches into the app shell', () => {
    const opened: string[] = []
    const ports: SearchNavigationPorts = {
      selectEntity: (id) => opened.push(`entity:${String(id)}`),
      openMeeting: (id) => opened.push(`meeting:${String(id)}`),
      openChat: (target) => opened.push(JSON.stringify(target)),
      openReplay: (timestamp) => opened.push(`replay:${String(timestamp)}`)
    }

    navigateSearchHit(hit('entity', 11), ports)
    navigateSearchHit(hit('meeting', 13), ports)
    navigateSearchHit(hit('chat', 0, 'conversation-14'), ports)
    navigateSearchHit(hit('doc', 15, 'project-15'), ports)
    navigateSearchHit(hit('screen', 16, null, 1_700_000_000_000), ports)

    expect(opened).toEqual([
      'entity:11',
      'meeting:13',
      JSON.stringify({ conversationId: 'conversation-14' }),
      JSON.stringify({ projectId: 'project-15' }),
      'replay:1700000000000'
    ])
  })

  it('fails closed to nullable owners and uses the supplied clock for an undated capture', () => {
    const opened: string[] = []
    const ports: SearchNavigationPorts = {
      selectEntity: () => undefined,
      openMeeting: (id) => opened.push(`meeting:${String(id)}`),
      openChat: (target) => opened.push(String(target)),
      openReplay: (timestamp) => opened.push(`replay:${String(timestamp)}`)
    }

    navigateSearchHit(hit('meeting', 0), ports)
    navigateSearchHit(hit('chat', 0), ports)
    navigateSearchHit(hit('doc', 0), ports)
    navigateSearchHit(hit('screen', 1), ports, 42)

    expect(opened).toEqual(['meeting:null', 'null', 'null', 'replay:42'])
  })
})
