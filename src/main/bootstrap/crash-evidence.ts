// A native fault in the main process must leave evidence. Without a connected Crashpad handler,
// Windows ends the app with 0xFFFF7003 and writes nothing (OGAD#240). Dumps stay on this machine:
// nothing is uploaded.
import type { CrashReporter } from 'electron'
import type { NativeStepGuard } from '../native-step-guard'

export function startLocalCrashEvidence(
  reporter: Pick<CrashReporter, 'start'>,
  guard: Pick<NativeStepGuard, 'recoverInterrupted'>,
  crashDumpsDir: string,
  log: (message: string) => void = console.warn
): void {
  reporter.start({ uploadToServer: false, compress: true })
  for (const step of guard.recoverInterrupted()) {
    log(
      `[native-step] the last run ended inside "${step}"; it stays off until retried in Settings → Health. Crash dumps: ${crashDumpsDir}`
    )
  }
}
