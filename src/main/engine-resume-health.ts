import { powerMonitor } from 'electron'
import { invalidateBackendFacts } from './backend-facts'
import { refreshNvidiaDriverVersion } from './nvidia-driver'

/** A driver update while asleep changes which GPU engines may run. */
function refreshBackendFacts(): void {
  invalidateBackendFacts()
  void refreshNvidiaDriverVersion()
    .then(invalidateBackendFacts)
    .catch(() => {})
}

interface ResumeHealthTarget {
  id: string
  shouldBeRunning(): boolean
  healthCheck(): Promise<boolean>
  restart(): Promise<void>
}

const targets = new Map<string, ResumeHealthTarget>()
let pending: Promise<void> | null = null

export function registerResumeHealthTarget(target: ResumeHealthTarget): () => void {
  targets.set(target.id, target)
  return () => {
    if (targets.get(target.id) === target) targets.delete(target.id)
  }
}

/** Requests arriving during the wake debounce wait for the engines to be checked. */
export async function waitForEngineResumeHealth(): Promise<void> {
  while (pending) await pending
}

export function installEngineResumeHealth(
  deps: {
    powerMonitor?: Pick<typeof powerMonitor, 'on' | 'removeListener'>
    invalidateBackendFacts?: () => void
  } = {}
): () => void {
  const monitor = deps.powerMonitor ?? powerMonitor
  let timer: ReturnType<typeof setTimeout> | undefined
  let finish: (() => void) | undefined
  let checking = false
  let disposed = false
  const check = async (): Promise<void> => {
    timer = undefined
    checking = true
    try {
      await Promise.all(
        [...targets.values()].map(async (target) => {
          try {
            if (!target.shouldBeRunning()) return
            const healthy = await target.healthCheck().catch(() => false)
            if (!disposed && !healthy && target.shouldBeRunning()) await target.restart()
          } catch (error) {
            console.error(`[engine-resume-health] ${target.id} recovery failed:`, error)
          }
        })
      )
    } finally {
      checking = false
      pending = null
      finish?.()
      finish = undefined
    }
  }
  const onResume = (): void => {
    ;(deps.invalidateBackendFacts ?? refreshBackendFacts)()
    if (checking || disposed) return
    if (!pending)
      pending = new Promise<void>((resolve) => {
        finish = resolve
      })
    clearTimeout(timer)
    timer = setTimeout(() => {
      void check()
    }, 2000)
  }
  monitor.on('resume', onResume)
  monitor.on('unlock-screen', onResume)
  return () => {
    disposed = true
    monitor.removeListener('resume', onResume)
    monitor.removeListener('unlock-screen', onResume)
    clearTimeout(timer)
    if (!checking) {
      pending = null
      finish?.()
      finish = undefined
    }
  }
}
