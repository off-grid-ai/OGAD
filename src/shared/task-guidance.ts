export const TASK_GUIDE_MAX_TEXT_CHARS = 2_000
export const TASK_GUIDE_MAX_ATTACHMENTS = 4
export const TASK_GUIDE_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
export const TASK_GUIDE_MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024
export const TASK_GUIDE_MAX_ATTACHMENT_TEXT_CHARS = 16_000
export const TASK_GUIDE_MAX_TOTAL_ATTACHMENT_TEXT_CHARS = 48_000

export const TASK_GUIDE_ATTACHMENT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'csv',
  'json',
  'pdf',
  'docx',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'heic'
] as const

export const TASK_GUIDE_ATTACHMENT_ACCEPT = TASK_GUIDE_ATTACHMENT_EXTENSIONS.map(
  (extension) => `.${extension}`
).join(',')

export interface TaskGuideAttachmentInput {
  name: string
  mimeType?: string
  bytes: ArrayBuffer | Uint8Array
}

export interface TaskGuideInput {
  text: string
  attachments?: TaskGuideAttachmentInput[]
}

export function taskGuideAttachmentExtension(name: string): string {
  const leaf = name.replace(/\\/g, '/').split('/').at(-1) ?? ''
  const dot = leaf.lastIndexOf('.')
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : ''
}

export function isTaskGuideAttachmentNameAllowed(name: string): boolean {
  const extension = taskGuideAttachmentExtension(name)
  return TASK_GUIDE_ATTACHMENT_EXTENSIONS.some((allowed) => allowed === extension)
}
