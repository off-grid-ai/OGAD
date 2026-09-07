import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const PROBE = path.join(REPO_ROOT, 'scripts', 'probe-packaged-tts.mjs')
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml')
const tempRoots: string[] = []

function createPackagedAppFixture(valid = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-packaged-tts-probe-'))
  tempRoots.push(root)
  const app = path.join(root, 'Off Grid AI Desktop.app')
  const runtime = path.join(app, 'Contents', 'Resources', 'bin', 'executorch-speech')
  fs.mkdirSync(path.dirname(runtime), { recursive: true })
  fs.writeFileSync(
    runtime,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(
      valid ? '{"runtime":"executorch","kokoro":true}' : '{"runtime":"other"}'
    )})\n`,
    { mode: 0o755 }
  )
  return app
}

afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

describe('packaged TTS release probe', () => {
  it('runs the exact packaged ExecuTorch runtime', () => {
    const result = spawnSync(process.execPath, [PROBE, createPackagedAppFixture()], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10_000
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('packaged ExecuTorch Kokoro runtime resolved')
  })

  it('rejects a packaged binary that does not report the expected runtime', () => {
    const result = spawnSync(process.execPath, [PROBE, createPackagedAppFixture(false)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10_000
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('packaged ExecuTorch runtime failed')
  })

  it('runs real synthesis after packaging and before any release upload', () => {
    const workflow = fs.readFileSync(WORKFLOW, 'utf8')
    const packageIndex = workflow.indexOf('npx electron-builder --mac')
    const probeIndex = workflow.indexOf('node scripts/probe-packaged-tts.mjs "$APP" --synthesize')
    const publishIndex = workflow.indexOf('Stage verified update assets and publish the release')
    expect(packageIndex).toBeGreaterThanOrEqual(0)
    expect(probeIndex).toBeGreaterThan(packageIndex)
    expect(publishIndex).toBeGreaterThan(probeIndex)
  })
})
