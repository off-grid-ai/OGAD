// @vitest-environment jsdom
// The Video tab on a 36 GB Mac, from the real catalog's video entries (Off Grid AI's builds beside
// the same models from other sources). The picks name Off Grid AI's build of each model: BEST is
// Off Grid AI's Wan 2.2, not the Wan AI copy of the same model listed under it.
import { afterEach, beforeAll, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { CATALOG } from '@offgrid/models'

;(window as unknown as { api: unknown }).api = {
  isPro: true,
  systemHealth: async () => ({ ramGb: 36 }),
  getModelCatalog: async () => ({
    kinds: ['text', 'video'],
    memoryGb: 36,
    models: CATALOG.filter((model) => model.kind === 'video')
  }),
  getInstalledModels: async () => [],
  getActiveModelIds: async () => [],
  getModelVisionStatus: async () => ({}),
  onModelProgress: () => () => {}
}

let ModelsScreen: typeof import('../ModelsScreen').ModelsScreen
// Imported after the boundary is in place; the screen's module graph is large, so a loaded run
// needs longer than the 10 s hook default to load it.
beforeAll(async () => {
  ModelsScreen = (await import('../ModelsScreen')).ModelsScreen
}, 60_000)
afterEach(cleanup)

/** The card a badge sits on: the nearest block that holds the model's name and its maker. */
function cardOf(badge: HTMLElement): HTMLElement {
  let node: HTMLElement | null = badge
  while (node && !/ · \d/.test(node.textContent ?? '')) node = node.parentElement
  return node!
}

it('names Off Grid AI’s build of each model as the pick, BEST on its Wan 2.2', async () => {
  render(<ModelsScreen navigationSubroute="video" />)
  // The badge reads BEST on screen (uppercase by style); its text is "Best".
  const best = await screen.findByText('Best', {}, { timeout: 5000 })
  const card = cardOf(best)
  expect(within(card).getByText('Wan 2.2 (5B)')).toBeTruthy()
  expect(card.textContent).toContain('Off Grid AI')
  expect(card.textContent).not.toContain('Wan AI')
  // The other source's copy of Wan 2.2 is listed, without a pick.
  const other = await screen.findByText(/^Wan 2\.2 \(5B\), Q5_K_M$/)
  expect(cardOf(other).textContent).not.toMatch(/Best|Balanced|Fast/)
})
