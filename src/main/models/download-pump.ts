// The write half of a model download, isolated so it can be tested without the
// network / catalog / llm. Pumps a fetch Response body into an open write stream.
//
// It owns the failure the naive inline loop got wrong (D1): a write error (disk
// full / EIO) emits an 'error' event on the stream. With NO 'error' listener that
// becomes an UNHANDLED exception and crashes the whole main process; and 'finish'
// never fires after an error, so awaiting it would HANG the download forever.
// pumpToFile attaches the listener and turns a write error into a normal
// rejection, so the caller reports the download failed instead of crashing.

import type fs from 'fs'

interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
}

/** Pump `reader` into `out`, calling `onBytes` with each chunk's length. Resolves
 *  when the body is fully written and flushed; rejects (never throws out-of-band)
 *  if the write stream errors. */
export async function pumpToFile(
  reader: ByteReader,
  out: fs.WriteStream,
  onBytes: (n: number) => void
): Promise<void> {
  // Capture the FIRST write error the moment it fires, so it can never reach the
  // process as an unhandled 'error' event, and so the loop stops promptly.
  let writeErr: Error | null = null
  out.on('error', (e: Error) => {
    writeErr ??= e
  })
  try {
    for (;;) {
      // The stream error callback mutates writeErr asynchronously; TypeScript
      // cannot observe that mutation inside this loop.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (writeErr) throw writeErr
      const { done, value } = await reader.read()
      if (done || !value) break
      onBytes(value.length)
      // Wait for the disk when it falls behind the network. Without this a fast connection
      // queued gigabytes in memory, and macOS refused the batched write (EINVAL: writev takes
      // at most 1024 buffers).
      // A stream that already errored (the part file could not be opened, the disk failed)
      // refuses every write and never drains: its one 'error' has fired, so stop here.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!out.write(Buffer.from(value)) && !writeErr && !out.errored && !out.destroyed) {
        await new Promise<void>((resolve) => {
          const settle = (): void => {
            out.off('drain', settle)
            out.off('error', settle)
            resolve()
          }
          out.on('drain', settle)
          out.on('error', settle)
        })
      }
    }
  } finally {
    out.end()
    // Wait for the flush, but reject on error instead of hanging (a stream that
    // errored never emits 'finish').
    await new Promise<void>((resolve, reject) => {
      if (writeErr) {
        reject(writeErr)
        return
      }
      out.on('error', reject)
      out.on('finish', () => resolve())
    })
  }
}
