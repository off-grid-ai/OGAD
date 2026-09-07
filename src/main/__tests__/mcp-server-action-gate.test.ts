import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

// buildMcpServer pulls in electron/native modules (llm, imagegen, tts, ...), so
// it can't be exercised in-process. This is a source-level regression guard for
// the SECURITY contract instead: the action tools must be exposed ONLY to an
// authorized request. If someone un-gates them (registers unconditionally, or
// stops threading isActionAuthorized into the build), this test fails.
const SRC = readFileSync(path.join(__dirname, '..', 'mcp-server.ts'), 'utf8')

describe('mcp-server action-tool gate', () => {
  it('registers the action tools only inside the actionsAllowed branch', () => {
    // registerActionTools is *called* exactly once, and it is guarded.
    const calls = SRC.match(/^\s*registerActionTools\(server, authenticatedDeviceId\)/gm) ?? []
    expect(calls.length).toBe(1)
    expect(SRC).toMatch(
      /if \(actionsAllowed\) \{\s*\n\s*registerActionTools\(server, authenticatedDeviceId\)/
    )
  })

  it('builds the per-request server from the request authorization', () => {
    // The only build in the request path is gated on the token check.
    expect(SRC).toMatch(/const authorization = authorizeActionRequest\(req\)/)
    expect(SRC).toMatch(/buildMcpServer\(authorization\.allowed, authorization\.deviceId\)/)
    // buildMcpServer must take the flag — a no-arg call would register nothing
    // OR everything, defeating the gate.
    expect(SRC).toMatch(/buildMcpServer\([\s\S]*actionsAllowed: boolean/)
  })
})
