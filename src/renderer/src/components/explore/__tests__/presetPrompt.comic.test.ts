import { expect, it } from 'vitest'
import { ALL_PRESETS } from '../presetCatalog'
import { buildPresetPrompt, initialPresetAnswers } from '../presetPrompt'

const comic = ALL_PRESETS.find((preset) => preset.id === 'comic-book')!
const styles = comic.intake.fields.find((field) => field.id === 'style')!.options!
const formats = comic.intake.fields.find((field) => field.id === 'format')!.options!

it.each(styles.flatMap((style) => formats.map((format) => [style.value, format.value])))(
  'includes only selected comic inputs: %s / %s',
  (style, format) => {
    const prompt = buildPresetPrompt(comic, {
      ...initialPresetAnswers(comic),
      brief: 'A courier returns a letter.',
      style,
      format,
      pages: '17'
    })
    expect(prompt).toContain(`- ${style}:`)
    for (const other of styles.filter((option) => option.value !== style))
      expect(prompt).not.toContain(`- ${other.value}:`)
    for (const other of formats.filter((option) => option.value !== format))
      expect(prompt).not.toContain(other.value)
    expect(prompt).toContain(`A: ${format}`)
    expect(prompt).toContain('A: 17 distinct images')
    expect(prompt).not.toContain('Not provided')
    expect(prompt).not.toContain('Q: Hero reference image')
    expect(prompt).not.toContain('Q: Content and continuity rules')
    expect(prompt).toContain('enhance_prompt set to false')
  }
)

it('keeps supplied comic reference and continuity instructions', () => {
  const prompt = buildPresetPrompt(comic, {
    ...initialPresetAnswers(comic),
    brief: 'A courier.',
    heroReference: '/fixtures/hero.png',
    constraints: 'Keep the red scarf.'
  })
  expect(prompt).toContain('A: /fixtures/hero.png')
  expect(prompt).toContain('A: Keep the red scarf.')
})
