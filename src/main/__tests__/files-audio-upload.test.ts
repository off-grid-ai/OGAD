// An attached recording is kept, so the chat can play it and not only show its transcript.
// Electron's userData location and the speech engine (media-text, the transcription boundary) are
// the only fakes; the upload's file handling is real.

import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-audio-upload-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

// The speech engine heard nothing: an empty transcript needs no document index either.
vi.mock('../media-text', () => ({
  mediaText: { transcribeAudio: async () => '' }
}))

import { processUpload } from '../files'

afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('processUpload audio', () => {
  it('keeps the recording in uploads and returns its path beside the transcript', async () => {
    const bytes = Buffer.from('RIFF....WAVEfmt fake audio bytes')

    const result = await processUpload('note.wav', bytes)

    expect(result).toMatchObject({ name: 'note.wav', kind: 'audio', text: '' })
    expect(result.path).toBeTruthy()
    expect(path.dirname(result.path!)).toBe(path.join(userData, 'uploads'))
    expect(fs.readFileSync(result.path!)).toEqual(bytes)
  })
})
