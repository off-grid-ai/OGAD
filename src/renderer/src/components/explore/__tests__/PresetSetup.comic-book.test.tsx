// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PresetSetup } from '../PresetSetup'
import { ALL_PRESETS } from '../presetCatalog'

afterEach(() => cleanup())

describe('<PresetSetup/> comic book action', () => {
  it('shows selectable art previews and submits a bounded image count', () => {
    const submissions: string[] = []
    const preset = ALL_PRESETS.find((item) => item.id === 'comic-book')
    if (!preset) throw new Error('Comic book preset is missing')

    render(
      <PresetSetup
        preset={preset}
        styleThumbs={{
          American_superhero: '/resources/style-thumbs/American_superhero.png',
          Manga: '/resources/style-thumbs/Manga.png'
        }}
        onSubmit={(prompt) => submissions.push(prompt)}
        onCancel={() => undefined}
      />
    )

    expect(screen.getByRole('img', { name: 'Manga' }).getAttribute('src')).toBe(
      'ogcapture:///resources/style-thumbs/Manga.png'
    )
    expect(
      screen.getByRole('button', { name: 'American superhero' }).getAttribute('aria-pressed')
    ).toBe('true')

    fireEvent.change(screen.getByLabelText(/Story brief/), {
      target: { value: 'A courier crosses a flooded moon city.' }
    })
    const length = screen.getByLabelText(/Story length/) as HTMLInputElement
    expect(length.min).toBe('10')
    expect(length.max).toBe('100')
    fireEvent.change(length, { target: { value: '37' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start in chat' }))

    expect(submissions).toHaveLength(1)
    expect(submissions[0]).toContain('A: American superhero')
    expect(submissions[0]).toContain('A: 37 distinct images')
  })

  it('lets the user choose a private local hero reference image', async () => {
    let sourcePath = ''
    window.api = {
      pickImageForGen: async () => '/Users/me/hero.png',
      keepInitImage: async (selected: string) => {
        sourcePath = selected
        return {
          id: 'hero-source',
          path: '/app-data/generated-images/sources/hero-source.png'
        }
      }
    } as unknown as Window['api']
    const preset = ALL_PRESETS.find((item) => item.id === 'comic-book')
    if (!preset) throw new Error('Comic book preset is missing')

    render(<PresetSetup preset={preset} onSubmit={() => undefined} onCancel={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose image' }))

    const preview = await screen.findByRole('img', { name: 'Selected hero reference' })
    expect(sourcePath).toBe('/Users/me/hero.png')
    expect(preview.getAttribute('src')).toBe(
      'ogcapture:///app-data/generated-images/sources/hero-source.png'
    )
    expect((screen.getByLabelText(/Hero reference image/) as HTMLInputElement).value).toBe(
      '/app-data/generated-images/sources/hero-source.png'
    )
  })
})
