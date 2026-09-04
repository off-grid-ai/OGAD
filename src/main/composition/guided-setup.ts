import * as http from 'node:http'
import os from 'node:os'
import { CATALOG, normalizeGuidedSetupMode, type GuidedSetupPorts } from '@offgrid/models'
import { deviceNoun } from '../../shared/device'
import { llm } from '../llm'
import { DesktopModelsOperationError, desktopModels } from './application-access'
import {
  downloadModel,
  listInstalled,
  setActiveModalChoice,
  setActiveModel
} from '../models-manager'

export function desktopRamGb(): number {
  return Math.round(os.totalmem() / 1e9)
}

export function pingLocalJson(
  port: number,
  path = '/health',
  timeoutMs = 1500
): Promise<unknown | null> {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (response) => {
      if (!response.statusCode || response.statusCode >= 400) {
        response.resume()
        resolve(null)
        return
      }
      let body = ''
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(body ? {} : null)
        }
      })
    })
    request.on('error', () => resolve(null))
    request.on('timeout', () => {
      request.destroy()
      resolve(null)
    })
  })
}

export function createDesktopGuidedSetupPorts(): GuidedSetupPorts {
  return {
    catalog: CATALOG,
    totalRamGb: desktopRamGb,
    loadMode: () => {
      try {
        return normalizeGuidedSetupMode(
          (llm.getSettings() as { performanceMode?: string }).performanceMode
        )
      } catch {
        return 'balanced'
      }
    },
    listInstalled,
    downloadModel,
    activateChat: setActiveModel,
    activateModality: async (kind, modelId) => {
      const selected = await setActiveModalChoice(kind, modelId)
      if (!selected.success) throw new Error(selected.error ?? `Could not activate ${kind}`)
    },
    /**
     * "Starting the local model server" is a LOAD, not a restart.
     *
     * This runs immediately after `activateChat` has selected the model the user just downloaded, so
     * what the step means is "make the chat model resident". It used to call `llm.restart()`, which
     * respawns llama-server and reloads the model with no admission - residency was left holding a
     * stale view of what occupies memory, which is the state that lets the NEXT model be admitted
     * into memory nobody accounted for. `prepare` is the same intent expressed as a request: the
     * facade asks the residency manager, the manager admits it against the budget and then invokes
     * the native adapter. Idempotent by contract, which matters because setup can be re-run.
     *
     * A restart of an ALREADY-RESIDENT model is a genuinely different operation - same model, same
     * memory, fresh process - and re-entering admission for memory it already holds could refuse
     * itself. That case is the `system:restart` command, not this step, and it needs the manager to
     * understand a restart as distinct rather than as a fresh admission.
     */
    startChat: async () => {
      const prepared = await desktopModels.prepare('text')
      if (!prepared.ok) throw new DesktopModelsOperationError(prepared.failure)
    },
    verifyChat: async () => Boolean(await pingLocalJson(llm.getPort(), '/health', 3000)),
    deviceLabel: () => deviceNoun(process.platform)
  }
}
