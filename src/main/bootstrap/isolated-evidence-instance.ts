import { isAbsolute, relative } from 'node:path'

export function mayUseIsolatedEvidenceInstance(
  env: NodeJS.ProcessEnv,
  temporaryRoot: string
): boolean {
  const profile = env.OFFGRID_USER_DATA
  if (env.OFFGRID_E2E_ISOLATED_INSTANCE !== '1' || !profile) return false
  const fromTemporaryRoot = relative(temporaryRoot, profile)
  return (
    fromTemporaryRoot !== '' &&
    fromTemporaryRoot !== '..' &&
    !fromTemporaryRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(fromTemporaryRoot)
  )
}
