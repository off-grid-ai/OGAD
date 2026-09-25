import { describe, expect, it } from 'vitest'
import { listPreviousUpdateReleases } from '../update-release-history'

const releases = [
  {
    tag_name: 'v0.0.41-beta.72',
    draft: false,
    published_at: '2026-07-22T12:00:00Z',
    assets: [
      {
        name: 'latest-mac.yml',
        browser_download_url:
          'https://github.com/off-grid-ai/off-grid-ai-desktop/releases/download/v0.0.41-beta.72/latest-mac.yml'
      }
    ]
  },
  {
    tag_name: 'v0.0.41-beta.71',
    draft: false,
    published_at: '2026-07-21T12:00:00Z',
    assets: [
      {
        name: 'latest-mac.yml',
        browser_download_url:
          'https://github.com/off-grid-ai/off-grid-ai-desktop/releases/download/v0.0.41-beta.71/latest-mac.yml'
      },
      {
        name: 'latest.yml',
        browser_download_url:
          'https://github.com/off-grid-ai/off-grid-ai-desktop/releases/download/v0.0.41-beta.71/latest.yml'
      },
      {
        name: 'latest-linux.yml',
        browser_download_url:
          'https://github.com/off-grid-ai/off-grid-ai-desktop/releases/download/v0.0.41-beta.71/latest-linux.yml'
      }
    ]
  },
  {
    tag_name: 'v0.0.40',
    draft: false,
    published_at: '2026-07-01T12:00:00Z',
    assets: [
      {
        name: 'latest-mac.yml',
        browser_download_url:
          'https://github.com/off-grid-ai/OGAD/releases/download/v0.0.40/latest-mac.yml'
      }
    ]
  }
]

function githubBoundary(value: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(value), { status })
}

describe('previous signed releases through the GitHub catalogue service', () => {
  it('returns only older signed feeds for the running platform, newest first', async () => {
    const requests: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push(String(input))
      expect(init?.headers).toMatchObject({
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      })
      return new Response(JSON.stringify(releases), { status: 200 })
    }

    await expect(
      listPreviousUpdateReleases({
        currentVersion: '0.0.41-beta.72',
        platform: 'darwin',
        fetchImpl
      })
    ).resolves.toEqual([
      {
        version: '0.0.41-beta.71',
        channel: 'nightly',
        publishedAt: '2026-07-21T12:00:00Z',
        feedUrl:
          'https://github.com/off-grid-ai/off-grid-ai-desktop/releases/download/v0.0.41-beta.71/'
      },
      {
        version: '0.0.40',
        channel: 'stable',
        publishedAt: '2026-07-01T12:00:00Z',
        feedUrl: 'https://github.com/off-grid-ai/OGAD/releases/download/v0.0.40/'
      }
    ])
    expect(requests).toEqual([
      'https://api.github.com/repos/off-grid-ai/off-grid-ai-desktop/releases?per_page=50'
    ])
  })

  it('rejects drafts, unsafe feeds, invalid versions, duplicates, and missing platform assets', async () => {
    const validRelease = releases[1]
    const invalid = [
      null,
      { ...validRelease, draft: true },
      { ...validRelease, tag_name: 'not-semver' },
      { ...validRelease, tag_name: 'v0.0.42' },
      { ...validRelease, assets: null },
      {
        ...validRelease,
        assets: [{ name: 'notes.txt', browser_download_url: 'https://github.com/notes.txt' }]
      },
      {
        ...validRelease,
        assets: [{ name: 'latest-mac.yml', browser_download_url: 'https://example.com/feed.yml' }]
      },
      {
        ...validRelease,
        assets: [
          {
            name: 'latest-mac.yml',
            browser_download_url:
              'http://github.com/off-grid-ai/OGAD/releases/download/v0.0.41-beta.71/latest-mac.yml'
          }
        ]
      },
      {
        ...validRelease,
        assets: [{ name: 'latest-mac.yml', browser_download_url: 'not a URL' }]
      },
      {
        ...validRelease,
        assets: [{ name: 'latest-mac.yml', browser_download_url: 42 }]
      },
      validRelease,
      validRelease
    ]

    await expect(
      listPreviousUpdateReleases({
        currentVersion: '0.0.41-beta.72',
        platform: 'darwin',
        fetchImpl: githubBoundary(invalid)
      })
    ).resolves.toEqual([expect.objectContaining({ version: '0.0.41-beta.71', channel: 'nightly' })])
    await expect(
      listPreviousUpdateReleases({
        currentVersion: 'invalid',
        platform: 'darwin',
        fetchImpl: githubBoundary(releases)
      })
    ).resolves.toEqual([])
    await expect(
      listPreviousUpdateReleases({
        currentVersion: '0.0.41-beta.72',
        platform: 'freebsd',
        fetchImpl: githubBoundary(releases)
      })
    ).resolves.toEqual([])
  })

  it('selects the Linux feed through the same service boundary', async () => {
    await expect(
      listPreviousUpdateReleases({
        currentVersion: '0.0.41-beta.72',
        platform: 'linux',
        fetchImpl: githubBoundary(releases)
      })
    ).resolves.toEqual([
      expect.objectContaining({
        version: '0.0.41-beta.71',
        feedUrl:
          'https://github.com/off-grid-ai/off-grid-ai-desktop/releases/download/v0.0.41-beta.71/'
      })
    ])
  })

  it('selects the Windows feed through the same service boundary', async () => {
    await expect(
      listPreviousUpdateReleases({
        currentVersion: '0.0.41-beta.72',
        platform: 'win32',
        fetchImpl: githubBoundary(releases)
      })
    ).resolves.toEqual([
      expect.objectContaining({
        version: '0.0.41-beta.71',
        feedUrl:
          'https://github.com/off-grid-ai/off-grid-ai-desktop/releases/download/v0.0.41-beta.71/'
      })
    ])
  })

  it('surfaces GitHub failures and bounds a stalled request', async () => {
    await expect(
      listPreviousUpdateReleases({
        currentVersion: '0.0.41-beta.72',
        platform: 'darwin',
        fetchImpl: githubBoundary('rate limited', 403)
      })
    ).rejects.toThrow('GitHub release history returned HTTP 403.')

    const stalledBoundary: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')))
      })
    await expect(
      listPreviousUpdateReleases({
        currentVersion: '0.0.41-beta.72',
        platform: 'darwin',
        fetchImpl: stalledBoundary,
        timeoutMs: 5
      })
    ).rejects.toThrow('request aborted')
  })
})
