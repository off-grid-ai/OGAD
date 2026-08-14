/**
 * The Windows semantic rail (R1 box 17) - local-first, like the mac rail.
 *
 * Calendar, reminders (tasks), and mail go through LOCAL Outlook COM
 * automation via PowerShell: the write lands in Outlook's local store and
 * syncs when the network returns, matching the macOS EventKit/Mail
 * behaviour instead of failing offline the way a cloud API would. open goes
 * through the injected opener (Electron's shell at wiring time). iMessage
 * has no Windows equivalent - message is refused honestly, macOS-only in R1.
 *
 * The scripts print ONE compact JSON line ({ok, result|error}) - the exact
 * contract the mac helper speaks - so parseHelperResponse is shared, not
 * duplicated. Pure module: the PowerShell runner, the opener, and the
 * optional Graph fallback port are injected; nothing here touches Electron.
 *
 * Graph (online-only, the user's own sign-in) is the fallback for setups
 * without local Outlook. R1 ships the PORT and the fallback logic,
 * boundary-tested; the OAuth wiring lands with the fast-follow, so
 * production passes no Graph port yet and the failure stays honest.
 */
import type { ActionRecord } from '@offgrid/use'
import type { NativeActionResponse } from './native-helper-logic'

export type RunPowerShell = (script: string) => Promise<NativeActionResponse>

export interface GraphPort {
  /** True only when the user has signed in and the network is reachable. */
  available(): boolean
  createEvent(args: Record<string, unknown>): Promise<NativeActionResponse>
  createTask(args: Record<string, unknown>): Promise<NativeActionResponse>
  sendMail(args: Record<string, unknown>): Promise<NativeActionResponse>
}

export interface WindowsRailDeps {
  runPs: RunPowerShell
  openUrl: (url: string) => Promise<NativeActionResponse>
  graph?: GraphPort
}

export interface WinExecuteResult {
  ok: boolean
  detail?: string
}

/** Single-quote a value for PowerShell: embedded quotes double, newlines stay. */
export function psQuote(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

const RESULT_TAIL = `| ConvertTo-Json -Compress`
const CATCH = `} catch { @{ ok = $false; error = $_.Exception.Message } ${RESULT_TAIL} }`

/**
 * The COM scripts. Outlook item types: 0 = MailItem, 1 = AppointmentItem,
 * 3 = TaskItem. Each script is self-contained and reports the one JSON line.
 */
export function buildOutlookScript(
  type: 'calendar' | 'reminder' | 'email',
  args: Record<string, unknown>
): string {
  if (type === 'calendar') {
    const lines = [
      `try {`,
      `$o = New-Object -ComObject Outlook.Application`,
      `$i = $o.CreateItem(1)`,
      `$i.Subject = ${psQuote(args.title)}`,
      `$i.Start = [datetime]${psQuote(args.start)}`,
      args.end ? `$i.End = [datetime]${psQuote(args.end)}` : `$i.End = $i.Start.AddHours(1)`,
      args.notes ? `$i.Body = ${psQuote(args.notes)}` : '',
      `$i.Save()`,
      `@{ ok = $true; result = @{ id = $i.EntryID } } ${RESULT_TAIL}`,
      CATCH
    ]
    return lines.filter(Boolean).join('\n')
  }
  if (type === 'reminder') {
    const lines = [
      `try {`,
      `$o = New-Object -ComObject Outlook.Application`,
      `$i = $o.CreateItem(3)`,
      `$i.Subject = ${psQuote(args.title)}`,
      args.due ? `$i.DueDate = [datetime]${psQuote(args.due)}` : '',
      args.notes ? `$i.Body = ${psQuote(args.notes)}` : '',
      `$i.Save()`,
      `@{ ok = $true; result = @{ id = $i.EntryID } } ${RESULT_TAIL}`,
      CATCH
    ]
    return lines.filter(Boolean).join('\n')
  }
  const lines = [
    `try {`,
    `$o = New-Object -ComObject Outlook.Application`,
    `$i = $o.CreateItem(0)`,
    `$i.To = ${psQuote(args.to)}`,
    `$i.Subject = ${psQuote(args.subject)}`,
    `$i.Body = ${psQuote(args.body)}`,
    `$i.Send()`,
    `@{ ok = $true; result = @{ queued = $true } } ${RESULT_TAIL}`,
    CATCH
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * The win32 INLINE runner (R2-A2) - the Windows counterpart of the mac
 * helper for the non-engine path. Only navigation exists inline on Windows
 * (open_url); every other verb refuses honestly so nothing silently
 * pretends to be the Swift helper.
 */
export function makeWinInlineRunner(
  openExternal: (url: string) => Promise<void>
): (cmd: { command: string; args: Record<string, unknown> }) => Promise<NativeActionResponse> {
  return async (cmd) => {
    if (cmd.command === 'system.openURL') {
      try {
        await openExternal(String(cmd.args.url ?? ''))
        return { ok: true, result: {} }
      } catch (error) {
        return { ok: false, error: `could not open the link: ${(error as Error).message}` }
      }
    }
    return { ok: false, error: `'${cmd.command}' is not available on Windows` }
  }
}

/** COM error shapes that mean "Outlook is not installed / not registered". */
export function isOutlookUnavailable(error: string): boolean {
  return /80040154|REGDB_E_CLASSNOTREG|Outlook\.Application|cannot create.*COM/i.test(error)
}

const GRAPH_BY_TYPE = {
  calendar: 'createEvent',
  reminder: 'createTask',
  email: 'sendMail'
} as const

/** One attempt on the Windows semantic rail. Never throws. */
export function makeWindowsSemanticRailExecutor(deps: WindowsRailDeps) {
  return async (action: ActionRecord): Promise<WinExecuteResult> => {
    try {
      if (action.type === 'open') {
        const res = await deps.openUrl(String(action.args.url ?? ''))
        return res.ok ? { ok: true } : { ok: false, detail: res.error }
      }
      if (action.type === 'message') {
        return {
          ok: false,
          detail: 'iMessage is macOS-only; there is no Windows message rail in this release'
        }
      }
      if (action.type !== 'calendar' && action.type !== 'reminder' && action.type !== 'email') {
        return { ok: false, detail: `the Windows semantic rail has no mapping for '${action.type}'` }
      }

      const local = await deps.runPs(buildOutlookScript(action.type, action.args))
      if (local.ok) {
        return { ok: true }
      }
      if (isOutlookUnavailable(local.error) && deps.graph?.available()) {
        // Online-only fallback, on the user's own sign-in - labeled so.
        const remote = await deps.graph[GRAPH_BY_TYPE[action.type]](action.args)
        return remote.ok
          ? { ok: true }
          : { ok: false, detail: `Microsoft Graph (online) failed: ${remote.error}` }
      }
      if (isOutlookUnavailable(local.error)) {
        return {
          ok: false,
          detail:
            'local Outlook is not available on this PC, and the online Microsoft fallback is not set up'
        }
      }
      return { ok: false, detail: local.error }
    } catch (error) {
      return { ok: false, detail: `windows semantic rail failed: ${(error as Error).message}` }
    }
  }
}
