/**
 * Low-space capture containment at the real vision-service seam. Electron's
 * desktopCapturer is the OS boundary; the production VisionService owns the
 * thumbnail-to-file path. ENOSPC is injected only where Node writes the PNG.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const fixture = vi.hoisted(() => ({
  tmpDir: `/tmp/offgrid-vision-low-disk-${process.pid}-${Date.now()}`
}))
const TMP_DIR = fixture.tmpDir
const CAPTURES_DIR = path.join(TMP_DIR, 'captures')

vi.mock('electron', () => ({
  app: { getPath: () => fixture.tmpDir },
  desktopCapturer: {
    getSources: async ({ types }: { types: string[] }) =>
      types.includes('screen')
        ? [
            {
              id: 'screen:1:0',
              display_id: '1',
              thumbnail: {
                isEmpty: () => false,
                getSize: () => ({ width: 2, height: 2 }),
                toPNG: () =>
                  Buffer.from(
                    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQ80sW80tmgFAAFJ4DHTBv/HUAAAAASUVORK5CYII=',
                    'base64'
                  )
              }
            },
            {
              id: 'screen:3:0',
              display_id: '3',
              thumbnail: {
                isEmpty: () => false,
                getSize: () => ({ width: 2, height: 2 }),
                toPNG: () =>
                  Buffer.from(
                    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQ80sW80tmgFAAFJ4DHTBv/HUAAAAASUVORK5CYII=',
                    'base64'
                  )
              }
            }
          ]
        : [
            {
              id: 'window:51:0',
              name: 'Release notes',
              display_id: '1',
              thumbnail: {
                isEmpty: () => false,
                toPNG: () => Buffer.from('synthetic screenshot bytes')
              }
            },
            {
              id: 'window:52:0',
              name: 'Shared title',
              thumbnail: {
                isEmpty: () => false,
                toPNG: () => Buffer.from('focused window 52')
              }
            },
            {
              id: 'window:53:0',
              name: 'Shared title',
              thumbnail: {
                isEmpty: () => false,
                toPNG: () => Buffer.from('other window 53')
              }
            }
          ]
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: (point: { x: number }) =>
      point.x >= 1920
        ? { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }
        : { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
  }
}))

import { vision } from '../vision'

beforeEach(() => {
  fs.mkdirSync(CAPTURES_DIR, { recursive: true })
  for (const name of fs.readdirSync(CAPTURES_DIR)) {
    fs.rmSync(path.join(CAPTURES_DIR, name), { force: true })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('vision capture on an exhausted filesystem', () => {
  it('selects the focused window by native ID when titles are duplicated', async () => {
    const result = await vision.captureAppWindow('Notes', 'Shared title', undefined, 52)
    expect(result).not.toBeNull()
    expect(fs.readFileSync(result!)).toEqual(Buffer.from('focused window 52'))
  })

  it('does not save a display image when no unique active window can be identified', async () => {
    const result = await vision.captureAppWindow('Notes', 'Shared title')
    expect(result).toBeNull()
    expect(fs.readdirSync(CAPTURES_DIR)).toEqual([])
  })

  it('crops a matching display to the focused window bounds', async () => {
    const result = await vision.captureAppWindow('Notes', 'No Electron window source', {
      x: 300,
      y: 200,
      width: 1200,
      height: 700
    })
    expect(result).not.toBeNull()
    const { default: sharp } = await import('sharp')
    const image = await sharp(fs.readFileSync(result!)).metadata()
    expect({ width: image.width, height: image.height }).toEqual({ width: 2, height: 2 })
  })

  it('does not use another display when the active window display has no source', async () => {
    const result = await vision.captureAppWindow('Notes', 'No Electron window source', {
      x: 2100,
      y: 200,
      width: 900,
      height: 700
    })
    expect(result).toBeNull()
    expect(fs.readdirSync(CAPTURES_DIR)).toEqual([])
  })

  it('stops safely without creating a corrupt capture or disturbing existing bytes', async () => {
    const existing = path.join(CAPTURES_DIR, 'existing.png')
    const existingBytes = Buffer.from('existing readable capture')
    fs.writeFileSync(existing, existingBytes)
    const diskFull = Object.assign(new Error('ENOSPC: no space left on device, write'), {
      code: 'ENOSPC'
    })
    vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(diskFull)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await vision.captureAppWindow('Notes', 'Release notes')

    expect(result).toBeNull()
    expect(fs.readdirSync(CAPTURES_DIR)).toEqual(['existing.png'])
    expect(fs.readFileSync(existing)).toEqual(existingBytes)
    expect(console.error).toHaveBeenCalledWith('Vision Capture Failed:', diskFull)
  })
})
