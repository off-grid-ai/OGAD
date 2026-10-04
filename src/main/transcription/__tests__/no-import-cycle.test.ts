import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const dir = join(__dirname, '..')
const read = (file: string): string => readFileSync(join(dir, file), 'utf8')

describe('transcription module load-cycle guard', () => {
  it('Whisper imports shared policy without importing the Desktop selector', () => {
    const source = read('whisper-cli.ts')
    expect(source).toContain("from '@offgrid/models'")
    expect(source).not.toContain("from './select'")
  })

  it('Parakeet imports shared policy without importing the Desktop selector', () => {
    const source = read('parakeet-cli.ts')
    expect(source).toContain("from '@offgrid/models'")
    expect(source).not.toContain("from './select'")
  })

  it('loads the Desktop selector with concrete native adapter composition', async () => {
    const module = await import('../select')
    expect(typeof module.pickTranscription).toBe('function')
  })
})
