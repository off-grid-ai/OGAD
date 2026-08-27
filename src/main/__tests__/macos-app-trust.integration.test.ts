import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertAsarProtectionFuses,
  assertGatekeeperAssessment,
  assertReleaseSignature,
  CRITICAL_SIGNED_CODE,
  OFFGRID_APPLE_TEAM_ID,
  parseCodeSignatureDetails,
  releaseTeamIdForEnvironment,
  verifyReleaseAppTrust,
  verifyStrictAppTrust,
  type MacAppTrustBoundary
} from '../../../scripts/lib/macos-app-trust.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const TEAM_ID = OFFGRID_APPLE_TEAM_ID
const ENABLED = '1'.charCodeAt(0)
const tempRoots: string[] = []

const developerIdDetails = `Executable=/Applications/Off Grid AI Desktop.app/Contents/MacOS/Off Grid AI Desktop
Identifier=co.getoffgridai.desktop.pro
CodeDirectory v=20500 size=444 flags=0x10000(runtime) hashes=3+7 location=embedded
Authority=Developer ID Application: Wednesday Solutions, Inc (${TEAM_ID})
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=${TEAM_ID}
`

function trustedBoundary(): {
  boundary: MacAppTrustBoundary
  commands: Array<{ executable: string; args: readonly string[] }>
} {
  const commands: Array<{ executable: string; args: readonly string[] }> = []
  return {
    commands,
    boundary: {
      async execFile(executable, args) {
        commands.push({ executable, args })
        if (args.includes('--display')) return { stderr: developerIdDetails }
        if (executable === '/usr/sbin/spctl') {
          return {
            stderr: '/tmp/Off Grid AI Desktop.app: accepted\nsource=Notarized Developer ID\n'
          }
        }
        return { stdout: '', stderr: '' }
      },
      async readFuses() {
        return { 4: ENABLED, 5: ENABLED }
      }
    }
  }
}

