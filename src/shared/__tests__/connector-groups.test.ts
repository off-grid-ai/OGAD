import { describe, expect, it } from 'vitest'
import { connectorSite, groupConnectors } from '../connector-groups'

const c = (name: string, url: string | null): { name: string; url: string | null } => ({
  name,
  url
})

describe('groupConnectors', () => {
  it('groups by the site each address is on, named by what most of them are called', () => {
    const groups = groupConnectors([
      c('Notion', 'https://mcp.notion.com/mcp'),
      c(
        'Google (ada@example.com)',
        'https://gmailmcp.googleapis.com/mcp/v1?offgrid-services=workspace'
      ),
      c('Microsoft (ada@example.org)', 'offgrid-microsoft://workspace'),
      c('Google Calendar', 'https://calendarmcp.googleapis.com/mcp/v1'),
      c('Gmail', 'https://gmailmcp.googleapis.com/mcp/v1'),
      c('Notion', 'https://mcp.notion.com/mcp'),
      c('DeepWiki', 'https://mcp.deepwiki.com/mcp')
    ])
    expect(groups.map((g) => [g.label, g.connectors.length])).toEqual([
      ['Notion', 2],
      ['Google', 3],
      ['Microsoft', 1],
      ['DeepWiki', 1]
    ])
  })

  it('keeps a connector with no address on its own', () => {
    expect(groupConnectors([c('Local tools', null)])).toEqual([
      { key: 'name:Local tools', label: 'Local tools', connectors: [c('Local tools', null)] }
    ])
  })

  it('reads the site from web and app addresses', () => {
    expect(connectorSite('https://a.b.example.co/x')).toBe('example.co')
    expect(connectorSite('offgrid-microsoft://workspace')).toBe('offgrid-microsoft')
    expect(connectorSite('not a url')).toBe('')
  })
})
