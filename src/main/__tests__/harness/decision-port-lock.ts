// The Decision runtime always starts at port 8459 and takes the first free one after it. Two test
// files that start Decision servers at once can pick the same port; one file's server then answers
// the other's requests. Files that start them take this machine-wide lock for each test, so they
// take turns. A lock left by a process that died is taken over.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const LOCK = path.join(os.tmpdir(), 'offgrid-decision-ports.lock')

function holderAlive(): boolean {
  try {
    const pid = Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8'))
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Wait for the Decision port range, then hold it; returns the release. */
export async function holdDecisionPorts(): Promise<() => void> {
  for (;;) {
    try {
      fs.mkdirSync(LOCK)
      fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid))
      return () => fs.rmSync(LOCK, { recursive: true, force: true })
    } catch {
      if (!holderAlive()) fs.rmSync(LOCK, { recursive: true, force: true })
      else await delay(50)
    }
  }
}
