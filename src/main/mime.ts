// Single source of truth: file-extension -> MIME type.
//
// Three call sites used to keep their own divergent copies of this map — the
// `ogcapture://` protocol handler (index.ts), the media HTTP server
// (media-server.ts), and image-attachment sniffing (model-server/data-url.ts).
// Adding a format to one left the others serving the wrong or absent type on
// their path only (a video that wouldn't seek, an image that rendered broken).
// The map is defined ONCE here; each caller supplies the fallback that fits its
// context for an unknown extension: file-serving falls back to
// application/octet-stream, image attachments fall back to image/png.
const EXT_MIME: Record<string, string> = {
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  // audio
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  // image — must cover every ext files-classify's IMAGE_EXT accepts, or an
  // accepted upload gets mislabelled (the webp bug this map was created to fix).
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  // document — a PDF served as the octet-stream fallback is DOWNLOADED by Chromium rather than
  // rendered, so an attachment that opened correctly on Android arrived on desktop as a file save
  // prompt. The kinds here match the ones @offgrid/sync's describeAttachment can name.
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv'
}

/**
 * Resolve a MIME type from a file extension. Accepts the ext with or without a
 * leading dot and in any case (`.MP4`, `mp4`, `.mp4` all resolve to `video/mp4`).
 * Unknown extensions return `fallback` (default `application/octet-stream` for
 * file-serving callers; pass `image/png` for image-attachment callers).
 */
export function mimeForExt(ext: string, fallback = 'application/octet-stream'): string {
  const e = ext.replace(/^\.+/, '').toLowerCase()
  return EXT_MIME[e] ?? fallback
}
