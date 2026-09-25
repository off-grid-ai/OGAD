import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ exists: vi.fn(), exec: vi.fn() }))

vi.mock('fs', () => ({ default: { existsSync: mocks.exists } }))
vi.mock('child_process', () => ({ execFile: mocks.exec }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' }
}))

import { runBoxedOCR, runOCR } from '../ocr'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.exists.mockImplementation((candidate: string) => candidate === '/app/resources/bin/ocr')
})

describe('OCR helper boundary', () => {
  it('reports an unavailable helper without executing a process', async () => {
    mocks.exists.mockReturnValue(false)
    await expect(runBoxedOCR('/tmp/frame.png')).resolves.toMatchObject({
      available: false,
      degradedReason: 'ocr_helper_missing'
    })
    await expect(runOCR('/tmp/frame.png')).resolves.toBe('')
    expect(mocks.exec).not.toHaveBeenCalled()
  })

  it('returns valid boxed blocks and ignores malformed ones', async () => {
    mocks.exec.mockImplementation((_bin, _args, _options, callback) =>
      callback(null, {
        stdout: JSON.stringify({
          width: 800,
          height: 600,
          blocks: [
            {
              text: 'Save',
              confidence: 0.9,
              bounds: { x: 10, y: 20, width: 30, height: 40 }
            },
            { text: 'invalid' }
          ]
        }),
        stderr: ''
      })
    )
    await expect(runBoxedOCR('/tmp/frame.png')).resolves.toEqual({
      width: 800,
      height: 600,
      blocks: [
        {
          text: 'Save',
          confidence: 0.9,
          bounds: { x: 10, y: 20, width: 30, height: 40 }
        }
      ],
      available: true
    })
  })

  it('returns trimmed text and degrades cleanly after process failures', async () => {
    mocks.exec.mockImplementationOnce((_bin, _args, _options, callback) =>
      callback(null, { stdout: '  visible text \n', stderr: '' })
    )
    await expect(runOCR('/tmp/frame.png')).resolves.toBe('visible text')

    mocks.exec.mockImplementationOnce((_bin, _args, _options, callback) =>
      callback(new Error('helper stopped'))
    )
    await expect(runBoxedOCR('/tmp/frame.png')).resolves.toMatchObject({
      available: false,
      degradedReason: 'ocr_failed'
    })
  })
})
