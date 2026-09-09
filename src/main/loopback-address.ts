// Pure, Electron-free: is a socket's remoteAddress a loopback (same-machine) client?
//
// The gateway binds to every interface so a phone on the LAN can reach the models, so several
// routes need to tell "the app talking to itself" from "a device across the network." One
// definition, used by every such guard, so they cannot drift (the settings-respawn guard and the
// transcription-offload guard must agree on what "local" means).
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  )
}
