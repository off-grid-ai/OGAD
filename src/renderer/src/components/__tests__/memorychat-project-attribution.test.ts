// D21 — a send must attribute its output (RAG scope, saved artifacts, generated
// images) to the project active WHEN IT STARTED, not whatever the picker shows
// later. sendMessage locked `convId` but read the live `activeProjectId` at each
// await (ragChat, saveArtifact, generateImage), so switching project mid-stream
// landed the turn's output in the WRONG project — a cross-project data leak.
//
// The mid-await project-switch is intricate to drive deterministically in a render
// test (see DEVICE_TEST_LOG for the on-device check). This is the source-contract
// guard that the send captures the project once and never reads live
// activeProjectId in its attribution calls — red on HEAD (which passed
// activeProjectId straight into ragChat/saveArtifact/generateImage).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, '..', 'MemoryChat/index.tsx'), 'utf8')
const send = src.slice(src.indexOf('const sendMessage = async'), src.indexOf('const drainQueue ='))
const sendCode = send.replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ')

describe('sendMessage locks the project for the turn (D21)', () => {
  it('uses an explicit project override, otherwise captures the active project once at send-start', () => {
    expect(sendCode).toMatch(
      /const projectId = opts\?\.projectIdOverride !== undefined \? opts\.projectIdOverride : activeProjectId\b/
    )
  })

  it('never reads the live activeProjectId inside the send (all attribution uses the captured projectId)', () => {
    // In CODE (comments stripped) `activeProjectId` may appear ONLY once — the
    // capture line. Any other occurrence is a live read that can sneak the switched
    // project in.
    const occurrences = (sendCode.match(/activeProjectId/g) ?? []).length
    expect(occurrences).toBe(1)
    // Concretely: the RAG call and artifact saves are scoped by the captured value.
    // Formatting-agnostic (prettier reflows these calls across lines).
    expect(send).toMatch(/ragChat\([\s\S]*?history,\s*projectId\b/)
    expect(send).toMatch(/saveArtifact\(\{[\s\S]*?projectId: projectId\b/)
  })
})
