import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

describe('offline Computer Use replay', () => {
  it('rebuilds fused candidates, reports recall and decision, and never actuates', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-computer-use-replay-'))
    const fixture = path.join(directory, 'fixture.json')
    fs.writeFileSync(
      fixture,
      JSON.stringify({
        name: 'sanitized-controls',
        ax: [
          {
            id: 'target',
            role: 'AXButton',
            label: 'Continue',
            bounds: { x: 100, y: 100, width: 100, height: 40 },
            enabled: true
          }
        ],
        ocr: [
          {
            text: 'Continue',
            confidence: 0.99,
            bounds: { x: 100, y: 100, width: 100, height: 40 }
          }
        ],
        expectedTargetId: 'target',
        recordedDecision: { candidateId: 'target', confidence: 0.91 },
        recordedTimings: { observeMs: 10, decisionMs: 20, totalMs: 35 }
      })
    )
    try {
      const replay = await execFileAsync(
        process.execPath,
        ['scripts/computer-use-replay.mjs', fixture],
        {
          cwd: process.cwd()
        }
      )
      const result = JSON.parse(replay.stdout) as Record<string, unknown>
      expect(result).toMatchObject({
        targetRecall: 1,
        decisionCorrect: 1,
        selectedCandidateId: 'target',
        confidence: 0.91,
        candidateCount: 1
      })
      expect(JSON.stringify(result)).not.toContain('actuate')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
