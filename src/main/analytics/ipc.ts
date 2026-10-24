import { app, shell, type IpcMain } from 'electron'
import { ANALYTICS_CHANNELS } from '../../shared/analytics'
import { diagnosticLogPath, flushDiagnosticLog } from '../diagnostics-log'
import { platformOf } from './properties'
import { problemMailto, readProblemLog } from './report-problem'
import { isOptInSource, type AnalyticsService } from './service'

/**
 * The renderer's analytics bridge. Consent is read synchronously so the renderer knows it before
 * the first paint. Every report is validated by the service before anything is sent.
 */
export function registerAnalyticsIpc(
  ipc: Pick<IpcMain, 'on' | 'handle'>,
  owner: () => AnalyticsService
): void {
  ipc.on(ANALYTICS_CHANNELS.consentSync, (event) => {
    event.returnValue = owner().consent()
  })
  ipc.handle(ANALYTICS_CHANNELS.setConsent, (_event, patch: unknown) => {
    const value = (patch && typeof patch === 'object' ? patch : {}) as {
      usage?: unknown
      crashes?: unknown
    }
    return owner().setConsent(
      {
        ...(typeof value.usage === 'boolean' ? { usage: value.usage } : {}),
        ...(typeof value.crashes === 'boolean' ? { crashes: value.crashes } : {})
      },
      'settings'
    )
  })
  ipc.handle(ANALYTICS_CHANNELS.optIn, (_event, source: unknown) =>
    isOptInSource(source) ? owner().optIn(source) : owner().consent()
  )
  ipc.handle(ANALYTICS_CHANNELS.dismissPrompt, () => owner().dismissPrompt())
  ipc.on(ANALYTICS_CHANNELS.capture, (_event, name: unknown, properties: unknown) =>
    owner().captureFromRenderer(name, properties)
  )
  ipc.on(ANALYTICS_CHANNELS.flow, (_event, report: unknown) => owner().flow(report))
  ipc.on(ANALYTICS_CHANNELS.rendererError, (_event, report: unknown) =>
    owner().captureRendererError(report)
  )

  // Report a problem works whether or not analytics is on.
  ipc.handle(ANALYTICS_CHANNELS.readLog, async () => {
    await flushDiagnosticLog(1_000).catch(() => {})
    return readProblemLog(diagnosticLogPath())
  })
  ipc.handle(ANALYTICS_CHANNELS.emailLog, async () => {
    owner().capture('problem_reported')
    await shell.openExternal(problemMailto(app.getVersion(), platformOf(process.platform)))
    return true
  })
  ipc.handle(ANALYTICS_CHANNELS.revealLog, async () => {
    await flushDiagnosticLog(1_000).catch(() => {})
    shell.showItemInFolder(diagnosticLogPath())
    return true
  })
}
