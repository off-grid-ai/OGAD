import { beginRuntimeBackend, parseNativeBackend } from '../runtime-backends'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Mutex } from 'async-mutex'
import { prepareModelMemory, registerModelEvictor } from '../model-memory'
import type { RemoteTextModelConnection } from '../llm/remote-chat'
import { buildLaunchArgs } from '../llm/settings-math'
import { engineSpawnEnv } from '../llm/spawn-env'
import { selectLocalEngine } from '../llm/select-local-engine'
import { getBackendPreference } from '../backend-preferences'
import { isPortFree, pickFreePort } from '../free-port'
import { reapOrphanProcessesOnPort } from '../kill-orphan-port'
import { resolveComputerUseModelArtifact } from '../models-manager'
import { llm } from '../llm'
import { readGgufMtpSupport } from '../models/gguf-metadata'
import { MTP_COMPANIONS } from '../models/catalog-logic'

const GROUNDER_PORT = 8489

/** Dedicated local GUI-grounding runtime. It stays resident between delegated
 * grounding calls so the reasoning model never unloads or shares this server. */
export class GrounderRuntime {
  private process: ChildProcess | null = null
  private port = GROUNDER_PORT
  private modelId: string | null = null
  private stderr = ''
  private backendOutput = ''
  private backend: string | undefined
  private backendState?: ReturnType<typeof beginRuntimeBackend>
  private readonly mutex = new Mutex()
  private speculativeSettingsKey = ''

  get running(): boolean {
    return this.process !== null && this.process.exitCode === null
  }

  async connection(modelId: string): Promise<RemoteTextModelConnection> {
    await prepareModelMemory('grounding')
    await this.mutex.runExclusive(async () => {
      const settings = llm.getSettings()
      const speculativeSettingsKey = `${settings.speculativeDecoding}:${settings.speculativeDraftMax ?? 0}`
      if (!this.running || this.modelId !== modelId || this.speculativeSettingsKey !== speculativeSettingsKey)
        await this.start(modelId)
      this.backendState?.recordRequest()
    })
    return {
      id: `local-grounder:${modelId}`,
      name: 'Local grounding specialist',
      provider: 'custom',
      endpoint: `http://127.0.0.1:${this.port}/v1`,
      model: modelId,
      computeBackend: this.backend,
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
    const serverPath = await selectLocalEngine(getBackendPreference('grounding'))
    if (!serverPath) throw new Error('The bundled grounding engine is missing.')

    const settings = llm.getSettings()
    const companion = MTP_COMPANIONS['bartowski/tencent_UI-Mate-9B-GGUF+MTP']
    const companionPath = path.join(path.dirname(artifact.primaryPath), companion.name)
    const matchingCompanion = /^tencent_UI-Mate-9B-(?:Q|IQ)[A-Z0-9_]+(?:\+MTP)?\.gguf$/i.test(path.basename(artifact.primaryPath)) &&
      readGgufMtpSupport(companionPath, fs, undefined, companion.sizeBytes)
    const useMtp = settings.speculativeDecoding === 'mtp' &&
      (readGgufMtpSupport(artifact.primaryPath, fs) || matchingCompanion)
    this.speculativeSettingsKey = `${settings.speculativeDecoding}:${settings.speculativeDraftMax ?? 0}`

    this.port = port
    this.modelId = modelId
    this.stderr = ''
    this.backendOutput = ''
    this.backend = undefined
    const backendState = beginRuntimeBackend('grounding', this.modelId!)
    this.backendState = backendState
    const process = spawn(
      serverPath,
      buildLaunchArgs({
        modelPath: artifact.primaryPath,
        mmProjPath: artifact.projectorPath ?? '',
        port,
        effectiveCtxSize: 16_384,
        gpuLayers: getBackendPreference('grounding') === 'cpu' ? 0 : 99,
        flashAttn: true,
        kvCacheType: 'q8_0',
        speculativeDecoding: useMtp ? 'mtp' : 'off',
        speculativeDraftMax: settings.speculativeDraftMax,
        draftModelPath: useMtp && matchingCompanion ? companionPath : undefined,
        threads: undefined,
        batchSize: 1_024,
        imageMinTokens: 1_024,
        reportModelPlacement: true
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
    let loading = true
    process.stderr!.on('data', (chunk) => {
      if (loading) {
        const output = String(chunk)
        this.stderr = `${this.stderr}${output}`.slice(-16_384)
        this.backendOutput = `${this.backendOutput}${output}`.slice(-65_536)
        backendState.observe(output)
        console.log(`[Grounding runtime] ${output}`)
      }
    })
    process.once('close', () => {
      backendState.stop()
      if (this.process === process) this.process = null
    })

    try {
      await this.waitUntilReady()
      loading = false // Level 4 can contain request data after startup.
      this.backend = parseNativeBackend(this.backendOutput)?.backend
      backendState.ready(this.backend)
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

export const grounderRuntime = new GrounderRuntime()
registerModelEvictor('grounding', () => grounderRuntime.shutdown())
