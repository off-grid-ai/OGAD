import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AnalyticsProperties } from './properties'

/**
 * The in-flight marker behind `unclean_exit` (docs/ANALYTICS.md, Crashes).
 *
 * A model load or a generation writes the marker when it starts and removes it when it ends. A
 * marker still on disk at the next launch means the app died in the middle of that work. It is
 * reported only when it was written by this same version (not an app update), during this same
 * boot of the machine (not a reboot) and while the app was in the foreground (not a background
 * kill). Writes are asynchronous and serialised: inference paths never wait on the disk.
 */

export const UNCLEAN_EXIT_MARKER_FILE = 'analytics-inflight.json'

export type InflightStage = 'load' | 'generate'

export interface InflightWork {
  stage: InflightStage
  model: string
  engine: string | null
  backend: string | null
  freeRamGb: number
  startedAt: number
}

interface Marker extends InflightWork {
  version: string
  bootAt: number
  foreground: boolean
  /** Last time this process was known alive, so a report can say how long the work ran. */
  aliveAt: number
}

export interface UncleanExitEnvironment {
  dir: string
  version: string
  /** When the machine booted, in epoch ms. */
  bootAt: () => number
  now: () => number
}

/** Two boot-time readings of the same boot differ by clock drift only. */
const SAME_BOOT_TOLERANCE_MS = 120_000
/** While work runs, the marker is refreshed this often. It bounds how stale `elapsed_ms` can be. */
export const MARKER_HEARTBEAT_MS = 10_000

export class UncleanExitMarker {
  private readonly active = new Map<number, InflightWork>()
  private nextId = 1
  private foreground = true
  private writing: Promise<void> = Promise.resolve()
  private heartbeat: ReturnType<typeof setInterval> | undefined

  constructor(private readonly env: UncleanExitEnvironment) {}

  private get file(): string {
    return path.join(this.env.dir, UNCLEAN_EXIT_MARKER_FILE)
  }

  /** Record that work started. Returns the function that records it ended. */
  begin(work: InflightWork): () => void {
    const id = this.nextId++
    this.active.set(id, work)
    this.persist()
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.active.delete(id)
      this.persist()
    }
  }

  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return
    this.foreground = foreground
    if (this.active.size) this.persist()
  }

  /** A clean quit: nothing in flight counts as a crash any more. */
  clear(): Promise<void> {
    this.active.clear()
    this.persist()
    return this.writing
  }

  /** Wait for queued writes. */
  settled(): Promise<void> {
    return this.writing
  }

  private persist(): void {
    // The newest work is the one most likely to have taken the process down.
    const latest = [...this.active.values()].at(-1)
    const marker: Marker | null = latest
      ? {
          ...latest,
          version: this.env.version,
          bootAt: this.env.bootAt(),
          foreground: this.foreground,
          aliveAt: this.env.now()
        }
      : null
    if (marker && !this.heartbeat) {
      this.heartbeat = setInterval(() => this.persist(), MARKER_HEARTBEAT_MS)
      this.heartbeat.unref()
    } else if (!marker && this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
    this.writing = this.writing
      .then(async () => {
        if (marker) {
          await fs.mkdir(this.env.dir, { recursive: true })
          await fs.writeFile(this.file, JSON.stringify(marker))
        } else {
          await fs.rm(this.file, { force: true })
        }
      })
      .catch(() => {
        /* The marker is best effort. A failed write loses one report, never the app. */
      })
  }

  /**
   * Read and remove the previous launch's marker. Returns the `unclean_exit` properties when it
   * qualifies, otherwise null. Always removes the file so one crash is reported once.
   */
  async takePrevious(): Promise<AnalyticsProperties | null> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch {
      return null
    }
    await fs.rm(this.file, { force: true }).catch(() => {})
    let marker: Partial<Marker>
    try {
      marker = JSON.parse(raw) as Partial<Marker>
    } catch {
      return null
    }
    if (marker.version !== this.env.version) return null
    if (marker.foreground !== true) return null
    if (
      typeof marker.bootAt !== 'number' ||
      Math.abs(marker.bootAt - this.env.bootAt()) > SAME_BOOT_TOLERANCE_MS
    )
      return null
    if (marker.stage !== 'load' && marker.stage !== 'generate') return null
    const startedAt = typeof marker.startedAt === 'number' ? marker.startedAt : null
    const aliveAt = typeof marker.aliveAt === 'number' ? marker.aliveAt : null
    return {
      stage: marker.stage,
      model: typeof marker.model === 'string' ? marker.model : 'custom',
      engine: typeof marker.engine === 'string' ? marker.engine : null,
      backend: typeof marker.backend === 'string' ? marker.backend : null,
      free_ram_gb: typeof marker.freeRamGb === 'number' ? marker.freeRamGb : null,
      // How long the work had run when the process was last known alive.
      elapsed_ms:
        startedAt !== null && aliveAt !== null ? Math.max(0, Math.round(aliveAt - startedAt)) : null
    }
  }
}
