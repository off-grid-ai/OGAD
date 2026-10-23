import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { beginRuntimeBackend, parseNativeBackend } from '../runtime-backends'
import { demoteBackend } from '../backend-facts'
import { classifyLlamaError } from '../llama-error'
import { isPortFree, pickFreePort } from '../free-port'
import { reapOrphanProcessesOnPort } from '../kill-orphan-port'
import { selectLocalEngines } from './select-local-engine'
import { buildLaunchArgs } from './settings-math'
import { engineSpawnEnv } from './spawn-env'

type Step = Awaited<ReturnType<typeof selectLocalEngines>>[number]
type LaunchArgs = Parameters<typeof buildLaunchArgs>[0]
interface Options {
  id: 'grounding' | 'decision'
  label: string
  modality: 'grounding' | 'decision'
  port: number
  modelPaths(): Promise<{ model: string; modelPath: string; mmProjPath: string }>
  extraArgs(step: Step): Omit<LaunchArgs, 'modelPath' | 'mmProjPath' | 'port' | 'cpuOnly'>
  readyTimeoutMs?: number
}

const WINDOW_MS = 120_000
const LIMIT_REASON = 'Stopped repeatedly. Automatic restart limit reached.'
const GPU_FAULT = /compute error|cuda error|ggml_cuda|device lost|ErrorDeviceLost/i
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Owns the process, backend ladder and recovery budget for a dedicated server. */
export class DedicatedLlamaRuntime {
  private process: ChildProcess | null = null
  private pending: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private wanted = false
  private generation = 0
  private attempted = false
  private ready = false
  private model = ''
  private healthyOnce = false
  private restarts: number[] = []
  private faults: { backend: Step['backend']; at: number }[] = []
  private record?: ReturnType<typeof beginRuntimeBackend>
  private failure = ''
  failureCode: string | undefined
  backend: string | undefined
  port: number

  constructor(private readonly options: Options) {
    this.port = options.port
  }

  get isRunning(): boolean {
    return this.ready && this.processAlive
  }

  /** Running until the process reports an exit code or signal (a sent kill is not an exit yet). */
  private get processAlive(): boolean {
    return this.process !== null && this.process.exitCode == null && this.process.signalCode == null
  }

  shouldBeRunning(): boolean {
    return this.wanted
  }
  recordRequest(): void {
    this.record?.recordRequest()
  }

