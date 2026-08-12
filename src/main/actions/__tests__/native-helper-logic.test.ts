/**
 * Unit tests for the native-helper invoker's pure logic. Guards the command/response
 * contract the Swift helper (scripts/actions-helper/main.swift) and every semantic
 * tool share, plus the packaged-vs-dev binary resolution that mirrors ocr.ts. The
 * response parser must degrade every malformed shape to a reported { ok: false } so a
 * broken helper never throws into the tool loop.
 */
import path from 'path'
import { describe, expect, it } from 'vitest'
import { serializeCommand, helperBinCandidates, parseHelperResponse } from '../native-helper-logic'

describe('serializeCommand', () => {
  it('encodes the command and args as a single JSON string', () => {
    expect(serializeCommand({ command: 'calendar.createEvent', args: { title: 'Sync' } })).toBe(
      '{"command":"calendar.createEvent","args":{"title":"Sync"}}'
    )
  })
})

describe('helperBinCandidates', () => {
  it('prefers the bundled bin path in a packaged build', () => {
    expect(
      helperBinCandidates({
        isPackaged: true,
        resourcesPath: '/App/Contents/Resources',
        cwd: '/ignored',
        appPath: '/ignored'
      })
    ).toEqual([
      path.join('/App/Contents/Resources', 'bin', 'actions-helper'),
      path.join('/App/Contents/Resources', 'actions-helper')
    ])
  })

  it('resolves next to the source in a dev build', () => {
    expect(
      helperBinCandidates({
        isPackaged: false,
        resourcesPath: '/ignored',
        cwd: '/repo',
        appPath: '/app'
      })
    ).toEqual([
      path.join('/repo', 'scripts', 'actions-helper', 'actions-helper'),
      path.join('/app', 'scripts', 'actions-helper', 'actions-helper')
    ])
  })
})

describe('parseHelperResponse', () => {
  it('parses a success response and preserves the result', () => {
    expect(parseHelperResponse('{"ok":true,"result":{"id":"E1"}}')).toEqual({
      ok: true,
      result: { id: 'E1' }
    })
  })

  it('parses an in-band error response', () => {
    expect(parseHelperResponse('{"ok":false,"error":"calendar access was not granted"}')).toEqual({
      ok: false,
      error: 'calendar access was not granted'
    })
  })

  it('reads the last non-empty line so a stray leading line does not break parsing', () => {
    expect(parseHelperResponse('warming up\n\n{"ok":true,"result":null}\n')).toEqual({
      ok: true,
      result: null
    })
  })

  it('reports empty output as an error rather than throwing', () => {
    expect(parseHelperResponse('   \n  ')).toEqual({
      ok: false,
      error: 'actions helper returned no output'
    })
  })

  it('reports invalid JSON as an error and truncates the echoed text', () => {
    const res = parseHelperResponse('not json at all')
    expect(res.ok).toBe(false)
    expect(res).toMatchObject({ error: expect.stringContaining('invalid JSON') })
  })

  it('rejects a non-object JSON payload', () => {
    expect(parseHelperResponse('42')).toEqual({
      ok: false,
      error: 'actions helper returned a non-object response'
    })
  })

  it('rejects a recognized-shape-but-missing-ok payload', () => {
    expect(parseHelperResponse('{"result":{"id":"E1"}}')).toEqual({
      ok: false,
      error: 'actions helper returned an unrecognized response'
    })
  })

  it('substitutes a generic message when ok:false carries no error string', () => {
    expect(parseHelperResponse('{"ok":false}')).toEqual({
      ok: false,
      error: 'actions helper reported an error'
    })
  })
})
