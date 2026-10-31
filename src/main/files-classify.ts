// Pure upload-classification helpers, extracted from files.ts so they can be
// unit-tested without the electron/fs IO the orchestrator pulls in. Behaviour is
// unchanged — files.ts imports these back and uses them exactly as before.

import path from 'path'

export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic']
export const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'aiff', 'aif']
export const VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']
// Document/text extensions the uploader surfaces in the picker. pdf/docx classify
// to their own kinds; the rest classify as 'text'. Listed here so the file-picker
// allowlist is derived from the same source the router uses.
export const DOC_EXT = ['txt', 'md', 'markdown', 'csv', 'json', 'pdf', 'docx']

export type UploadKind = 'text' | 'pdf' | 'docx' | 'image' | 'audio' | 'video'

/** Route an uploaded file name to its handler kind by extension. Everything that
 *  isn't a known image/audio/video/pdf/docx extension is treated as text. */
export function classifyUpload(name: string): UploadKind {
  const ext = path.extname(name).slice(1).toLowerCase()
  if (IMAGE_EXT.includes(ext)) return 'image'
  if (AUDIO_EXT.includes(ext)) return 'audio'
  if (VIDEO_EXT.includes(ext)) return 'video'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx') return 'docx'
  return 'text'
}

/** Every extension the upload file-picker should allow, derived from the router's
 *  own classify sets (+ doc/text) so the picker and the processor can never
 *  disagree: a user cannot pick a file the router can't classify, and every
 *  format the router handles is offered. Deduped; order: docs, audio, video,
 *  image. */
export function uploadPickerExtensions(): string[] {
  return Array.from(new Set([...DOC_EXT, ...AUDIO_EXT, ...VIDEO_EXT, ...IMAGE_EXT]))
}

/** Sanitise a file name for use in a temp/persisted path: collapse any run of
 *  characters outside [word chars, dot, dash] to a single underscore. */
export function sanitizeUploadName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_')
}

/** Formats we cannot read yet. Read as text, their bytes would reach the model as garbage. */
const BINARY_EXT = [
  'xlsx',
  'xls',
  'xlsm',
  'pptx',
  'ppt',
  'key',
  'numbers',
  'pages',
  'odt',
  'ods',
  'odp',
  'doc',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'dmg',
  'iso',
  'exe',
  'msi',
  'dll',
  'so',
  'dylib',
  'bin',
  'apk',
  'ipa',
  'jar',
  'class',
  'sqlite',
  'db',
  'psd',
  'ai',
  'sketch',
  'fig',
  'epub',
  'mobi',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'wasm'
]

/** A known binary format by name alone (no file read). */
export function isBinaryUploadName(name: string): boolean {
  return BINARY_EXT.includes(path.extname(name).slice(1).toLowerCase())
}
