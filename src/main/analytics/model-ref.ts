import { CATALOG } from '@offgrid/models'
import { quantOf } from './properties'

export interface ModelRef {
  /** A catalog ID, a public Hugging Face `owner/repo`, or `custom`. */
  model: string
  quant: string | null
}

const HF_REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/

function fileName(value: string): string {
  return value.replace(/\\/g, '/').split('/').at(-1) ?? value
}

/**
 * Turn whatever a runtime knows about its model (a catalog ID, a downloaded repo ID or a file path)
 * into the only names analytics may send. A path never leaves: its file name is matched against the
 * catalog and anything that does not match is `custom`.
 *
 * `allowRepo` is true only for an ID the app itself downloaded from Hugging Face. The desktop app
 * has no Hugging Face token, so every repo it can download is public.
 */
export function modelRef(value: string | null | undefined, allowRepo = false): ModelRef {
  if (!value) return { model: 'custom', quant: null }
  const byId = CATALOG.find((entry) => entry.id === value)
  if (byId) return { model: byId.id, quant: byId.quant ?? quantOf(byId.files[0]?.name) }
  const name = fileName(value)
  const byFile = CATALOG.find((entry) => entry.files.some((file) => file.name === name))
  if (byFile) return { model: byFile.id, quant: byFile.quant ?? quantOf(name) }
  if (allowRepo && HF_REPO.test(value) && !value.includes('..')) {
    return { model: value, quant: quantOf(value) }
  }
  return { model: 'custom', quant: quantOf(name) }
}
