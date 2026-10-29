import type { ConfirmDialogOptions, NoticeDialogOptions } from './confirm-dialog'

// The text of every confirm and notice dialog, in one place so wording stays consistent.

const DELETE_LABEL = 'Delete'

export const DELETE_PROJECT_DIALOG: ConfirmDialogOptions = {
  title: 'Delete this project?',
  description:
    'Its knowledge base and generated artifacts are deleted too. Its chats stay in Chat.',
  confirmLabel: DELETE_LABEL,
  destructive: true
}

export function deleteModelDialog(label: string): ConfirmDialogOptions {
  return {
    title: `Delete "${label}"?`,
    description: 'This removes its files from disk.',
    confirmLabel: DELETE_LABEL,
    destructive: true
  }
}

/** A model found in another app's folder goes to the Trash rather than being deleted. */
export function trashExternalModelDialog(label: string): ConfirmDialogOptions {
  return {
    title: `Move "${label}" to the Trash?`,
    description: "Its files are in another app's folder; you can restore them from the Trash.",
    confirmLabel: 'Move to Trash',
    destructive: true
  }
}

export function modelRemoveFailedNotice(label: string, error: string): NoticeDialogOptions {
  return { title: `Couldn't remove "${label}"`, description: error }
}

export function modelImportFailedNotice(error: string): NoticeDialogOptions {
  return { title: 'Import failed', description: error }
}

/** The model may not fit this machine's memory; `fitMessage` says why. */
export function loadModelAnywayDialog(fitMessage: string): ConfirmDialogOptions {
  return { title: 'Load it anyway?', description: fitMessage, confirmLabel: 'Load anyway' }
}

export function clearDataCategoryDialog(params: {
  readonly categoryLabel: string
  readonly olderThanDays?: number
}): ConfirmDialogOptions {
  const category = params.categoryLabel.toLowerCase()
  const what = params.olderThanDays
    ? `${category} older than ${params.olderThanDays} days`
    : `all ${category}`
  return {
    title: `Delete ${what}?`,
    description: "This permanently removes it from this device and can't be undone.",
    confirmLabel: DELETE_LABEL,
    destructive: true
  }
}

export const DELETE_ALL_DATA_DIALOG: ConfirmDialogOptions = {
  title: 'Delete ALL your data?',
  description:
    'Chats, memory, captures, meetings, and generated images. This cannot be undone. Installed models are kept.',
  confirmLabel: 'Delete all',
  destructive: true
}

export const DELETE_ALL_DATA_RECONFIRM_DIALOG: ConfirmDialogOptions = {
  title: 'Are you absolutely sure?',
  description: 'This permanently erases your personal data on this device.',
  confirmLabel: 'Erase everything',
  destructive: true
}
