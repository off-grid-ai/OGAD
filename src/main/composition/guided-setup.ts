import * as http from 'node:http'
import os from 'node:os'
import { CATALOG, normalizeGuidedSetupMode, type GuidedSetupHostPorts } from '@offgrid/models'
import { deviceNoun } from '../../shared/device'
import { llm } from '../llm'

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

/**
 * The device FACTS guided setup needs, and nothing else.
 *
 * This object is handed INTO the models facade, so anything it did with the facade was the facade's
 * own port calling back into the facade holding it - a second control plane over download,
 * activation and residency that only setup could reach. Install, select and make-resident now come
 * from the owners the facade already composes, so setup runs the SAME commands as every other
 * caller and inherits their admission and typed failures. What remains here is what only this host
 * can answer: its memory, the mode the user committed, what to call the device, and whether the
 * local server is answering.
 */
export function createDesktopGuidedSetupPorts(): GuidedSetupHostPorts {
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
    verifyChat: async () => Boolean(await pingLocalJson(llm.getPort(), '/health', 3000)),
    deviceLabel: () => deviceNoun(process.platform)
  }
}
