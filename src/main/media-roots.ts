import path from 'node:path'

/**
 * User-data directories whose files may be rendered as local media.
 *
 * Both the legacy `ogcapture://` handler and the loopback HTTP server consume
 * this list. Keeping admission in one place prevents a new media surface from
 * working through one transport while silently returning 403 through the other.
 */
const LOCAL_MEDIA_DIRS = [
  'meetings',
  'uploads',
  'captures',
  'entity-photos',
  'voice',
  'generated-images',
  'style-thumbs'
] as const

export function localMediaRoots(userData: string, resourceRoots: readonly string[] = []): string[] {
  return [
    ...LOCAL_MEDIA_DIRS.map((directory) => path.join(userData, directory)),
    ...resourceRoots.map((directory) => path.join(directory, 'style-thumbs'))
  ]
}
