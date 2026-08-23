// Is an image's BYTES decodable? Asked so that the machinery which answers can
// never become a precondition for attaching a file.
//
// sharp is a native module, and it can fail to load for reasons that have nothing
// to do with the file in front of it. sharp ships libvips as `libvips-42.dll`, and
// Windows resolves a DLL by NAME across the whole process: the first copy loaded
// wins every later binding. A second sharp version anywhere in the tree therefore
// broke ours with ERR_DLOPEN_FAILED — `embeddings.ts` loads @xenova/transformers
// (sharp 0.32 / libvips 8.14.5) at startup, so our sharp 0.35 asked that older DLL
// for symbols it does not export. macOS binds by path and never showed it.
//
// `package.json` overrides now hold the tree at one sharp, so that specific clash
// cannot recur. The reason this module exists is the SECOND half of that failure:
// the upload path imported sharp at the top level, so a module that only validates
// images took every attachment down with it. A PDF and a text file cannot be
// attached on Windows either, and neither has anything to do with sharp.
//
// Hence a three-valued answer. "I could not check" is not "this file is broken".

/** The one call this check needs from sharp — injected so the decision can be
 *  proved against a real file without a working native module. */
export type ImageProbe = (filePath: string) => { metadata(): Promise<unknown> }

export type ImageDecodeVerdict =
  /** sharp read the header: the bytes are a real image. */
  | 'decodable'
  /** sharp read the file and rejected it: the user's file is damaged. Say so. */
  | 'undecodable'
  /** sharp itself did not load: the check is SKIPPED, not failed. Attach anyway. */
  | 'unchecked'

/** Load sharp on demand. Returns null when the module cannot load at all, so the
 *  caller can distinguish a missing checker from a bad file. */
export async function loadImageProbe(): Promise<ImageProbe | null> {
  try {
    const mod = (await import('sharp')) as unknown as {
      default?: (p: string, o?: unknown) => { metadata(): Promise<unknown> }
    }
    const sharp = mod.default ?? (mod as unknown as typeof mod.default)
    if (!sharp) return null
    // failOn: 'error' — a truncated or corrupt image must reject rather than decode
    // to garbage and reach the vision runtime as engine noise.
    return (filePath: string) => sharp(filePath, { failOn: 'error' })
  } catch (e) {
    // Deliberately not thrown: an unloadable validator is an infrastructure fault,
    // and it must not present itself as a verdict on the user's file.
    console.warn(
      '[files] image validation unavailable (sharp did not load); attaching without it:',
      (e as Error).message.split('\n')[0]
    )
    return null
  }
}

/**
 * Judge a file's bytes. Pure in its decision: the probe is injected, so the three
 * outcomes are provable without depending on whether this machine's native module
 * happens to work.
 */
export async function verifyImageDecodable(
  filePath: string,
  load: () => Promise<ImageProbe | null> = loadImageProbe
): Promise<ImageDecodeVerdict> {
  const probe = await load()
  if (!probe) return 'unchecked'
  try {
    await probe(filePath).metadata()
    return 'decodable'
  } catch {
    return 'undecodable'
  }
}
