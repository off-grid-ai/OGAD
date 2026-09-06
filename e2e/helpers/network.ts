import { GITHUB_UPDATE_PROVIDER } from '../../src/shared/update-provider'

/**
 * Precondition guard for specs that assert against the LIVE release feed.
 *
 * The packaged rollback journey lists signed releases from GitHub through the production updater.
 * The app bounds that request at 10 s and fails closed, which is correct behaviour and also what a
 * slow or offline network turns into a failing test. Probe the feed first with a shorter bound and
 * skip with the reason when it does not answer, the same way ./ports and ./permissions guard the
 * fixed engine ports and the Screen Recording grant.
 */
export const githubReleasesUnavailableReason = async (
  timeoutMs = 5_000
): Promise<string | null> => {
  const { owner, repo } = GITHUB_UPDATE_PROVIDER
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=1`
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (response.ok) return null
    return `GitHub releases feed answered ${response.status} for ${owner}/${repo}; the rollback journey needs the live signed-release list`
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return `GitHub releases feed for ${owner}/${repo} did not answer within ${timeoutMs}ms (${detail}); the rollback journey needs the live signed-release list`
  }
}
