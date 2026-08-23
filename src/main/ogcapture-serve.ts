// Range-aware file serving for the ogcapture:// scheme. Canonicalization, root admission,
// and fs reads live together here so callers cannot bypass the path boundary.
import fs from 'node:fs'
import path from 'node:path'
import { mimeForExt } from './mime'

/** Is a canonical target-to-root relative path still inside that root?
 *
 * Check both path dialects regardless of the test host. On Windows, `path.relative`
 * returns an absolute path when target and root are on different drives; accepting
 * that result would bypass the capture root allowlist.
 */
export function isCapturePathInsideRoot(relative: string): boolean {
  if (relative === '') return true
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith('../') && !relative.startsWith('..\\')
}

/** ReadStream -> web ReadableStream that tears down SILENTLY on cancel (a seek/teardown):
 *  never call controller.error/close after a cancel, or Chromium treats the seek as a
 *  failed load and resets the player to 0:00. (net.fetch(file://) sidesteps this but
 *  doesn't honour Range, so seeking would be dead.) */
function fileStreamToWeb(rs: fs.ReadStream): ReadableStream<Uint8Array> {
  let done = false
  return new ReadableStream<Uint8Array>({
    start(controller) {
      rs.on('data', (chunk: string | Buffer) => {
        if (done) return
        controller.enqueue(
          typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)
        )
        if ((controller.desiredSize ?? 1) <= 0) rs.pause()
      })
      rs.on('end', () => {
        if (!done) {
          done = true
          try {
            controller.close()
          } catch {
            /* closed */
          }
        }
      })
      rs.on('error', (err) => {
        if (!done) {
          done = true
          try {
            controller.error(err)
          } catch {
            /* errored */
          }
        }
      })
    },
    pull() {
      if (!done) rs.resume()
    },
    // Player cancelled (seek / teardown): kill the fd quietly, NEVER touch the controller.
    cancel() {
      done = true
      rs.destroy()
    }
  })
}

/** Serve `filePath` over ogcapture://, honouring an HTTP Range header.
 *
 * This function owns the canonicalization and root allowlist. Keeping admission beside the
 * filesystem reads means another caller cannot accidentally turn this into an arbitrary-file
 * server. Returns 403 outside the roots, 416 for an unsatisfiable range, 404 on any fs error,
 * 206 for a partial body, else 200.
 */
export async function serveCaptureFile(
  filePath: string,
  allowedRoots: string[],
  rangeHeader: string | null
): Promise<Response> {
  try {
    const validatedPath = fs.realpathSync.native(filePath)
    const allowed = allowedRoots.some((root) => {
      try {
        const validatedRoot = fs.realpathSync.native(root)
        const relative = path.relative(validatedRoot, validatedPath)
        return isCapturePathInsideRoot(relative)
      } catch {
        return false
      }
    })
    if (!allowed) return new Response(null, { status: 403 })

    const stat = await fs.promises.stat(validatedPath)
    if (!stat.isFile()) return new Response(null, { status: 404 })
    const size = stat.size
    const type = mimeForExt(path.extname(validatedPath).slice(1).toLowerCase())
    const m = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
    if (m && (m[1] || m[2])) {
      const start = m[1]
        ? Number.parseInt(m[1], 10)
        : Math.max(0, size - Number.parseInt(m[2]!, 10))
      const end = m[1] && m[2] ? Math.min(Number.parseInt(m[2], 10), size - 1) : size - 1
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      const rs = fs.createReadStream(validatedPath, { start, end })
      return new Response(fileStreamToWeb(rs), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes'
        }
      })
    }
    const rs = fs.createReadStream(validatedPath)
    return new Response(fileStreamToWeb(rs), {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
    })
  } catch (e) {
    console.error('[ogcapture] serve failed for', filePath, e)
    return new Response(null, { status: 404 })
  }
}

/**
 * The reader half of the scheme now lives beside its writer in `shared/ogcapture-url`, because the
 * renderer builds these URLs and the main process resolves them: written apart, they drifted, and the
 * drift was invisible on macOS. Re-exported here so existing callers and their tests keep their import.
 */
export { capturePathFromUrl } from '../shared/ogcapture-url'