describe('macOS application trust', () => {
  afterEach(() => {
    while (tempRoots.length) {
      fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
    }
  })

  it('requires release trust whenever signing credentials or the explicit gate are present', () => {
    expect(() => releaseTeamIdForEnvironment({})).toThrow('Release trust is required by default')
    expect(
      releaseTeamIdForEnvironment({
        OFFGRID_ALLOW_LOCAL_ARTIFACT: '1',
        OFFGRID_LOCAL_PUBLISH_POLICY: 'never'
      })
    ).toBeNull()
    expect(
      releaseTeamIdForEnvironment({ OFFGRID_REQUIRE_RELEASE_TRUST: '1', APPLE_TEAM_ID: TEAM_ID })
    ).toBe(TEAM_ID)
    expect(releaseTeamIdForEnvironment({ CSC_LINK: 'certificate', APPLE_TEAM_ID: TEAM_ID })).toBe(
      TEAM_ID
    )
    expect(() => releaseTeamIdForEnvironment({ CSC_LINK: 'certificate' })).toThrow(
      'APPLE_TEAM_ID is required'
    )
    expect(() =>
      releaseTeamIdForEnvironment({
        OFFGRID_ALLOW_LOCAL_ARTIFACT: '1',
        OFFGRID_LOCAL_PUBLISH_POLICY: 'never',
        GH_TOKEN: 'publish-token'
      })
    ).toThrow('forbidden in a release or publish context')
    expect(() =>
      releaseTeamIdForEnvironment({
        OFFGRID_ALLOW_LOCAL_ARTIFACT: '1',
        OFFGRID_LOCAL_PUBLISH_POLICY: 'always'
      })
    ).toThrow('OFFGRID_LOCAL_PUBLISH_POLICY=never')
    expect(() =>
      releaseTeamIdForEnvironment({
        OFFGRID_REQUIRE_RELEASE_TRUST: '1',
        APPLE_TEAM_ID: 'OTHERTEAM'
      })
    ).toThrow("must match Off Grid AI's pinned signing team")
  })

  it('accepts only the intended Developer ID team with hardened runtime', () => {
    const details = parseCodeSignatureDetails(developerIdDetails)
    expect(() => assertReleaseSignature(details, TEAM_ID)).not.toThrow()
    expect(() => assertReleaseSignature(details, 'OTHERTEAM')).toThrow(
      'Release app team identifier mismatch'
    )
    expect(() =>
      assertReleaseSignature(
        parseCodeSignatureDetails('Signature=adhoc\nTeamIdentifier=not set\n'),
        TEAM_ID
      )
    ).toThrow('ad-hoc signed')
  })

  it('requires both ASAR anti-bypass fuses', () => {
    expect(() => assertAsarProtectionFuses({ 4: ENABLED, 5: ENABLED })).not.toThrow()
    expect(() => assertAsarProtectionFuses({ 4: 48, 5: ENABLED })).toThrow(
      'EnableEmbeddedAsarIntegrityValidation fuse is not enabled'
    )
    expect(() => assertAsarProtectionFuses({ 4: ENABLED, 5: 48 })).toThrow(
      'OnlyLoadAppFromAsar fuse is not enabled'
    )
  })

  it('requires Gatekeeper to name the notarized Developer ID policy', () => {
    expect(() =>
      assertGatekeeperAssessment('accepted\nsource=Notarized Developer ID\n')
    ).not.toThrow()
    expect(() => assertGatekeeperAssessment('accepted\nsource=Developer ID\n')).toThrow(
      'Gatekeeper did not accept the app as Notarized Developer ID'
    )
  })

  it('runs strict signature, fuse, Developer ID, staple and Gatekeeper checks in one seam', async () => {
    const { boundary, commands } = trustedBoundary()
    const bundle = '/tmp/Off Grid AI Desktop.app'

    await expect(verifyReleaseAppTrust(bundle, TEAM_ID, boundary)).resolves.toMatchObject({
      teamIdentifier: TEAM_ID
    })
    expect(commands[0]).toEqual({
      executable: '/usr/bin/codesign',
      args: ['--verify', '--deep', '--strict', bundle]
    })
    expect(commands.slice(1, 2 + CRITICAL_SIGNED_CODE.length)).toEqual(
      [bundle, ...CRITICAL_SIGNED_CODE.map((relative) => path.join(bundle, relative))].map(
        (code) => ({
          executable: '/usr/bin/codesign',
          args: ['--display', '--verbose=4', code]
        })
      )
    )
    expect(commands.slice(2 + CRITICAL_SIGNED_CODE.length)).toEqual([
      {
        executable: '/usr/bin/xcrun',
        args: ['stapler', 'validate', bundle]
      },
      {
        executable: '/usr/sbin/spctl',
        args: ['--assess', '--type', 'execute', '--verbose=4', bundle]
      }
    ])
  })

  it('fails strict trust when either fuse is disabled even with a valid signature boundary', async () => {
    const { boundary } = trustedBoundary()
    boundary.readFuses = async () => ({ 4: ENABLED, 5: 48 })

    await expect(verifyStrictAppTrust('/tmp/Off Grid AI Desktop.app', boundary)).rejects.toThrow(
      'OnlyLoadAppFromAsar fuse is not enabled'
    )
  })

  it.skipIf(process.platform !== 'darwin')(
    'rejects a real ad-hoc Mach-O signature as a release identity',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-adhoc-signature-'))
      tempRoots.push(root)
      const executable = path.join(root, 'native-fixture')
      const compile = spawnSync('/usr/bin/clang', ['-x', 'c', '-', '-o', executable], {
        encoding: 'utf8',
        input: 'int main(void) { return 0; }\n'
      })
      expect(compile.status, compile.stderr).toBe(0)
      const sign = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', executable], {
        encoding: 'utf8'
      })
      expect(sign.status, sign.stderr).toBe(0)
      const display = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', executable], {
        encoding: 'utf8'
      })
      expect(display.status, display.stderr).toBe(0)
      expect(() =>
        assertReleaseSignature(
          parseCodeSignatureDetails(`${display.stdout}\n${display.stderr}`),
          TEAM_ID
        )
      ).toThrow('ad-hoc signed')
    }
  )

  it('keeps the release workflow behind the explicit trust gate', () => {
    const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8')
    expect(workflow).toContain("OFFGRID_REQUIRE_RELEASE_TRUST: '1'")
    expect(workflow).toContain('APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}')
    expect(workflow).toContain('npx electron-builder --mac')
    expect(workflow).toContain('--publish never')
    expect(workflow).toContain('prepare-mac-release-assets.mjs')
    expect(workflow).toContain('gh release create "$TAG" --draft')
    expect(workflow).toContain('gh release upload "$TAG" dist/release-assets/* --clobber')
    expect(workflow).toContain('gh release edit "$TAG" --draft=false')
    expect(workflow).toContain('git rev-parse -q --verify "refs/tags/v$VERSION"')
  })
})
