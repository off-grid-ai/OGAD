import * as http from 'node:http'
import os from 'node:os'
import {
  CATALOG,
  normalizeGuidedSetupMode,
  type GuidedSetupPorts
} from '@offgrid/models'
import { deviceNoun } from '../../shared/device'
import { llm } from '../llm'
import {
  downloadModel,
  listInstalled,
  setActiveModalChoice,
  setActiveModel
} from '../models-manager'

export function desktopRamGb(): number {
  return Math.round(os.totalmem() / 1e9)
}

export function pingLocalJson(port: number, path = '/health', timeoutMs = 1500): Promise<unknown | null> {
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
    startChat: () => llm.restart(),
    verifyChat: async () => Boolean(await pingLocalJson(llm.getPort(), '/health', 3000)),
    deviceLabel: () => deviceNoun(process.platform)
  }
}
