import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { saveModelStorageChoice } from './model-storage-choice'

/** Copy first, then switch the profile. A failed copy keeps the old model folder usable. */
export async function moveModelStorage(
  profile: string,
  source: string,
  destination: string
): Promise<{ moved: number; warning?: string }> {
  const from = fs.realpathSync(source)
  const to = fs.realpathSync(destination)
  if (from === to) return { moved: 0 }
  if (to.startsWith(`${from}${path.sep}`) || from.startsWith(`${to}${path.sep}`)) {
    throw new Error('Choose a folder outside the current model folder.')
  }
  if (fs.lstatSync(source).isSymbolicLink()) {
    throw new Error(
      'The current model folder is a link. Leave its files in place or move them yourself.'
    )
  }
  const entries = fs.readdirSync(from)
  const conflicts = entries.filter((name) => fs.existsSync(path.join(to, name)))
  if (conflicts.length) {
    throw new Error(
      `The new folder already contains ${conflicts[0]}. Choose another folder or leave existing files in place.`
    )
  }
  const stage = path.join(to, `.offgrid-model-move-${randomUUID()}`)
  const promoted: string[] = []
  try {
    await fs.promises.mkdir(stage)
    for (const name of entries) {
      await fs.promises.cp(path.join(from, name), path.join(stage, name), {
        recursive: true,
        errorOnExist: true
      })
    }
    for (const name of entries) {
      await fs.promises.rename(path.join(stage, name), path.join(to, name))
      promoted.push(name)
    }
    saveModelStorageChoice(profile, to)
  } catch (error) {
    for (const name of promoted.reverse()) {
      await fs.promises.rename(path.join(to, name), path.join(stage, name)).catch(() => undefined)
    }
    throw error
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => undefined)
  }
  const failed: string[] = []
  for (const name of entries) {
    try {
      await fs.promises.rm(path.join(from, name), { recursive: true, force: true })
    } catch {
      failed.push(name)
    }
  }
  return {
    moved: entries.length,
    ...(failed.length
      ? {
          warning: `The new folder is active, but ${failed.length} old files could not be removed.`
        }
      : {})
  }
}
