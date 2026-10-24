import { promises as fs } from 'node:fs'
import { SUPPORT_EMAIL } from '../../shared/analytics'

/** The newest part of the diagnostic log a person can read and paste into an e-mail. */
export const REPORT_LOG_MAX_CHARS = 200_000

export interface ProblemLog {
  path: string
  text: string
  truncated: boolean
}

/**
 * Read the diagnostic log for "Report a problem". The log holds operational metadata only (see
 * diagnostics-log.ts), so the person can read every line before they send it.
 */
export async function readProblemLog(path: string): Promise<ProblemLog> {
  let text = ''
  try {
    text = await fs.readFile(path, 'utf8')
  } catch {
    return { path, text: '', truncated: false }
  }
  if (text.length <= REPORT_LOG_MAX_CHARS) return { path, text, truncated: false }
  const tail = text.slice(-REPORT_LOG_MAX_CHARS)
  // Start on a whole line.
  return { path, text: tail.slice(tail.indexOf('\n') + 1), truncated: true }
}

/**
 * A mailto link to support. A mailto link cannot attach a file, so the body asks the person to
 * paste the log they copied, and says which version they run.
 */
export function problemMailto(version: string, platform: string): string {
  const subject = `Off Grid AI Desktop ${version}: problem report`
  const body = [
    'What happened:',
    '',
    '',
    'What you expected:',
    '',
    '',
    `Version: ${version} (${platform})`,
    '',
    'Paste the log you copied from Off Grid AI below this line.',
    ''
  ].join('\n')
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
