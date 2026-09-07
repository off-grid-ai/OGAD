import { clean, lt, prerelease, rcompare, valid } from 'semver'

/** Reading the release feed is an HTTP round trip, not model work. */
const RELEASE_HISTORY_TIMEOUT_MS = 10_000

const RELEASES_URL =
  'https://api.github.com/repos/off-grid-ai/off-grid-ai-desktop/releases?per_page=50'
const RELEASE_DOWNLOAD_PREFIXES = [
  '/off-grid-ai/off-grid-ai-desktop/releases/download/',
  '/off-grid-ai/OGAD/releases/download/'
] as const

export interface PreviousUpdateRelease {
  version: string
  channel: 'stable' | 'nightly'
  publishedAt: string | null
  feedUrl: string
}

interface GitHubAsset {
  name?: unknown
  browser_download_url?: unknown
}

interface GitHubRelease {
  tag_name?: unknown
  draft?: unknown
  published_at?: unknown
  assets?: unknown
}

function feedName(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return 'latest-mac.yml'
  if (platform === 'win32') return 'latest.yml'
  return null
}

function releaseFeedUrl(asset: GitHubAsset): string | null {
  if (typeof asset.browser_download_url !== 'string') return null
  try {
    const url = new URL(asset.browser_download_url)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      !RELEASE_DOWNLOAD_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
    ) {
      return null
    }
    return new URL('./', url).toString()
  } catch {
    return null
  }
}

function parseRelease(
  value: unknown,
  currentVersion: string,
  requiredFeed: string
): PreviousUpdateRelease | null {
  if (!value || typeof value !== 'object') return null
  const release = value as GitHubRelease
  if (release.draft === true || typeof release.tag_name !== 'string') return null
  const normalized = clean(release.tag_name)
  if (!normalized || !valid(normalized) || !lt(normalized, currentVersion)) return null
  if (!Array.isArray(release.assets)) return null
  const feedAsset = (release.assets as GitHubAsset[]).find((asset) => asset.name === requiredFeed)
  if (!feedAsset) return null
  const feedUrl = releaseFeedUrl(feedAsset)
  if (!feedUrl) return null
  return {
    version: normalized,
    channel: prerelease(normalized) ? 'nightly' : 'stable',
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    feedUrl
  }
}

function parsePreviousUpdateReleases(
  value: unknown,
  currentVersion: string,
  platform: NodeJS.Platform
): PreviousUpdateRelease[] {
  if (!Array.isArray(value) || !valid(currentVersion)) return []
  const requiredFeed = feedName(platform)
  if (!requiredFeed) return []

  const byVersion = new Map<string, PreviousUpdateRelease>()
  for (const item of value) {
    const release = parseRelease(item, currentVersion, requiredFeed)
    if (release) byVersion.set(release.version, release)
  }
  return [...byVersion.values()].sort((a, b) => rcompare(a.version, b.version))
}

interface ListPreviousUpdateReleasesOptions {
  currentVersion: string
  platform: NodeJS.Platform
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export async function listPreviousUpdateReleases({
  currentVersion,
  platform,
  fetchImpl = fetch,
  timeoutMs = RELEASE_HISTORY_TIMEOUT_MS
}: ListPreviousUpdateReleasesOptions): Promise<PreviousUpdateRelease[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(RELEASES_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (!response.ok) {
      throw new Error(`GitHub release history returned HTTP ${response.status}.`)
    }
    return parsePreviousUpdateReleases(await response.json(), currentVersion, platform)
  } finally {
    clearTimeout(timer)
  }
}
