import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The one truth record the renderer gets about this machine's health.
 *
 * The point of this module is that the renderer interprets nothing: it does not ask what platform it is
 * on, does not decide what a denied permission means, and does not compose a status out of parts. So the
 * tests assert the composed record, and above all what it says when the permission owner FAILS - because
 * "we could not read this" and "the user denied this" must not look the same. One tells the user to open
 * System Settings; the other is a fault in the app.
 *
 * The TCC boundary (macOS permissions) and the runtime health owner are the two collaborators. The
 * permission read is faked because it is the native boundary; the composition, the labels and the failure
 * handling are all real.
 */

const permissions = vi.hoisted(() => ({ getPermissionStatus: vi.fn() }))
vi.mock('../permissions', () => permissions)

const setup = vi.hoisted(() => ({ getSystemHealth: vi.fn() }))
vi.mock('../setup', () => setup)

const GRANTED = {
  accessibility: true,
  screenRecording: true,
  localNetwork: true,
  allGranted: true
}

describe('the system health record the renderer is handed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setup.getSystemHealth.mockResolvedValue({
      ramGb: 32,
      activeModel: 'gemma-4-E4B-it-Q4_K_M.gguf',
      components: [{ id: 'chat-engine', label: 'Chat engine', status: 'granted', detail: 'Running' }]
    })
  })

  it('appends a component per permission to whatever the runtime reported', async () => {
    permissions.getPermissionStatus.mockResolvedValue(GRANTED)
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()

    // The runtime's own facts survive untouched and its components come first - permissions are added to
    // the picture, not substituted for it.
    expect(health.ramGb).toBe(32)
    expect(health.activeModel).toBe('gemma-4-E4B-it-Q4_K_M.gguf')
    expect(health.components.map(({ id }) => id)).toEqual([
      'chat-engine',
      'permission-accessibility',
      'permission-screen-recording',
      'permission-local-network'
    ])
  })

  it('describes each granted permission by what it enables, not by its own name', async () => {
    permissions.getPermissionStatus.mockResolvedValue(GRANTED)
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()
    const detail = (id: string): string | undefined =>
      health.components.find((component) => component.id === id)?.detail

    // A user reading this wants to know what works, not that a TCC bit is set.
    expect(detail('permission-accessibility')).toBe('Capture and text insertion are allowed')
    expect(detail('permission-screen-recording')).toBe('Screen capture is allowed')
    expect(detail('permission-local-network')).toBe('Device discovery is allowed')
    expect(
      health.components
        .filter(({ id }) => id.startsWith('permission-'))
        .every(({ status }) => status === 'granted')
    ).toBe(true)
  })

  it('tells the user where to go when a permission is denied', async () => {
    permissions.getPermissionStatus.mockResolvedValue({
      accessibility: false,
      screenRecording: false,
      localNetwork: false,
      allGranted: false
    })
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()

    // Denied is actionable, so the detail is an instruction. Saying only "denied" leaves the user with
    // nothing to do about it.
    for (const component of health.components.filter(({ id }) => id.startsWith('permission-'))) {
      expect(component.status).toBe('denied')
      expect(component.detail).toBe('Grant access in System Settings')
    }
  })

  it('reports each permission independently rather than collapsing them into one verdict', async () => {
    permissions.getPermissionStatus.mockResolvedValue({
      accessibility: true,
      screenRecording: false,
      localNetwork: true,
      allGranted: false
    })
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()
    const status = (id: string): string | undefined =>
      health.components.find((component) => component.id === id)?.status

    // The common real state: capture is blocked while everything else is fine. A single rolled-up
    // "permissions: denied" would send the user hunting through three settings panes.
    expect(status('permission-accessibility')).toBe('granted')
    expect(status('permission-screen-recording')).toBe('denied')
    expect(status('permission-local-network')).toBe('granted')
  })

  it('says the status is UNAVAILABLE when the permission owner throws, not that it was denied', async () => {
    permissions.getPermissionStatus.mockRejectedValue(new Error('TCC database is locked'))
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()

    // This is the distinction that matters most here. Reporting a failed read as 'denied' would tell the
    // user to grant a permission they have already granted, and hide a real fault; 'down' plus the reason
    // points at the actual problem.
    const permissionComponents = health.components.filter(({ id }) => id.startsWith('permission-'))
    expect(permissionComponents).toHaveLength(3)
    for (const component of permissionComponents) {
      expect(component.status).toBe('down')
      expect(component.detail).toBe('Permission status unavailable: TCC database is locked')
    }
  })

  it('still reports the rest of the runtime when permissions cannot be read', async () => {
    permissions.getPermissionStatus.mockRejectedValue(new Error('nope'))
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()

    // A failed permission read must not blank the System Health screen - the chat engine's state is
    // exactly what a user checks that screen for.
    expect(health.components[0]).toMatchObject({ id: 'chat-engine', status: 'granted' })
  })

  it('still reports down when the boundary rejects with something that is not an Error', async () => {
    permissions.getPermissionStatus.mockRejectedValue({ code: 'EPERM' })
    const { getRenderedSystemHealth } = await import('../system-status-ipc')

    const health = await getRenderedSystemHealth()

    // A native boundary can reject with anything. What matters is that the status is still 'down' rather
    // than an unhandled rejection taking the whole health read with it.
    expect(health.components.at(-1)!.status).toBe('down')
    // The reason is String(error) for a non-Error, so a bare object stringifies to [object Object]. That is
    // the CURRENT behaviour, asserted rather than wished away: it is cosmetic (macOS rejects with real
    // Errors, which carry a message) and worth tidying only if a boundary is found that throws a plain
    // object the user would need to read.
    expect(health.components.at(-1)!.detail).toBe('Permission status unavailable: [object Object]')
  })
})

describe('registering the status channels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setup.getSystemHealth.mockResolvedValue({ ramGb: 32, activeModel: null, components: [] })
    permissions.getPermissionStatus.mockResolvedValue(GRANTED)
  })

  it('answers system:health with the composed record', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const { setupSystemStatusIpc } = await import('../system-status-ipc')

    setupSystemStatusIpc({ handle: (channel, listener) => handlers.set(channel, listener) })

    expect([...handlers.keys()]).toEqual(['system:health', 'permissions:get-status'])
    const health = (await handlers.get('system:health')!({})) as {
      components: { id: string }[]
    }
    // Registered AND wired: a handler that exists but returns something else is the failure this catches.
    expect(health.components.map(({ id }) => id)).toEqual([
      'permission-accessibility',
      'permission-screen-recording',
      'permission-local-network'
    ])
  })

  it('answers permissions:get-status from the production permission owner', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const { setupSystemStatusIpc } = await import('../system-status-ipc')

    setupSystemStatusIpc({ handle: (channel, listener) => handlers.set(channel, listener) })

    await expect(handlers.get('permissions:get-status')!({})).resolves.toEqual(GRANTED)
    expect(permissions.getPermissionStatus).toHaveBeenCalledTimes(1)
  })
})
