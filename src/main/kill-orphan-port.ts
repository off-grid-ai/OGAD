// Cross-platform "kill an orphaned server still holding OUR port" helper. Three
// bundled servers (llama, whisper, sd) each spawned on a fixed port and each had a
// copy of this — llm.ts's was cross-platform, whisper-server/sd-server's were
// posix-only, so on Windows a crashed whisper/sd server was never reaped and held
// the port after a restart. Defined ONCE here (cross-platform), matched by process
// name so we only ever kill a server we recognize (the port is ours by convention,
// not reservation — never SIGKILL an unrelated app that happened to bind it).

import { execSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'

/** Absolute path to a system tool, preferring fixed unwriteable locations over a PATH
 *  lookup: a poisoned PATH must not let an attacker substitute the process-killing tools
 *  we shell out to (Sonar S4036). Falls back to the bare name only if none of the known
 *  absolute paths exist (unusual layout) so functionality is never lost. Exported for test. */
export function sysTool(
  name: 'netstat' | 'tasklist' | 'taskkill' | 'powershell' | 'lsof' | 'ps'
): string {
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const candidates: Record<string, string[]> = {
    netstat: [path.join(sys32, 'netstat.exe')],
    tasklist: [path.join(sys32, 'tasklist.exe')],
    taskkill: [path.join(sys32, 'taskkill.exe')],
    powershell: [path.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
    lsof: ['/usr/sbin/lsof', '/usr/bin/lsof'],
    ps: ['/bin/ps', '/usr/bin/ps']
  }
  for (const c of candidates[name] ?? []) {
    if (existsSync(c)) return c
  }
  return name
}

export interface PortReapResult {
  killed: number
  /** Recognized server PIDs owned by a DIFFERENT live parent process. */
  liveOwners: number[]
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Return a process's parent PID. An unknown parent is treated conservatively by callers: a
 * process we cannot prove orphaned must never be killed merely because it owns our usual port. */
function parentPid(pid: number): number | null {
  try {
    const output =
      process.platform === 'win32'
        ? execSync(
            `"${sysTool('powershell')}" -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ParentProcessId"`,
            { encoding: 'utf-8' }
          )
        : execSync(`"${sysTool('ps')}" -p ${pid} -o ppid=`, { encoding: 'utf-8' })
    const parsed = Number(output.trim())
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
  } catch {
    return null
  }
}

function isOwnedByAnotherLiveProcess(pid: number): boolean {
  const ownerPid = parentPid(pid)
  if (ownerPid === null) return true
  if (ownerPid <= 1 || ownerPid === process.pid) return false
  return processIsAlive(ownerPid)
}

/** Parse `netstat -ano -p tcp` output for the PIDs LISTENING on `port`. Handles both
 *  IPv4 (`127.0.0.1:8439`) and IPv6 (`[::]:8439`, `[::1]:8439`) local-address rows: the
 *  pattern anchors the captured port to the LISTENING+PID tail, so the leftmost full match
 *  is always the local port (never the `:1` inside `::1`, nor the foreign `:0`). Exported
 *  for the regression test — the win32 branch itself can't run in-process. */
export function parseWindowsListenerPids(netstatOutput: string, port: number): string[] {
  const pids = new Set<string>()
  for (const line of netstatOutput.split(/\r?\n/)) {
    // "  TCP    127.0.0.1:8439   0.0.0.0:0   LISTENING   12345"
    // "  TCP    [::1]:8439       [::]:0      LISTENING   12345"
    const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i)
    if (m && m[1] === String(port) && m[2]) pids.add(m[2])
  }
  return [...pids]
}

/** Kill any process holding `port` that `matches` (a crashed/previous instance of one
 *  of our servers). Cross-platform: netstat/tasklist/taskkill on Windows, lsof/ps on
 *  macOS+Linux. `matches` receives the process command line (posix `ps`, full path) or
 *  image name (win32 `tasklist`) — the caller decides how strict to be per platform, so
 *  the port is only ever reclaimed from a server we recognize, never an unrelated app.
 *  A recognized process is only reaped when its parent is gone (a true orphan) or it belongs to
 *  this process (an intentional replacement). A server owned by another live app is preserved
 *  and reported to the caller. `label` is only for logging; missing tools and empty ports are
 *  conservative no-ops. */
export function reapOrphanProcessesOnPort(
  port: number,
  matches: (procInfo: string) => boolean,
  label = 'server'
): PortReapResult {
  let killed = 0
  const liveOwners = new Set<number>()
  try {
    if (process.platform === 'win32') {
      const pids = parseWindowsListenerPids(
        execSync(`"${sysTool('netstat')}" -ano -p tcp`, { encoding: 'utf-8' }),
        port
      )
      for (const pid of pids) {
        let img = ''
        try {
          img = execSync(`"${sysTool('tasklist')}" /FI "PID eq ${pid}" /FO CSV /NH`, {
            encoding: 'utf-8'
          })
        } catch {
          continue /* gone */
        }
        if (!matches(img)) {
          console.warn(`[orphan] port ${port} held by non-${label} PID ${pid} — leaving it alone`)
          continue
        }
        if (isOwnedByAnotherLiveProcess(Number(pid))) {
          liveOwners.add(Number(pid))
          console.warn(
            `[orphan] port ${port} belongs to a live ${label} owner (PID ${pid}) - leaving it alone`
          )
          continue
        }
        try {
          execSync(`"${sysTool('taskkill')}" /PID ${pid} /F /T`, { stdio: 'ignore' })
          killed++
          console.log(`[orphan] killed orphaned ${label} ${pid} on port ${port}`)
        } catch {
          /* gone */
        }
      }
    } else {
      const pids = execSync(`"${sysTool('lsof')}" -ti tcp:${port}`, { encoding: 'utf-8' })
        .trim()
        .split('\n')
        .filter(Boolean)
      for (const pid of pids) {
        let cmd = ''
        try {
          cmd = execSync(`"${sysTool('ps')}" -p ${pid} -o command=`, { encoding: 'utf-8' }).trim()
        } catch {
          continue /* already gone */
        }
        if (!matches(cmd)) {
          console.warn(
            `[orphan] port ${port} held by non-${label} process ${pid} (${cmd.slice(0, 80)}) — leaving it alone`
          )
          continue
        }
        if (isOwnedByAnotherLiveProcess(Number(pid))) {
          liveOwners.add(Number(pid))
          console.warn(
            `[orphan] port ${port} belongs to a live ${label} owner (PID ${pid}) - leaving it alone`
          )
          continue
        }
        try {
          // `killed` counts SIGNALS DELIVERED, not exits observed: there is no wait and no
          // recheck here, and SIGKILL does not return memory from a process in an uninterruptible
          // wait. So it is a hint, never evidence. A caller that needs to know whether the port
          // came back must PROBE it (`isPortFree`), and one that needs to know whether memory came
          // back must prove the process exited (`process-teardown`). One caller already read this
          // count as a port-free check; that is the mistake this note exists to prevent.
          process.kill(Number(pid), 'SIGKILL')
          killed++
          console.log(`[orphan] killed orphaned ${label} ${pid} on port ${port}`)
        } catch {
          /* gone */
        }
      }
    }
  } catch {
    /* nothing on the port */
  }
  return { killed, liveOwners: [...liveOwners] }
}

/** Backward-compatible count-only surface for resident runtimes that only need stale cleanup. */
export function killOrphansOnPort(
  port: number,
  matches: (procInfo: string) => boolean,
  label = 'server'
): number {
  return reapOrphanProcessesOnPort(port, matches, label).killed
}
