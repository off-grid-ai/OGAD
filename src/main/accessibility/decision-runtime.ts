import { DedicatedLlamaRuntime } from '../llm/dedicated-llama-runtime'
import { getBackendPreference } from '../backend-preferences'
import { beginRuntimeBackend } from '../runtime-backends'
import { spawn, type ChildProcess } from 'node:child_process'
import { currentAIRequest } from '../ai-request-log'
import { Mutex } from 'async-mutex'
import { prepareModelMemory, registerModelEvictor } from '../model-memory'
import {
  buildDecisionPrompt,
  buildDecisionRequest,
  parseOptionDecision,
  type OptionDecision
} from '../llm'
import { postCompletionOnce } from '../llm/http-post'
import { isPortFree, pickFreePort } from '../free-port'
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
  memoryEvicted = false
  private process: ChildProcess | null = null
  private port = DECIDER_PORT
  private readonly mutex = new Mutex()
  private startPromise: Promise<void> | null = null
  private modelId: string | null = null
  private stderr = ''
  private backend: string | undefined
  private backendState?: ReturnType<typeof beginRuntimeBackend>
  private readonly runtime = new DedicatedLlamaRuntime({
    id: 'decision',
    label: 'Decision',
    modality: 'decision',
    port: DECIDER_PORT,
    readyTimeoutMs: 120_000,
    modelPaths: async () => {
      const artifact = await resolveComputerUseModelArtifact(this.modelId!)
      if (!artifact)
        throw new DecisionRuntimeError('The selected Decision model is not installed.', 'missing')
      return {
        model: this.modelId!,
        modelPath: artifact.primaryPath,
        mmProjPath: artifact.projectorPath ?? ''
      }
    },
    extraArgs: () => ({
      effectiveCtxSize: DECIDER_CONTEXT_SIZE,
      flashAttn: true,
      kvCacheType: 'q8_0',
      speculativeDecoding: 'off',
      threads: undefined,
      batchSize: 128,
      reportModelPlacement: true
    })
  })
  readonly timing: DecisionRuntimeTiming = { coldStartMs: 0, warmDecisionMs: [] }

  get activePort(): number {
    return this.modelId === KEV_4B_ID ? this.port : this.runtime.port
  }

  get activeModelId(): string | null {
    return this.modelId
  }

  get running(): boolean {
    return this.modelId === KEV_4B_ID
      ? this.process !== null && this.process.exitCode === null
      : this.runtime.isRunning
  }

  async start(modelId: string): Promise<void> {
    if (this.running && this.modelId === modelId) return
    if (this.startPromise !== null) return this.startPromise
    this.startPromise = this.startInternal(modelId).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async startInternal(modelId: string): Promise<void> {
    await prepareModelMemory('decision')
    this.memoryEvicted = false
    if (this.modelId === modelId && modelId !== KEV_4B_ID) {
      await this.startDedicated()
      return
    }
    await this.shutdown()
    if (modelId === KEV_4B_ID) return this.startKev()
    this.modelId = modelId
    await this.startDedicated()
  }

  private async startDedicated(): Promise<void> {
    const startedAt = Date.now()
    try {
      await this.runtime.start()
      this.timing.coldStartMs = Date.now() - startedAt
    } catch (error) {
      if (error instanceof DecisionRuntimeError) throw error
      throw new DecisionRuntimeError(
        error instanceof Error ? error.message : 'The Decision runtime did not start.',
        this.runtime.failureCode === 'out_of_memory' ? 'out_of_memory' : 'startup'
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
    this.backend = undefined
    const backendState = beginRuntimeBackend('decision', this.modelId!)
    this.backendState = backendState
    const startedAt = Date.now()
    const process = spawn(
      artifact.python,
      [artifact.script, '--run', artifact.checkpoint, '--port', String(port)],
      {
        cwd: artifact.checkpoint,
        env: {
          ...globalThis.process.env,
          KEV_LOCAL_BASE: artifact.base,
          KEV_BACKEND: globalThis.process.platform === 'darwin' ? 'auto' : 'torch',
          OFFGRID_KEV_DEVICE: getBackendPreference('decision'),
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          PYTHONUNBUFFERED: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    this.process = process
    for (const stream of [process.stdout, process.stderr]) {
      stream.on('data', (chunk) => {
        this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_384)
        const device = /\[Kev\] loaded: device=(cuda|mps|cpu)\b/.exec(this.stderr)?.[1]
        if (device) {
          this.backend = device === 'cuda' ? 'CUDA' : device === 'mps' ? 'Metal' : 'CPU'
          backendState.ready(this.backend)
        }
        console.log(`[Kev runtime] ${String(chunk)}`)
      })
    }
    process.once('close', () => {
      backendState.stop()
      if (this.process === process) this.process = null
    })
    try {
      await this.waitUntilReady(startedAt)
      backendState.ready(this.backend)
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
      if (this.modelId === KEV_4B_ID) this.backendState?.recordRequest()
      else this.runtime.recordRequest()
      const startedAt = Date.now()
      currentAIRequest()?.update({
        model: this.modelId ?? undefined,
        backend: (this.modelId === KEV_4B_ID ? this.backend : this.runtime.backend) ?? 'Unknown',
        effectiveRequest: { context, question, options }
      })
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
                criteria: Object.fromEntries(
                  options.map((option, index) => [`option_${index}`, option])
                )
              }
            }
          }),
          signal
        })
        if (!response.ok) throw new Error(`Kev decision failed (HTTP ${response.status}).`)
        const body = (await response.json()) as {
          answers?: { decision?: { choice?: string; probabilities?: Record<string, number> } }
        }
        currentAIRequest()?.update({ response: body })
        const answer = body.answers?.decision
        const choice = options.findIndex((_, index) => answer?.choice === `option_${index}`)
        const probabilities = options.map((_, index) => answer?.probabilities?.[`option_${index}`])
        if (
          choice < 0 ||
          probabilities.some(
            (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0
          )
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
      const raw = await postCompletionOnce(this.activePort, body, undefined, signal, '/completion')
      currentAIRequest()?.update({ effectiveRequest: JSON.parse(body), response: JSON.parse(raw) })
      this.timing.warmDecisionMs.push(Date.now() - startedAt)
      if (this.timing.warmDecisionMs.length > 200) this.timing.warmDecisionMs.shift()
      return parseOptionDecision(raw, options.length)
    })
  }

  async health(): Promise<boolean> {
    if (this.modelId !== KEV_4B_ID) return this.runtime.health()
    if (!this.running) return false
    try {
      return (await fetch(`http://127.0.0.1:${this.port}/v1/models`)).ok
    } catch {
      return false
    }
  }

  shouldBeRunning(): boolean {
    return this.modelId === KEV_4B_ID ? this.running : this.runtime.shouldBeRunning()
  }

  async restart(): Promise<void> {
    if (this.modelId === KEV_4B_ID) {
      await this.shutdown()
      await this.start(KEV_4B_ID)
      return
    }
    await this.runtime.restart()
  }

  async shutdown(): Promise<void> {
    await this.runtime.stop()
    this.backendState?.stop()
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
registerModelEvictor('decision', async () => {
  if (decisionRuntime.running || decisionRuntime.shouldBeRunning()) {
    decisionRuntime.memoryEvicted = true
    await decisionRuntime.shutdown()
  }
})
