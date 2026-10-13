import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type AppleNotaryBoundary,
  notarizeAndStaple,
  notarizeCredentials,
  stapleWithRetry
} from '../../../scripts/notarize-mac.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const APP = '/tmp/Off Grid AI Desktop.app'
const CREDENTIALS = { appleApiKey: '/tmp/key.p8', appleApiKeyId: 'KEY', appleApiIssuer: 'ISSUER' }
const DROPPED = Object.assign(new Error('Command failed: xcrun stapler staple'), {
  stdout: 'The network connection was lost.\nThe staple and validate action failed! Error 68.'
})

// Apple's notary and ticket services are the only fakes: the real ones need signing credentials.
function appleBoundary(options: {
  notarizeError?: Error
  dropStaples?: number
  stapleError?: Error
}): {
  boundary: AppleNotaryBoundary
  calls: { notarize: number; staple: number; waits: number[] }
} {
  const calls = { notarize: 0, staple: 0, waits: [] as number[] }
  let dropped = 0
  return {
    calls,
    boundary: {
      async notarize(request: { tool: string; appPath: string }) {
        calls.notarize += 1
        expect(request).toMatchObject({ tool: 'notarytool', appPath: APP, ...CREDENTIALS })
        if (options.notarizeError) throw options.notarizeError
      },
      async staple(appPath: string) {
        calls.staple += 1
        expect(appPath).toBe(APP)
        if (options.stapleError) throw options.stapleError
        if (dropped < (options.dropStaples ?? 0)) {
          dropped += 1
          throw DROPPED
        }
        return { stdout: 'The staple and validate action worked!', stderr: '' }
      },
      async wait(ms: number) {
        calls.waits.push(ms)
      }
    }
  }
}

describe('Mac notarization hook', () => {
  it('reads the same Apple API key variables electron-builder uses, and skips without them', () => {
    expect(notarizeCredentials({})).toBeUndefined()
    expect(
      notarizeCredentials({
        APPLE_API_KEY: '/tmp/key.p8',
        APPLE_API_KEY_ID: 'KEY',
        APPLE_API_ISSUER: 'ISSUER'
      })
    ).toEqual(CREDENTIALS)
    expect(() => notarizeCredentials({ APPLE_API_KEY: '/tmp/key.p8' })).toThrow(
      'APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER must all be set'
    )
  })

  it('notarizes once and does not staple again when the library stapled', async () => {
    const { boundary, calls } = appleBoundary({})
    await notarizeAndStaple(APP, CREDENTIALS, boundary)
    expect(calls).toEqual({ notarize: 1, staple: 0, waits: [] })
  })

  it('keeps stapling while Apple drops the connection after an accepted notarization', async () => {
    const { boundary, calls } = appleBoundary({
      notarizeError: new Error(
        'Failed to staple your application with code: 68\n\nThe network connection was lost.'
      ),
      dropStaples: 3
    })
    await notarizeAndStaple(APP, CREDENTIALS, boundary)
    expect(calls.notarize).toBe(1)
    expect(calls.staple).toBe(4)
    expect(calls.waits).toEqual([30_000, 30_000, 30_000])
  })

  it('fails when the library could not staple for a reason other than the connection', async () => {
    const { boundary, calls } = appleBoundary({
      notarizeError: new Error(
        'Failed to staple your application with code: 65\n\nCloudKit query failed due to "Record not found".'
      )
    })
    await expect(notarizeAndStaple(APP, CREDENTIALS, boundary)).rejects.toThrow('Record not found')
    expect(calls.staple).toBe(0)
  })

  it('fails a rejected notarization without stapling', async () => {
    const { boundary, calls } = appleBoundary({
      notarizeError: new Error('Failed to notarize via notarytool: status Invalid')
    })
    await expect(notarizeAndStaple(APP, CREDENTIALS, boundary)).rejects.toThrow('status Invalid')
    expect(calls.staple).toBe(0)
  })

  it('does not retry a staple that failed for a reason other than the connection', async () => {
    const { boundary, calls } = appleBoundary({
      stapleError: Object.assign(new Error('Command failed: xcrun stapler staple'), {
        stdout: 'CloudKit query for Off Grid AI Desktop.app failed due to "Record not found".'
      })
    })
    await expect(stapleWithRetry(APP, boundary)).rejects.toThrow('Command failed')
    expect(calls.staple).toBe(1)
  })

  it('gives up after ten dropped connections', async () => {
    const { boundary, calls } = appleBoundary({ dropStaples: 99 })
    await expect(stapleWithRetry(APP, boundary)).rejects.toBe(DROPPED)
    expect(calls.staple).toBe(10)
  })

  it('is the hook that notarizes Mac builds, instead of electron-builder', () => {
    const config = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8')
    expect(config).toMatch(/^afterSign: scripts\/notarize-mac\.mjs$/m)
    expect(config).toMatch(/^ {2}notarize: false$/m)
  })
})
