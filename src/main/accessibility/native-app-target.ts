import {
  selectApplicationTarget,
  selectApplicationTargetFromGoal,
  type ApplicationTargetDescriptor
} from '@offgrid/automation'

export interface InstalledNativeApp {
  /** Stable OS launch identity: bundle id on macOS, AppUserModelID on Windows. */
  id: string
  name: string
  launchRef?: string
}

export interface NativeAppPlatform {
  listRunning(): Promise<string[]>
  listInstalled(): Promise<InstalledNativeApp[]>
  /** Replace a discovery reference with the stable native identity when needed. */
  identify?(app: InstalledNativeApp): Promise<InstalledNativeApp>
  launch(app: InstalledNativeApp): Promise<void>
  activate(app: InstalledNativeApp, runningName: string): Promise<void>
}

export interface ReadyNativeApp {
  identity: InstalledNativeApp
  /** The live display name used by AX/UIA for all reads during this task. */
  runningName: string
}

export interface NativeAppTargetOptions {
  selfName: string
  waitTimeoutMs?: number
  pollIntervalMs?: number
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}

function findRunningName(appName: string, running: readonly string[]): string | null {
  const candidates = running.map(runningDescriptor)
  const selection = selectApplicationTarget(appName, candidates)
  return selection.outcome === 'selected' ? selection.target.displayName : null
}

function runningDescriptor(name: string): ApplicationTargetDescriptor {
  return {
    id: `running:${name}`,
    displayName: name,
    launchable: false,
    running: true,
    hasVisibleWindow: true
  }
}

/**
 * Resolve, launch, and bind one native application before the Computer Use loop starts.
 * The model never launches an application by guessing a Dock or taskbar icon.
 */
export class NativeAppTargeter {
  private readonly waitTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly now: () => number
  private readonly wait: (milliseconds: number) => Promise<void>

  constructor(
    private readonly platform: NativeAppPlatform,
    private readonly options: NativeAppTargetOptions
  ) {
    this.waitTimeoutMs = options.waitTimeoutMs ?? 10_000
    this.pollIntervalMs = options.pollIntervalMs ?? 150
    this.now = options.now ?? Date.now
    this.wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  async resolve(goal: string): Promise<InstalledNativeApp | null> {
    const running = await this.platform.listRunning()
    const installed = await this.platform.listInstalled()
    const runningCandidates = running.map(runningDescriptor)
    const matchedRunningIds = new Set<string>()
    const candidates: ApplicationTargetDescriptor[] = installed.map((app) => {
      const match = selectApplicationTarget(app.name, runningCandidates)
      const runningTarget = match.outcome === 'selected' ? match.target : null
      if (runningTarget) matchedRunningIds.add(runningTarget.id)
      return {
        id: app.id,
        displayName: app.name,
        launchable: true,
        running: runningTarget !== null,
        hasVisibleWindow: runningTarget !== null
      }
    })
    candidates.push(...runningCandidates.filter((app) => !matchedRunningIds.has(app.id)))

    const excludedIds = candidates
      .filter(
        (candidate) =>
          selectApplicationTarget(this.options.selfName, [candidate]).outcome === 'selected'
      )
      .map((candidate) => candidate.id)
    const selection = selectApplicationTargetFromGoal(goal, candidates, excludedIds)
    if (selection.outcome !== 'selected') return null

    const installedTarget = installed.find((app) => app.id === selection.target.id)
    if (installedTarget) return this.platform.identify?.(installedTarget) ?? installedTarget
    return {
      id: selection.target.id,
      name: selection.target.displayName
    }
  }

  async ensureReady(target: InstalledNativeApp): Promise<ReadyNativeApp | null> {
    let running = await this.platform.listRunning()
    let runningName = findRunningName(target.name, running)
    if (!runningName) {
      await this.platform.launch(target)
      const deadline = this.now() + this.waitTimeoutMs
      while (!runningName && this.now() < deadline) {
        await this.wait(this.pollIntervalMs)
        running = await this.platform.listRunning()
        runningName = findRunningName(target.name, running)
      }
    }
    if (!runningName) return null
    await this.platform.activate(target, runningName)
    return { identity: target, runningName }
  }
}
