/**
 * The two halves of the `ogcapture://` scheme: a local path becomes a URL, and that URL becomes the
 * path again. They live together, and in `shared/`, because main and renderer each own one half — and
 * a scheme whose writer and reader are written apart is a scheme that works on one platform only.
 *
 * What went wrong without this: the renderer built a URL by pasting a path after the scheme. On macOS
 * every path starts with `/`, so the authority came out empty and the rest was already the path. On
 * Windows the path starts `C:\Users\…`, which has no `/` at all — so the whole thing landed in the
 * authority, the backslashes made it an invalid host, and Chromium rejected the URL outright. The
 * image never reached the protocol handler, so nothing logged a 403 or a 404: the request was never
 * made. Only the previews with a `preview` data-URL fallback still drew, which is why a thumbnail
 * could render while the full-size view beside it was broken.
 *
 * Both functions are pure, so both dialects can be proved without a protocol handler or a window.
 */

/** The URL that names `absolutePath`, valid on both platforms.
 *
 * The drive letter goes in the PATH behind a leading slash, never in the authority: this scheme has
 * no host, and a one-letter host is a coincidence that a real URL parser is entitled to normalise.
 * Every segment is percent-encoded, so a space, a `#` or a `?` in a filename survives the round trip.
 */
export function captureUrlForPath(absolutePath: string): string {
  if (!absolutePath) return ''
  const forwardSlashed = absolutePath.replaceAll('\\', '/')
  const rooted = forwardSlashed.startsWith('/') ? forwardSlashed : `/${forwardSlashed}`
  const encoded = rooted.split('/').map(encodeURIComponent).join('/')
  return `ogcapture://${encoded}`
}

/**
 * The local path an `ogcapture://` URL names, on either platform.
 *
 * Accepts every form the scheme has ever carried, because a URL that is already on screen must keep
 * resolving: the rooted form this module writes (`ogcapture:///C%3A/…`), the drive-in-authority form
 * (`ogcapture://C:/…`), and a plain POSIX path.
 */
export function capturePathFromUrl(url: string): string {
  const withoutScheme = url.replace(/^[a-z]+:\/\//i, '')
  const separator = withoutScheme.indexOf('/')
  const authority = separator === -1 ? withoutScheme : withoutScheme.slice(0, separator)
  const rest = separator === -1 ? '' : withoutScheme.slice(separator)
  // A single-letter authority is a Windows drive, and the colon it lost belongs back on it. Anything
  // longer is a real host, which this scheme never has, so it is treated as part of the path.
  let decodedAuthority: string
  let decodedRest: string
  try {
    decodedAuthority = decodeURIComponent(authority)
    decodedRest = decodeURIComponent(rest)
  } catch {
    // Malformed percent escapes are invalid capture paths, not protocol-handler exceptions.
    return ''
  }
  if (/^[a-zA-Z]$/.test(decodedAuthority)) return `${decodedAuthority}:${decodedRest}`
  if (decodedAuthority === '') return stripRootBeforeDriveLetter(decodedRest)
  return `${decodedAuthority}${decodedRest}`
}

/** `/C:/Users/x` is how a Windows path rides in a URL path; `C:/Users/x` is how the filesystem
 *  wants it. A POSIX path is left exactly as it was, which is why macOS never saw this fault. */
function stripRootBeforeDriveLetter(pathname: string): string {
  return /^\/[a-zA-Z]:/.test(pathname) ? pathname.slice(1) : pathname
}
