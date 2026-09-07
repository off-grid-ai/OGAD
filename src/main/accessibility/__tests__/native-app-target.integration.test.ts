import { describe, expect, it } from 'vitest'
import {
  NativeAppTargeter,
  type InstalledNativeApp,
  type NativeAppPlatform
} from '../native-app-target'

class NativeBoundaryFake implements NativeAppPlatform {
  running: string[] = []
  installed: InstalledNativeApp[] = []
  launches: string[] = []
  activations: Array<{ id: string; runningName: string }> = []
  revealAfterLaunch = true

  async listRunning(): Promise<string[]> {
    return [...this.running]
  }

  async listInstalled(): Promise<InstalledNativeApp[]> {
    return [...this.installed]
  }

  async identify(app: InstalledNativeApp): Promise<InstalledNativeApp> {
    return app
  }

  async launch(app: InstalledNativeApp): Promise<void> {
    this.launches.push(app.id)
    if (this.revealAfterLaunch) this.running.push(app.name)
  }

  async activate(app: InstalledNativeApp, runningName: string): Promise<void> {
    this.activations.push({ id: app.id, runningName })
  }
}

describe('Computer Use native application targeting', () => {
  it('launches a closed installed app by stable identity and binds its live window', async () => {
    const native = new NativeBoundaryFake()
    native.installed = [{ id: 'net.whatsapp.WhatsApp', name: 'WhatsApp' }]
    const targeter = new NativeAppTargeter(native, {
      selfName: 'Off Grid AI Desktop',
      wait: async () => undefined
    })

    const target = await targeter.resolve('Send a message to Ali in WhatsApp')
    expect(target).toEqual({ id: 'net.whatsapp.WhatsApp', name: 'WhatsApp' })
    await expect(targeter.ensureReady(target!)).resolves.toEqual({
      identity: target,
      runningName: 'WhatsApp'
    })
    expect(native.launches).toEqual(['net.whatsapp.WhatsApp'])
    expect(native.activations).toEqual([
      { id: 'net.whatsapp.WhatsApp', runningName: 'WhatsApp' }
    ])
  })

  it('uses an existing app window without relaunching', async () => {
    const native = new NativeBoundaryFake()
    native.running = ['Slack']
    native.installed = [{ id: 'com.tinyspeck.slackmacgap', name: 'Slack' }]
    const targeter = new NativeAppTargeter(native, { selfName: 'Off Grid AI Desktop' })

    const target = await targeter.resolve('Open Slack and find Ali')
    await expect(targeter.ensureReady(target!)).resolves.toMatchObject({ runningName: 'Slack' })
    expect(native.launches).toEqual([])
    expect(native.activations).toEqual([
      { id: 'com.tinyspeck.slackmacgap', runningName: 'Slack' }
    ])
    expect(target?.id).toBe('com.tinyspeck.slackmacgap')
  })

  it('binds an OS app name that contains an invisible direction mark', async () => {
    const native = new NativeBoundaryFake()
    native.running = ['\u200eWhatsApp']
    native.installed = [{ id: 'net.whatsapp.WhatsApp', name: 'WhatsApp' }]
    const targeter = new NativeAppTargeter(native, { selfName: 'Off Grid AI Desktop' })

    const target = await targeter.resolve('Send a message in WhatsApp')
    await expect(targeter.ensureReady(target!)).resolves.toMatchObject({
      runningName: '\u200eWhatsApp'
    })
    expect(native.launches).toEqual([])
    expect(native.activations).toEqual([
      { id: 'net.whatsapp.WhatsApp', runningName: '\u200eWhatsApp' }
    ])
  })

  it('returns control to the vision rail when the named app cannot produce a window in time', async () => {
    const native = new NativeBoundaryFake()
    native.installed = [{ id: 'com.example.Unavailable', name: 'Unavailable' }]
    native.revealAfterLaunch = false
    let clock = 0
    const targeter = new NativeAppTargeter(native, {
      selfName: 'Off Grid AI Desktop',
      waitTimeoutMs: 10,
      pollIntervalMs: 5,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds
      }
    })

    const target = await targeter.resolve('Open Unavailable')
    await expect(targeter.ensureReady(target!)).resolves.toBeNull()
    expect(native.launches).toEqual(['com.example.Unavailable'])
    expect(native.activations).toEqual([])
  })

  it('never selects the Off Grid host as the controlled application', async () => {
    const native = new NativeBoundaryFake()
    native.running = ['Off Grid AI Desktop']
    native.installed = [{ id: 'ai.offgrid.desktop', name: 'Off Grid AI Desktop' }]
    const targeter = new NativeAppTargeter(native, { selfName: 'Off Grid AI Desktop' })

    await expect(targeter.resolve('Type this into Off Grid AI Desktop')).resolves.toBeNull()
  })
})
