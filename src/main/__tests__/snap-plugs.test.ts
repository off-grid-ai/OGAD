import { describe, expect, it } from 'vitest'
import { isSnapMediaPlug, snapPlugFix } from '../snap-plugs'

const SNAP_ENV = { SNAP: '/snap/off-grid-ai/x1', SNAP_NAME: 'off-grid-ai' }
const connected = (answer: boolean | null) => async () => answer

describe('the snap microphone and camera plugs', () => {
  it('gives the connect command when the plug is off', async () => {
    await expect(snapPlugFix('audio-record', SNAP_ENV, connected(false))).resolves.toBe(
      'snap connect off-grid-ai:audio-record'
    )
    await expect(snapPlugFix('camera', SNAP_ENV, connected(false))).resolves.toBe(
      'snap connect off-grid-ai:camera'
    )
  })

  it('names a parallel install by its instance name', async () => {
    await expect(
      snapPlugFix(
        'audio-record',
        { ...SNAP_ENV, SNAP_INSTANCE_NAME: 'off-grid-ai_beta' },
        connected(false)
      )
    ).resolves.toBe('snap connect off-grid-ai_beta:audio-record')
  })

  it('asks for nothing when the plug is on, or snapd cannot say', async () => {
    await expect(snapPlugFix('audio-record', SNAP_ENV, connected(true))).resolves.toBeNull()
    await expect(snapPlugFix('audio-record', SNAP_ENV, connected(null))).resolves.toBeNull()
  })

  it('asks for nothing outside a snap', async () => {
    let asked = false
    const fix = await snapPlugFix('audio-record', {}, async () => {
      asked = true
      return false
    })
    expect(fix).toBeNull()
    expect(asked).toBe(false)
  })

  it('takes only the media plugs from the renderer', () => {
    expect(isSnapMediaPlug('audio-record')).toBe(true)
    expect(isSnapMediaPlug('camera')).toBe(true)
    expect(isSnapMediaPlug('home')).toBe(false)
    expect(isSnapMediaPlug(undefined)).toBe(false)
  })
})
