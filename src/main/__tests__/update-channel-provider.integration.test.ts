import type { RequestOptions } from 'node:http'
import { HttpError } from 'builder-util-runtime'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider'
import type { AppUpdater } from 'electron-updater'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'
import { SemVer } from 'semver'
import { describe, expect, it } from 'vitest'
import { resolveChannelConfig } from '../update-channel'

const RELEASE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Off Grid AI Desktop 0.0.41-beta.72</title>
    <link href="https://github.com/off-grid-ai/OGAD/releases/tag/v0.0.41-beta.72" />
    <content>Nightly release</content>
  </entry>
  <entry>
    <title>Off Grid AI Desktop 0.0.38</title>
    <link href="https://github.com/off-grid-ai/OGAD/releases/tag/v0.0.38" />
    <content>Stable release</content>
  </entry>
</feed>`

const LATEST_MAC_FEED = `version: 0.0.41-beta.72
files:
  - url: Off-Grid-AI-Desktop-0.0.41-beta.72-arm64-mac.zip
    sha512: test-checksum
`

interface ProviderFixture {
  provider: GitHubProvider
  requests: string[]
}

interface ProviderConfig {
  channel: 'latest' | 'beta'
  allowPrerelease: boolean
  allowDowngrade: boolean
}

function providerFor(config: ProviderConfig): ProviderFixture {
  const requests: string[] = []
  const executor = {
    request: async (options: RequestOptions): Promise<string> => {
      const request = `${options.hostname ?? ''}${options.path ?? ''}`
      requests.push(request)
      if (request.endsWith('/releases.atom')) return RELEASE_FEED
      if (request.endsWith('/beta-mac.yml')) throw new HttpError(404, 'not found')
      if (request.endsWith('/latest-mac.yml')) return LATEST_MAC_FEED
      throw new Error(`Unexpected updater request: ${request}`)
    }
  }
  const updater = {
    ...config,
    currentVersion: new SemVer('0.0.41-beta.70'),
    fullChangelog: false,
    isAddNoCacheQuery: false
  } as unknown as AppUpdater
  const runtime = {
    executor,
    platform: 'darwin',
    isUseMultipleRangeRequest: false
  } as unknown as ProviderRuntimeOptions
  return {
    provider: new GitHubProvider(
      { provider: 'github', owner: 'off-grid-ai', repo: 'OGAD' },
      updater,
      runtime
    ),
    requests
  }
}

describe('nightly discovery through electron-updater GitHubProvider', () => {
  it('reproduces the installed beta failure when prerelease discovery uses latest', async () => {
    const { provider } = providerFor({
      channel: 'latest',
      allowPrerelease: true,
      allowDowngrade: false
    })
    const request = provider.getLatestVersion()

    await expect(request).rejects.toMatchObject({
      code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'
    })
    await expect(request).rejects.toThrow('No published versions on GitHub')
  })

  it('discovers the beta and falls back to the published latest-mac.yml feed', async () => {
    const { provider, requests } = providerFor(resolveChannelConfig('beta'))

    await expect(provider.getLatestVersion()).resolves.toMatchObject({
      tag: 'v0.0.41-beta.72',
      version: '0.0.41-beta.72'
    })
    expect(requests).toEqual([
      'github.com/off-grid-ai/OGAD/releases.atom',
      'github.com/off-grid-ai/OGAD/releases/download/v0.0.41-beta.72/beta-mac.yml',
      'github.com/off-grid-ai/OGAD/releases/download/v0.0.41-beta.72/latest-mac.yml'
    ])
  })
})
