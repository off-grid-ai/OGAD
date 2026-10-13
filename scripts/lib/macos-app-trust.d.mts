export interface CodeSignatureDetails {
  authorities: string[]
  flags: string
  signature: string | null
  teamIdentifier: string | null
}

export const OFFGRID_APPLE_TEAM_ID: string
export const CRITICAL_SIGNED_CODE: readonly string[]

export interface MacAppTrustBoundary {
  execFile(
    executable: string,
    args: readonly string[]
  ): Promise<{ stdout?: string | null; stderr?: string | null }>
  readFuses(bundle: string): Promise<Record<number, number>>
  /** Pause between retries of Apple's ticket service. Defaults to a real timer. */
  wait?(ms: number): Promise<void>
}

export function runTrustCommand(
  executable: string,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }>
export function releaseTeamIdForEnvironment(
  environment: Record<string, string | undefined>
): string | null
export function parseCodeSignatureDetails(output: string): CodeSignatureDetails
export function assertReleaseSignature(details: CodeSignatureDetails, expectedTeamId: string): void
export function assertAsarProtectionFuses(fuseWire: Record<number, number>): void
export function assertGatekeeperAssessment(output: string): void
export function verifyStrictAppTrust(bundle: string, boundary?: MacAppTrustBoundary): Promise<void>
export function verifyReleaseAppTrust(
  bundle: string,
  expectedTeamId: string,
  boundary?: MacAppTrustBoundary
): Promise<CodeSignatureDetails>
