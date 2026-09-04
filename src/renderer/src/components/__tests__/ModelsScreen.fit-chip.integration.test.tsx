// @vitest-environment jsdom

/**
 * The browse fit chip through the REAL ModelsScreen. Only the Electron window.api
 * bridge is faked (a true boundary); the catalog load, the filter/sort pipeline,
 * the real shared fitTier rule, and the card render are all production code. Proves
 * the never-block posture the user sees: on a 16GB Mac a 15GB model is flagged
 * "Won't fit — Load anyway" (past the aggressive ceiling, still loadable), while a
 * small model shows no fit warning — and the SAME 15GB model is comfortable on a
 * 24GB Mac (the verdict is RAM-relative). Neither model is ever hidden.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { modelControlBoundary } from './harness/model-control-snapshot'

interface Entry {
  id: string
  name: string
  kind: string
  org?: string
  params?: number
  files: { name: string; sizeBytes: number }[]
}

const SMALL: Entry = {
  id: 'small',
  name: 'Small Model',
  kind: 'language',
  org: 'acme',
  params: 2,
  files: [{ name: 'small.gguf', sizeBytes: 2_000_000_000 }] // 2GB → easy on 16GB
}
const HUGE: Entry = {
  id: 'huge',
  name: 'Huge Model',
  kind: 'language',
  org: 'acme',
  params: 70,
  files: [{ name: 'huge.gguf', sizeBytes: 15_000_000_000 }] // 15GB
}

// ModelsScreen binds `window.api` at module load, so ONE persistent api object is
// installed before the first import and the RAM value is mutated per test (the
// mount always re-reads systemHealth). This is the correct pattern for this app.
let ramGbValue = 16
const modelControl = modelControlBoundary({ kinds: ['language'], models: [SMALL, HUGE] })
;(window as unknown as { api: unknown }).api = {
  systemHealth: async () => ({ ramGb: ramGbValue }),
  ...modelControl,
  getModelCatalog: async () => ({ kinds: ['language'], models: [SMALL, HUGE] }),
  getInstalledModels: async () => [],
  getActiveModelIds: async () => [],
  getModelVisionStatus: async () => ({}),
  onModelProgress: () => () => {},
  searchModels: async () => [],
  estimateModelFit: async () => ({ level: 'ok', message: '' })
}

const cardFor = (name: string): HTMLElement =>
  screen.getByText(name).closest('[role="listitem"]') as HTMLElement

describe('<ModelsScreen/> — browse fit chip (never-block posture)', () => {
  afterEach(() => cleanup())

  it('flags a 15GB model "Won\'t fit — Load anyway" on a 16GB Mac; no warning on a small one', async () => {
    ramGbValue = 16
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)

    // Both models render (neither is hidden — the never-block rule).
    expect(await screen.findByText('Huge Model')).toBeTruthy()
    expect(screen.getByText('Small Model')).toBeTruthy()

    await waitFor(() =>
      expect(within(cardFor('Huge Model')).getByText(/Won't fit — Load anyway/i)).toBeTruthy()
    )
    expect(within(cardFor('Small Model')).queryByText(/Won't fit|Tight on RAM/i)).toBeNull()
  })

  it('the SAME 15GB model gets no fit warning on a 24GB Mac (verdict is RAM-relative)', async () => {
    // 15GB on 24GB is 62.5% — under the 65% soft budget → "fits", no chip.
    ramGbValue = 24
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)

    await screen.findByText('Huge Model')
    // Let the async systemHealth (24GB) settle, then assert no warning appears.
    await new Promise((r) => setTimeout(r, 60))
    expect(within(cardFor('Huge Model')).queryByText(/Won't fit|Tight on RAM/i)).toBeNull()
  })
})
