import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const strip = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const src = strip(readFileSync(join(__dirname, '..', 'tts.ts'), 'utf8'))
// The helper's location is resolved once, for tts.ts and the voice catalogue alike.
const availability = strip(readFileSync(join(__dirname, '..', 'runtime-availability.ts'), 'utf8'))

describe('tts.ts ExecuTorch runtime contract', () => {
  it('resolves the packaged native helper before the sibling development checkout', () => {
    expect(src).toContain('executorchSpeechBinary()')
    expect(availability).toMatch(
      /resourceDirs\(\)\.map\(\(root\) => path\.join\(root, 'bin', 'executorch-speech'\)\)/
    )
    expect(availability).toContain(
      "path.resolve(process.cwd(), '../executorch-speech/native/bin/executorch-speech')"
    )
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
