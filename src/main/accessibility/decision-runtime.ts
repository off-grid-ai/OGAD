import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Mutex } from 'async-mutex'
import {
  buildDecisionPrompt,
  buildDecisionRequest,
  parseOptionDecision,
  type OptionDecision
} from '../llm'
import { postCompletionOnce } from '../llm/http-post'
import { buildLaunchArgs } from '../llm/settings-math'
import { engineSpawnEnv } from '../llm/spawn-env'
import { binRoots, exe } from '../runtime-env'
import { isPortFree, pickFreePort } from '../free-port'
import { reapOrphanProcessesOnPort } from '../kill-orphan-port'
import {
  KEV_4B_ID,
  resolveComputerUseModelArtifact,
  resolveKevRuntimeArtifact
} from '../models-manager'

const DECIDER_PORT = 8459
const DECIDER_CONTEXT_SIZE = 16_384

export interface DecisionRuntimeTiming {
  coldStartMs: number
  warmDecisionMs: number[]
}

export class DecisionRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: 'missing' | 'startup' | 'out_of_memory'
  ) {
    super(message)
    this.name = 'DecisionRuntimeError'
  }
}

export class DecisionRuntime {
  private process: ChildProcess | null = null
  private port = DECIDER_PORT
  private readonly mutex = new Mutex()
  private startPromise: Promise<void> | null = null
  private modelId: string | null = null
  private stderr = ''
  readonly timing: DecisionRuntimeTiming = { coldStartMs: 0, warmDecisionMs: [] }

  get activePort(): number {
    return this.port
  }

  get activeModelId(): string | null {
    return this.modelId
  }

  get running(): boolean {
    return this.process !== null && this.process.exitCode === null
  }

