import { execFile } from 'node:child_process'

// A strict snap reaches the microphone and camera only through plugs. Until Snapcraft approves
// auto-connect for off-grid-ai, each user connects them once with `snap connect`. This finds out
// whether a plug is connected and, when it is not, gives the one command that fixes it.

export type SnapMediaPlug = 'audio-record' | 'camera'

const SNAP_MEDIA_PLUGS: readonly SnapMediaPlug[] = ['audio-record', 'camera']

export function isSnapMediaPlug(plug: unknown): plug is SnapMediaPlug {
  return SNAP_MEDIA_PLUGS.includes(plug as SnapMediaPlug)
}

/** `snapctl is-connected` exits 0 when the plug is connected and 1 when it is not. */
export type PlugConnected = (plug: SnapMediaPlug) => Promise<boolean | null>

const snapctlIsConnected: PlugConnected = (plug) =>
  new Promise((resolve) => {
    execFile('snapctl', ['is-connected', plug], { timeout: 5_000 }, (error) => {
      if (!error) return resolve(true)
      const code: unknown = (error as { code?: unknown }).code
      // Any other failure (no snapctl, an old snapd) says nothing about the plug.
      resolve(code === 1 ? false : null)
    })
  })

/**
 * The command that connects `plug`, or null when nothing needs doing: not a snap, the plug is
 * connected, or snapd could not say.
 */
export async function snapPlugFix(
  plug: SnapMediaPlug,
  env: NodeJS.ProcessEnv = process.env,
  isConnected: PlugConnected = snapctlIsConnected
): Promise<string | null> {
  const snapName = env.SNAP_INSTANCE_NAME || env.SNAP_NAME
  if (!env.SNAP || !snapName) return null
  return (await isConnected(plug)) === false ? `snap connect ${snapName}:${plug}` : null
}
