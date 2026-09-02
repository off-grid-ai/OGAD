/**
 * Where signed releases are published. One owner for the updater feed and for any check that
 * must know whether that feed is reachable before it asserts against it.
 */
export const GITHUB_UPDATE_PROVIDER = {
  provider: 'github' as const,
  owner: 'off-grid-ai',
  repo: 'off-grid-ai-desktop'
}