  async start(modelId: string): Promise<void> {
    if (this.running && this.modelId === modelId) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startInternal(modelId).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async startInternal(modelId: string): Promise<void> {
    await this.shutdown()
    if (modelId === KEV_4B_ID) return this.startKev()
    const artifact = await resolveComputerUseModelArtifact(modelId)
    if (!artifact)
      throw new DecisionRuntimeError('The selected Decision model is not installed.', 'missing')
    reapOrphanProcessesOnPort(
      DECIDER_PORT,
      (command) => /llama-server/i.test(command),
      'Decision llama-server'
    )
    const port = await pickFreePort(DECIDER_PORT, isPortFree, 20)
    if (port === null)
      throw new DecisionRuntimeError(
        'No private port is available for the Decision runtime.',
        'startup'
      )
    const serverPath = binRoots()
      .flatMap((root) => [
        path.join(root, 'llama', exe('llama-server')),
        path.join(root, 'llama-cpu', exe('llama-server')),
        path.join(root, exe('llama-server'))
      ])
      .find((candidate) => fs.existsSync(candidate))
    if (!serverPath)
      throw new DecisionRuntimeError('The bundled Decision engine is missing.', 'startup')
    this.port = port
    this.modelId = modelId
    this.stderr = ''
    const args = buildLaunchArgs({
      modelPath: artifact.primaryPath,
      mmProjPath: artifact.projectorPath ?? '',
      port,
      // Mapika Decider supports 32k tokens. Keep enough room for structured
      // Computer Use state without reserving the model's full context window.
      effectiveCtxSize: DECIDER_CONTEXT_SIZE,
      gpuLayers: 99,
      flashAttn: true,
      kvCacheType: 'q8_0',
      speculativeDecoding: 'off',
      threads: undefined,
      batchSize: 128
    })
    const startedAt = Date.now()
    const process = spawn(serverPath, args, {
      env: {
        ...globalThis.process.env,
        ...engineSpawnEnv({
          platform: globalThis.process.platform,
          binDir: path.dirname(serverPath),
          currentEnv: globalThis.process.env
        })
      },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    this.process = process
    process.stderr!.on('data', (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_384)
    })
    process.once('close', () => {
      if (this.process === process) this.process = null
    })
    try {
      await this.waitUntilReady(startedAt)
      this.timing.coldStartMs = Date.now() - startedAt
    } catch (error) {
      await this.shutdown()
      const outOfMemory = /out of memory|cannot allocate|metal.*alloc|cuda.*memory/i.test(
        this.stderr
      )
      throw new DecisionRuntimeError(
        error instanceof Error ? error.message : 'The Decision runtime did not start.',
        outOfMemory ? 'out_of_memory' : 'startup'
      )
    }
  }

  private async startKev(): Promise<void> {
    const artifact = resolveKevRuntimeArtifact()
    if (!artifact)
      throw new DecisionRuntimeError('The local Kev model or runtime is missing.', 'missing')
    const port = await pickFreePort(DECIDER_PORT, isPortFree, 20)
    if (port === null)
      throw new DecisionRuntimeError('No private port is available for Kev.', 'startup')
    this.port = port
    this.modelId = KEV_4B_ID
    this.stderr = ''
    const startedAt = Date.now()
    const process = spawn(
      artifact.python,
      [artifact.script, '--run', artifact.checkpoint, '--port', String(port)],
      {
        cwd: artifact.source,
        env: {
          ...globalThis.process.env,
          KEV_LOCAL_BASE: artifact.base,
          KEV_BACKEND: 'mlx',
          PYTHONPATH: [artifact.source, globalThis.process.env.PYTHONPATH]
            .filter(Boolean)
            .join(path.delimiter),
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          PYTHONUNBUFFERED: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    this.process = process
    for (const stream of [process.stdout, process.stderr]) {
      stream?.on('data', (chunk) => {
        this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_384)
      })
    }
    process.once('close', () => {
      if (this.process === process) this.process = null
    })
    try {
      await this.waitUntilReady(startedAt)
      this.timing.coldStartMs = Date.now() - startedAt
    } catch (error) {
      await this.shutdown()
      const outOfMemory = /out of memory|cannot allocate|metal.*alloc|cuda.*memory/i.test(
        this.stderr
      )
      throw new DecisionRuntimeError(
        error instanceof Error ? error.message : 'Kev did not start.',
        outOfMemory ? 'out_of_memory' : 'startup'
      )
    }
  }

  private async waitUntilReady(startedAt: number): Promise<void> {
    for (;;) {
      if (!this.running) throw new Error('The Decision runtime stopped during startup.')
      if (Date.now() - startedAt > 120_000)
        throw new Error('The Decision runtime timed out during startup.')
      try {
        const endpoint = this.modelId === KEV_4B_ID ? '/v1/models' : '/health'
        const response = await fetch(`http://127.0.0.1:${this.port}${endpoint}`)
        if (response.ok) return
      } catch {
        /* The server is still loading. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  async decide(
    context: string,
    question: string,
    options: readonly string[],
    signal?: AbortSignal
  ): Promise<OptionDecision> {
    if (!this.running)
      throw new DecisionRuntimeError('The Decision runtime is not running.', 'startup')
    return this.mutex.runExclusive(async () => {
      const startedAt = Date.now()
      if (this.modelId === KEV_4B_ID) {
        const response = await fetch(`http://127.0.0.1:${this.port}/v1/systemone`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'kev-latest',
            state: { context },
            questions: {
              decision: {
                type: 'choice',
                instructions: question,
                criteria: Object.fromEntries(options.map((option, index) => [`option_${index}`, option]))
              }
            }
          }),
          signal
        })
        if (!response.ok) throw new Error(`Kev decision failed (HTTP ${response.status}).`)
        const body = (await response.json()) as {
          answers?: { decision?: { choice?: string; probabilities?: Record<string, number> } }
        }
        const answer = body.answers?.decision
        const choice = options.findIndex((_, index) => answer?.choice === `option_${index}`)
        const probabilities = options.map((_, index) => answer?.probabilities?.[`option_${index}`])
        if (
          choice < 0 ||
          probabilities.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        ) {
          throw new Error('Kev returned an invalid Decision response.')
        }
        const total = probabilities.reduce<number>((sum, value) => sum + (value ?? 0), 0)
        if (total <= 0) throw new Error('Kev returned an empty Decision distribution.')
        const normalized = probabilities.map((value) => (value ?? 0) / total)
        this.timing.warmDecisionMs.push(Date.now() - startedAt)
        if (this.timing.warmDecisionMs.length > 200) this.timing.warmDecisionMs.shift()
        return { choice, confidence: normalized[choice] ?? 0, probabilities: normalized }
      }
      const prompt = buildDecisionPrompt(context, question, options)
      const body = JSON.stringify(buildDecisionRequest(prompt, options.length))
      const raw = await postCompletionOnce(this.port, body, undefined, signal, '/completion')
      this.timing.warmDecisionMs.push(Date.now() - startedAt)
      if (this.timing.warmDecisionMs.length > 200) this.timing.warmDecisionMs.shift()
      return parseOptionDecision(raw, options.length)
    })
  }

  async health(): Promise<boolean> {
    if (!this.running) return false
    try {
      const endpoint = this.modelId === KEV_4B_ID ? '/v1/models' : '/health'
      return (await fetch(`http://127.0.0.1:${this.port}${endpoint}`)).ok
    } catch {
      return false
    }
  }

  async shutdown(): Promise<void> {
    const process = this.process
    this.process = null
    this.modelId = null
    if (!process || process.exitCode !== null) return
    const closedPromise = new Promise<void>((resolve) => {
      process.once('close', () => resolve())
    })
    process.kill('SIGTERM')
    const closed = await Promise.race([
      closedPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000))
    ])
    if (!closed) {
      process.kill('SIGKILL')
      await closedPromise
    }
  }
}

export const decisionRuntime = new DecisionRuntime()