  async health(): Promise<boolean> {
    const child = this.process
    if (!this.processAlive) return false
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
        signal: AbortSignal.timeout(3_000)
      })
      return response.status === 200 && this.process === child && this.processAlive
    } catch {
      return false
    }
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping
    if (this.pending) return this.pending
    if (this.isRunning) return
    this.wanted = true
    const generation = this.generation
    this.pending = this.run(generation).finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private assertWanted(generation: number): void {
    if (!this.wanted || generation !== this.generation)
      throw new Error(`${this.options.label} stopped.`)
  }

  private async run(generation: number): Promise<void> {
    for (;;) {
      this.assertWanted(generation)
      if (this.attempted) {
        this.restarts = this.restarts.filter((at) => Date.now() - at < WINDOW_MS)
        if (this.restarts.length >= 3) {
          this.failureCode = 'startup'
          this.failure = LIMIT_REASON
          // A failed lease is terminal. Publish the budget failure on a fresh lease.
          this.record = beginRuntimeBackend(this.options.id, this.model || this.options.label)
          this.record.fail(LIMIT_REASON)
          throw new Error(LIMIT_REASON)
        }
        this.restarts.push(Date.now())
        await delay(1_000 * this.restarts.length)
        this.assertWanted(generation)
      }
      this.attempted = true
      try {
        await this.launch(generation)
        return
      } catch (error) {
        this.assertWanted(generation)
        if (!this.healthyOnce) throw error
        // Recovery attempts that fail to load use the same budget as crashes.
      }
    }
  }

  private async launch(generation: number): Promise<void> {
    let paths: Awaited<ReturnType<Options['modelPaths']>>
    try {
      paths = await this.options.modelPaths()
    } catch (error) {
      this.assertWanted(generation)
      this.record = beginRuntimeBackend(this.options.id, this.model || this.options.label)
      this.record.fail(error)
      throw error
    }
    this.model = paths.model
    this.assertWanted(generation)
    this.record = beginRuntimeBackend(this.options.id, paths.model)
    const failures: string[] = []
    this.failureCode = undefined
    try {
      reapOrphanProcessesOnPort(
        this.options.port,
        (command) => /llama-server/i.test(command),
        `${this.options.label} llama-server`
      )
      const port = await pickFreePort(this.options.port, isPortFree, 20)
      if (port === null)
        throw new Error(`No private port is available for the ${this.options.label} runtime.`)
      this.port = port
      const steps = await selectLocalEngines(this.options.modality)
      for (const step of steps) {
        this.assertWanted(generation)
        let stderr = ''
        let output = ''
        let loading = true
        let faultedAt: number | undefined
        let spawnError: Error | undefined
        const record = this.record
        const child = spawn(
          step.path,
          buildLaunchArgs({
            ...this.options.extraArgs(step),
            modelPath: paths.modelPath,
            mmProjPath: paths.mmProjPath,
            port,
            cpuOnly: step.cpuOnly
          }),
          {
            env: {
              ...process.env,
              ...engineSpawnEnv({
                platform: process.platform,
                binDir: path.dirname(step.path),
                currentEnv: process.env
              })
            },
            stdio: ['ignore', 'ignore', 'pipe']
          }
        )
        this.process = child
        child.on('error', (error) => {
          spawnError = error
        })
        child.stderr!.on('data', (chunk) => {
          if (loading) {
            const text = String(chunk)
            stderr = (stderr + text).slice(-16_384)
            output = (output + text).slice(-65_536)
            record.observe(text)
            console.log(`[${this.options.label} runtime] ${text}`)
          } else if (GPU_FAULT.test(String(chunk))) {
            faultedAt = Date.now() // Do not retain or log request text.
          }
        })
        child.once('close', (code, signal) => {
          if (this.process !== child) return
          this.process = null
          this.ready = false
          if (loading || !this.wanted || generation !== this.generation) return
          const now = Date.now()
          const gpuFault = faultedAt !== undefined && now - faultedAt < WINDOW_MS
          this.failure = gpuFault
            ? `${this.options.label} GPU compute failed.`
            : `${this.options.label} runtime stopped unexpectedly (${signal ?? code ?? 'unknown'}).`
          this.faults = this.faults.filter((fault) => now - fault.at < WINDOW_MS)
          if (gpuFault && step.backend !== 'cpu') {
            this.faults.push({ backend: step.backend, at: now })
            if (this.faults.filter((fault) => fault.backend === step.backend).length >= 2)
              demoteBackend(this.options.modality, step.backend)
          }
          record.fail(this.failure)
          // Wait for a start that has just completed before requesting recovery.
          void (async () => {
            await this.pending?.catch(() => {})
            if (this.wanted && generation === this.generation) await this.start()
          })().catch(() => {})
        })
        try {
          const startedAt = Date.now()
          for (;;) {
            this.assertWanted(generation)
            if (spawnError) throw spawnError
            if (!this.processAlive)
              throw new Error(`${this.options.label} runtime stopped during startup.`)
            if (Date.now() - startedAt > (this.options.readyTimeoutMs ?? Infinity))
              throw new Error(`${this.options.label} runtime timed out during startup.`)
            if (await this.health()) break
            await delay(100)
          }
          this.assertWanted(generation)
          loading = false
          this.ready = true
          const placement = parseNativeBackend(output)
          this.backend = step.cpuOnly ? 'CPU' : (placement?.backend ?? step.backend)
          record.ready(
            this.backend,
            placement?.device,
            failures.join(' ') || this.failure || undefined
          )
          stderr = ''
          output = ''
          this.failure = ''
          this.healthyOnce = true
          return
        } catch (error) {
          const classified =
            classifyLlamaError(stderr) ??
            (/out of memory|cannot allocate|metal.*alloc|cuda.*memory/i.test(stderr)
              ? { code: 'out_of_memory', reason: 'The device does not have enough free memory.' }
              : null)
          const code: string | undefined = classified?.code
          if (this.failureCode !== 'out_of_memory') this.failureCode = code ?? this.failureCode
          const reason =
            classified?.reason ?? (error instanceof Error ? error.message : String(error))
          failures.push(reason)
          // Also accepts gpu_fault when the shared classifier adds that code.
          if (code === 'gpu_fault' && this.failureCode !== 'out_of_memory')
            this.failureCode = 'gpu_fault'
          await this.closeProcess()
          this.assertWanted(generation)
        }
      }
      throw new Error(failures.join(' ') || `The bundled ${this.options.label} engine is missing.`)
    } catch (error) {
      this.assertWanted(generation)
      this.failure = error instanceof Error ? error.message : String(error)
      this.record.fail(this.failure)
      throw new Error(this.failure)
    }
  }

  private async closeProcess(): Promise<void> {
    const child = this.process
    this.process = null
    this.ready = false
    if (!child) return
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    if (child.exitCode != null || child.signalCode != null) {
      // Already exited: its streams close shortly (or closed before this listener was added).
      await Promise.race([closed, delay(1_000)])
      return
    }
    child.kill('SIGTERM')
    let timer: ReturnType<typeof setTimeout> | undefined
    const exited = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 1_000)
      })
    ])
    clearTimeout(timer)
    if (!exited) {
      child.kill('SIGKILL')
      await closed
    }
  }

  async stop(): Promise<void> {
    this.wanted = false
    this.generation += 1
    if (this.stopping) return this.stopping
    this.record?.stop()
    this.stopping = (async () => {
      await this.closeProcess()
      await this.pending?.catch(() => {})
      this.attempted = false
      this.healthyOnce = false
    })().finally(() => {
      this.stopping = null
    })
    return this.stopping
  }

  async restart(): Promise<void> {
    if (!this.wanted) return
    await this.stop()
    this.attempted = true
    await this.start()
  }
}
