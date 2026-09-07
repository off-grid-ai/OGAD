import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', 'tts.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')

describe('tts.ts ExecuTorch runtime contract', () => {
  it('resolves the packaged native helper before the sibling development checkout', () => {
    expect(src).toMatch(/resourceDirs\(\)\.map\(\(root\) => path\.join\(root, 'bin', 'executorch-speech'\)\)/)
    expect(src).toContain("path.resolve(process.cwd(), '../executorch-speech/native/bin/executorch-speech')")
  })

  it('keeps voice downloads in the app model cache', () => {
    expect(src).toContain("path.join(modelsDir(), '.cache', 'executorch-speech')")
  })
})

describe('tts.ts diagnostics do not log user-controlled voice data', () => {
  it('keeps the synthesis-start log free of the requested voice', () => {
    expect(src).toContain("writeDiagnosticLog('tts', 'request.started'")
    expect(src).not.toMatch(/request\.started[\s\S]{0,180}\bvoice\b/)
  })
})
