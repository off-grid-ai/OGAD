import fs from 'node:fs'
import path from 'node:path'
import { Mutex } from 'async-mutex'
import { prepareModelMemory, registerModelEvictor } from '../model-memory'
import type { RemoteTextModelConnection } from '../llm/remote-chat'
import { resolveComputerUseModelArtifact } from '../models-manager'
import { llm } from '../llm'
import { readGgufMtpSupport } from '../models/gguf-metadata'
import { MTP_COMPANIONS } from '../models/catalog-logic'
import { DedicatedLlamaRuntime } from '../llm/dedicated-llama-runtime'

const GROUNDER_PORT = 8489

/** Dedicated local GUI-grounding runtime, resident between delegated calls. */
export class GrounderRuntime {
  private modelId: string | null = null
  private readonly mutex = new Mutex()
  private speculativeSettingsKey = ''
  private readonly runtime = new DedicatedLlamaRuntime({
    id: 'grounding',
    label: 'Grounding',
    modality: 'grounding',
    port: GROUNDER_PORT,
    modelPaths: async () => {
      const artifact = await resolveComputerUseModelArtifact(this.modelId!)
      if (!artifact) throw new Error('The selected grounding model is not installed.')
      return {
        model: this.modelId!,
        modelPath: artifact.primaryPath,
        mmProjPath: artifact.projectorPath ?? ''
      }
    },
    extraArgs: () => this.launchSettings
  })
  private launchSettings: Omit<
    Parameters<typeof import('../llm/settings-math').buildLaunchArgs>[0],
    'modelPath' | 'mmProjPath' | 'port' | 'cpuOnly'
  > = {
    effectiveCtxSize: 16_384,
    flashAttn: true,
    kvCacheType: 'q8_0',
    speculativeDecoding: 'off',
    threads: undefined,
    batchSize: 1_024
  }

  get running(): boolean {
    return this.runtime.isRunning
  }
  health(): Promise<boolean> {
    return this.runtime.health()
  }
  restart(): Promise<void> {
    return this.runtime.restart()
  }
  shouldBeRunning(): boolean {
    return this.runtime.shouldBeRunning()
  }

  async connection(modelId: string): Promise<RemoteTextModelConnection> {
    await prepareModelMemory('grounding')
    await this.mutex.runExclusive(async () => {
      const settings = llm.getSettings()
      const speculativeSettingsKey = `${settings.speculativeDecoding}:${settings.speculativeDraftMax ?? 0}`
      if (
        !this.running ||
        this.modelId !== modelId ||
        this.speculativeSettingsKey !== speculativeSettingsKey
      )
        await this.start(modelId)
      this.runtime.recordRequest()
    })
    return {
      id: `local-grounder:${modelId}`,
      name: 'Local grounding specialist',
      provider: 'custom',
      endpoint: `http://127.0.0.1:${this.runtime.port}/v1`,
      model: modelId,
      computeBackend: this.runtime.backend,
      apiKey: ''
    }
  }

  private async start(modelId: string): Promise<void> {
    const settingsKey = `${llm.getSettings().speculativeDecoding}:${llm.getSettings().speculativeDraftMax ?? 0}`
    if (this.modelId === modelId && this.speculativeSettingsKey === settingsKey) {
      await this.runtime.start()
      return
    }
    await this.shutdown()
    const artifact = await resolveComputerUseModelArtifact(modelId)
    if (!artifact) throw new Error('The selected grounding model is not installed.')
    const settings = llm.getSettings()
    const companion = MTP_COMPANIONS['bartowski/tencent_UI-Mate-9B-GGUF+MTP']
    const companionPath = path.join(path.dirname(artifact.primaryPath), companion.name)
    const matchingCompanion =
      /^tencent_UI-Mate-9B-(?:Q|IQ)[A-Z0-9_]+(?:\+MTP)?\.gguf$/i.test(
        path.basename(artifact.primaryPath)
      ) && readGgufMtpSupport(companionPath, fs, undefined, companion.sizeBytes)
    const useMtp =
      settings.speculativeDecoding === 'mtp' &&
      (readGgufMtpSupport(artifact.primaryPath, fs) || matchingCompanion)
    this.speculativeSettingsKey = `${settings.speculativeDecoding}:${settings.speculativeDraftMax ?? 0}`

    this.modelId = modelId
    this.launchSettings = {
      effectiveCtxSize: 16_384,
      flashAttn: true,
      kvCacheType: 'q8_0',
      speculativeDecoding: useMtp ? 'mtp' : 'off',
      speculativeDraftMax: settings.speculativeDraftMax,
      draftModelPath: useMtp && matchingCompanion ? companionPath : undefined,
      threads: undefined,
      batchSize: 1_024,
      imageMinTokens: 1_024,
      reportModelPlacement: true
    }
    await this.runtime.start()
  }

  async shutdown(): Promise<void> {
    await this.runtime.stop()
    this.modelId = null
  }
}

export const grounderRuntime = new GrounderRuntime()
registerModelEvictor('grounding', () => grounderRuntime.shutdown())
