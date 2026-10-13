// Detect this machine's processors and apply the fastest settings for every modality.
// The decision is planBestSettings (shared/best-settings.ts); this module only gathers the
// hardware facts and writes the chosen settings through each owner's own setter.

import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { llm } from './llm'
import { selectLocalEngine } from './llm/select-local-engine'
import { getBackendPreferences, setBackendPreference } from './backend-preferences'
import { getResidency, setResidencyMode } from './runtime-residency'
import { getSetting, saveSetting } from './database'
import { getComputerUseSettings, setComputerUseSettings } from './computer-use-settings'
import {
  bestSettingsFingerprint,
  matchesBestSettings,
  planBestSettings,
  type BestSettingsPlan,
  type CurrentSpeedSettings,
  type MachineProfile,
  type NativeGpu
} from '../shared/best-settings'
import type { BackendModality } from '../shared/backend-preferences'
import type { Modality } from '../shared/runtime-residency-types'

const execFileAsync = promisify(execFile)

async function applePerformanceCores(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('sysctl', ['-n', 'hw.perflevel0.physicalcpu'])
    const cores = Number(stdout.trim())
    return Number.isInteger(cores) && cores > 0 ? cores : null
  } catch {
    return null
  }
}

/** The GPU backend of the engine llama.cpp would load with, after its own device probe. */
async function nativeGpu(): Promise<NativeGpu | null> {
  if (process.platform === 'darwin') return 'Metal'
  const engine = await selectLocalEngine('auto')
  const directory = engine ? path.basename(path.dirname(engine)) : ''
  if (directory === 'llama-cuda') return 'CUDA'
  if (directory === 'llama') return 'Vulkan'
  return null
}

export async function detectMachine(): Promise<MachineProfile> {
  const cpus = os.cpus()
  const logical = os.availableParallelism()
  const performance = process.platform === 'darwin' ? await applePerformanceCores() : null
  return {
    platform: process.platform,
    cpuModel: (cpus[0]?.model ?? 'CPU').trim(),
    // Outside Apple, physical cores are about half the logical count on SMT processors.
    performanceCores: performance ?? Math.max(1, Math.floor(logical / 2)),
    totalRamGb: os.totalmem() / 1024 ** 3,
    gpu: await nativeGpu()
  }
}

export interface BestSettingsResult {
  machine: MachineProfile
  plan: BestSettingsPlan
}

/** 'auto': the app keeps speed settings at their best for this machine and model.
 *  'manual': the person chose their own, so the app leaves them alone. */
interface BestSettingsState {
  mode: 'auto' | 'manual'
  fingerprint?: string
}

const STATE_KEY = 'runtime:best-settings'
// Probing GPU engines takes seconds on Windows and Linux; the hardware does not change
// while the app runs, except when the CUDA pack installs (see forgetDetectedMachine).
let detected: Promise<MachineProfile> | null = null
let applying: Promise<BestSettingsResult> | null = null

function machineProfile(): Promise<MachineProfile> {
  detected ??= detectMachine().catch((error: unknown) => {
    detected = null
    throw error
  })
  return detected
}

/** A newly installed engine (the CUDA pack) changes which GPU llama.cpp can use. */
export function forgetDetectedMachine(): void {
  detected = null
}

function readState(): BestSettingsState | null {
  const value = getSetting<unknown>(STATE_KEY, null)
  if (!value || typeof value !== 'object') return null
  const state = value as Partial<BestSettingsState>
  return state.mode === 'auto' || state.mode === 'manual'
    ? {
        mode: state.mode,
        ...(typeof state.fingerprint === 'string' ? { fingerprint: state.fingerprint } : {})
      }
    : null
}

async function currentPlan(): Promise<BestSettingsResult & { fingerprint: string }> {
  const machine = await machineProfile()
  const current = llm.getSettings() as { supportsMtp?: boolean; modelMaxCtx?: number | null }
  const plan = planBestSettings(machine, {
    weightsGb: llm.localWeightsGb(),
    supportsMtp: current.supportsMtp === true,
    modelMaxCtx: current.modelMaxCtx ?? null
  })
  return { machine, plan, fingerprint: bestSettingsFingerprint(machine, llm.localModelFile()) }
}

async function apply(): Promise<BestSettingsResult> {
  const { machine, plan, fingerprint } = await currentPlan()
  for (const [modality, preference] of Object.entries(plan.backends)) {
    setBackendPreference(modality as BackendModality, preference)
  }
  for (const [modality, mode] of Object.entries(plan.residency)) {
    setResidencyMode(modality as Modality, mode)
  }
  setComputerUseSettings({ ...getComputerUseSettings(), screenshotSize: plan.screenshotSize })
  saveSetting(STATE_KEY, { mode: 'auto', fingerprint } satisfies BestSettingsState)
  // Last: a launch-setting change restarts the chat engine with the new backend too.
  await llm.setSettings(plan.chat)
  return { machine, plan }
}

/** "Use fastest settings": apply now and keep them current as hardware or model change. */
export function applyBestSettings(): Promise<BestSettingsResult> {
  applying ??= apply().finally(() => {
    applying = null
  })
  return applying
}

/** Whether the panel still needs to offer the fastest settings. */
export async function bestSettingsStatus(): Promise<{ applied: boolean }> {
  if (!llm.localModelFile()) return { applied: true }
  const { plan } = await currentPlan()
  const chat = llm.getSettings() as CurrentSpeedSettings['chat']
  return {
    applied: matchesBestSettings(plan, {
      chat,
      backends: getBackendPreferences(),
      residency: getResidency(),
      screenshotSize: getComputerUseSettings().screenshotSize
    })
  }
}

/** A setting the person changed by hand ends automatic management. */
export function markSpeedSettingsManual(): void {
  if (readState()?.mode === 'auto') saveSetting(STATE_KEY, { mode: 'manual' })
}

/** Keep auto-managed installs on the fastest settings after the hardware or model changes. */
export async function ensureBestSettings(): Promise<void> {
  const state = readState()
  if (state?.mode !== 'auto' || !llm.localModelFile()) return
  const { fingerprint } = await currentPlan()
  if (fingerprint !== state.fingerprint) await applyBestSettings()
}

/** A fresh install starts on the fastest settings; an existing one keeps its own. Earlier builds
 *  wrote llm-settings.json only when a chat setting was changed by hand, so a chat model already
 *  on disk also marks an existing install. */
export async function prepareBestSettingsOnStartup(): Promise<void> {
  if (!readState()) {
    saveSetting(STATE_KEY, {
      mode: llm.hasPersistedSettings() || llm.localModelFile() ? 'manual' : 'auto'
    } satisfies BestSettingsState)
  }
  await ensureBestSettings()
}
