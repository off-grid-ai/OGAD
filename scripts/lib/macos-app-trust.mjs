/* eslint-disable @typescript-eslint/explicit-function-return-type -- Executed directly by Node during packaging; declarations live beside this file. */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import electronFuses from '@electron/fuses'

const rawExecFileAsync = promisify(execFile)
const execFileAsync = (executable, args) =>
  rawExecFileAsync(executable, args, { timeout: 120_000, killSignal: 'SIGKILL' })
const ENABLED_FUSE_STATE = '1'.charCodeAt(0)
const RELEASE_TRUST_ENV = 'OFFGRID_REQUIRE_RELEASE_TRUST'
const LOCAL_ARTIFACT_ENV = 'OFFGRID_ALLOW_LOCAL_ARTIFACT'
export const OFFGRID_APPLE_TEAM_ID = '84V6KCAC49'
export const CRITICAL_SIGNED_CODE = Object.freeze([
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
  'Contents/Resources/bin/llama/llama-server',
  'Contents/Resources/bin/meeting-recorder',
  'Contents/Resources/bin/computer-use-capture',
  'Contents/Resources/bin/dictation-hotkey'
])

const systemBoundary = Object.freeze({
  execFile: execFileAsync,
  readFuses: electronFuses.getCurrentFuseWire
})

function commandOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

export function releaseTeamIdForEnvironment(environment) {
  const releaseCredentialsPresent = Boolean(
    environment.CSC_LINK ||
    environment.CSC_NAME ||
    environment.APPLE_API_KEY ||
    environment.APPLE_ID ||
    environment.APPLE_KEYCHAIN_PROFILE
  )
  const publishContextPresent = Boolean(
    environment.GH_TOKEN ||
    environment.GITHUB_TOKEN ||
    environment.GITHUB_ACTIONS === 'true' ||
    environment.CI === 'true'
  )
  const localArtifactAllowed = environment[LOCAL_ARTIFACT_ENV] === '1'

  if (localArtifactAllowed) {
    if (
      environment[RELEASE_TRUST_ENV] === '1' ||
      releaseCredentialsPresent ||
      publishContextPresent
    ) {
      throw new Error('Local ad-hoc artifacts are forbidden in a release or publish context')
    }
    if (environment.OFFGRID_LOCAL_PUBLISH_POLICY !== 'never') {
      throw new Error('Local ad-hoc artifacts require OFFGRID_LOCAL_PUBLISH_POLICY=never')
    }
    return null
  }

  if (environment[RELEASE_TRUST_ENV] !== '1' && !releaseCredentialsPresent) {
    throw new Error(
      `Release trust is required by default; set ${LOCAL_ARTIFACT_ENV}=1 only for an unpublished local build`
    )
  }

  const teamId = environment.APPLE_TEAM_ID?.trim()
  if (!teamId) {
    throw new Error(
      `APPLE_TEAM_ID is required when ${RELEASE_TRUST_ENV}=1 or Apple signing credentials are present`
    )
  }
  if (teamId !== OFFGRID_APPLE_TEAM_ID) {
    throw new Error(
      `APPLE_TEAM_ID must match Off Grid AI's pinned signing team ${OFFGRID_APPLE_TEAM_ID}`
    )
  }
  return OFFGRID_APPLE_TEAM_ID
}

export function parseCodeSignatureDetails(output) {
  const value = (name) => output.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() ?? null
  return {
    authorities: [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim()),
    flags: output.match(/^CodeDirectory .*$/m)?.[0] ?? '',
    signature: value('Signature'),
    teamIdentifier: value('TeamIdentifier')
  }
}

export function assertReleaseSignature(details, expectedTeamId) {
  if (!expectedTeamId.trim()) {
    throw new Error('Expected Apple team identifier must not be empty')
  }
  if (details.signature === 'adhoc' || details.teamIdentifier === 'not set') {
    throw new Error('Release app is ad-hoc signed instead of Developer ID signed')
  }
  if (!details.authorities.some((authority) => authority.startsWith('Developer ID Application:'))) {
    throw new Error('Release app signature has no Developer ID Application authority')
  }
  if (details.teamIdentifier !== expectedTeamId) {
    throw new Error(
      `Release app team identifier mismatch: expected ${expectedTeamId}, found ${details.teamIdentifier ?? 'none'}`
    )
  }
  if (!details.flags.includes('runtime')) {
    throw new Error('Release app signature does not enable the hardened runtime')
  }
}

export function assertAsarProtectionFuses(fuseWire) {
  const embeddedIntegrity =
    fuseWire[electronFuses.FuseV1Options.EnableEmbeddedAsarIntegrityValidation]
  const asarOnly = fuseWire[electronFuses.FuseV1Options.OnlyLoadAppFromAsar]

  if (embeddedIntegrity !== ENABLED_FUSE_STATE) {
    throw new Error('EnableEmbeddedAsarIntegrityValidation fuse is not enabled')
  }
  if (asarOnly !== ENABLED_FUSE_STATE) {
    throw new Error('OnlyLoadAppFromAsar fuse is not enabled')
  }
}

export function assertGatekeeperAssessment(output) {
  if (!/^source=Notarized Developer ID$/m.test(output)) {
    throw new Error('Gatekeeper did not accept the app as Notarized Developer ID')
  }
}

export async function verifyStrictAppTrust(bundle, boundary = systemBoundary) {
  await boundary.execFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
  const fuseWire = await boundary.readFuses(bundle)
  assertAsarProtectionFuses(fuseWire)
}

export async function verifyReleaseAppTrust(bundle, expectedTeamId, boundary = systemBoundary) {
  await verifyStrictAppTrust(bundle, boundary)
  const signedCode = [
    bundle,
    ...CRITICAL_SIGNED_CODE.map((relative) => path.join(bundle, relative))
  ]
  let appDetails
  for (const code of signedCode) {
    const signature = await boundary.execFile('/usr/bin/codesign', [
      '--display',
      '--verbose=4',
      code
    ])
    const details = parseCodeSignatureDetails(commandOutput(signature))
    assertReleaseSignature(details, expectedTeamId)
    if (code === bundle) appDetails = details
  }
  await boundary.execFile('/usr/bin/xcrun', ['stapler', 'validate', bundle])
  const gatekeeper = await boundary.execFile('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'execute',
    '--verbose=4',
    bundle
  ])
  assertGatekeeperAssessment(commandOutput(gatekeeper))
  return appDetails
}
