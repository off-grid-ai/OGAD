import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { Mutex } from 'async-mutex'
import type { RemoteTextModelConnection } from '../llm/remote-chat'
import { buildLaunchArgs } from '../llm/settings-math'
import { engineSpawnEnv } from '../llm/spawn-env'
import { selectLocalEngine } from '../llm/select-local-engine'
import { isPortFree, pickFreePort } from '../free-port'
import { reapOrphanProcessesOnPort } from '../kill-orphan-port'
import { resolveComputerUseModelArtifact } from '../models-manager'

const GROUNDER_PORT = 8489

/** Dedicated local GUI-grounding runtime. It stays resident between delegated
 * grounding calls so the reasoning model never unloads or shares this server. */
export class GrounderRuntime {
  private process: ChildProcess | null = null
  private port = GROUNDER_PORT
  private modelId: string | null = null
  private stderr = ''
  private readonly mutex = new Mutex()

  get running(): boolean {
    return this.process !== null && this.process.exitCode === null
  }

  async connection(modelId: string): Promise<RemoteTextModelConnection> {
    await this.mutex.runExclusive(async () => {
      if (!this.running || this.modelId !== modelId) await this.start(modelId)
    })
    return {
      id: `local-grounder:${modelId}`,
      name: 'Local grounding specialist',
      provider: 'custom',
      endpoint: `http://127.0.0.1:${this.port}/v1`,
      model: modelId,
      apiKey: ''
    }
  }

  private async start(modelId: string): Promise<void> {
    await this.shutdown()
    const artifact = await resolveComputerUseModelArtifact(modelId)
    if (!artifact) throw new Error('The selected grounding model is not installed.')
    reapOrphanProcessesOnPort(
      GROUNDER_PORT,
      (command) => /llama-server/i.test(command),
      'Grounding llama-server'
    )
    const port = await pickFreePort(GROUNDER_PORT, isPortFree, 20)
    if (port === null) throw new Error('No private port is available for the grounding runtime.')
    const serverPath = await selectLocalEngine()
    if (!serverPath) throw new Error('The bundled grounding engine is missing.')

    this.port = port
    this.modelId = modelId
    this.stderr = ''
    const process = spawn(
      serverPath,
      buildLaunchArgs({
        modelPath: artifact.primaryPath,
        mmProjPath: artifact.projectorPath ?? '',
        port,
        effectiveCtxSize: 16_384,
        gpuLayers: 99,
        flashAttn: true,
        kvCacheType: 'q8_0',
        speculativeDecoding: 'off',
        threads: undefined,
        batchSize: 1_024,
        imageMinTokens: 1_024
      }),
      {
        env: {
          ...globalThis.process.env,
          ...engineSpawnEnv({
            platform: globalThis.process.platform,
            binDir: path.dirname(serverPath),
            currentEnv: globalThis.process.env
          })
        },
        stdio: ['ignore', 'ignore', 'pipe']
      }
    )
    this.process = process
    process.stderr!.on('data', (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_384)
      console.log(`[Grounding runtime] ${String(chunk)}`)
    })
    process.once('close', () => {
      if (this.process === process) this.process = null
    })

    try {
      await this.waitUntilReady()
    } catch (error) {
      await this.shutdown()
      const detail = /out of memory|cannot allocate|metal.*alloc/i.test(this.stderr)
        ? ' The device does not have enough free memory.'
        : ''
      throw new Error(
        `${error instanceof Error ? error.message : 'The grounding runtime did not start.'}${detail}`
      )
    }
  }

  private async waitUntilReady(): Promise<void> {
    for (;;) {
      if (!this.running) throw new Error('The grounding runtime stopped during startup.')
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`)
        if (response.ok) return
      } catch {
        /* The server is still loading. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
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

export const grounderRuntime = new GrounderRuntime()
