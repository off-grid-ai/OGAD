import type { DemoPreset } from './presetCatalog'

export type PresetAnswers = Readonly<Record<string, string>>

export function initialPresetAnswers(preset: DemoPreset): Record<string, string> {
  return Object.fromEntries(
    preset.intake.fields.map((field) => [field.id, field.defaultValue ?? ''])
  )
}

export function hasRequiredPresetAnswers(preset: DemoPreset, answers: PresetAnswers): boolean {
  return preset.intake.fields.every(
    (field) => !field.required || Boolean((answers[field.id] ?? '').trim())
  )
}

/**
 * Build the one user-approved message that starts a curated run.
 *
 * The catalog owns both the questions and the execution contract. This serializer only joins
 * them, so the renderer never invents prompt policy and every Explore placement sends the same
 * complete brief.
 */
export function buildPresetPrompt(preset: DemoPreset, answers: PresetAnswers): string {
  const approvedInputs = preset.intake.fields.flatMap((field) => {
    const value = (answers[field.id] ?? '').trim() || 'Not provided'
    return [`Q: ${field.label}`, `A: ${value}`, '']
  })

  return [
    preset.prompt.trim(),
    '',
    'User-approved inputs:',
    ...approvedInputs,
    'All required inputs are supplied above. Do not repeat these questions. Begin the run now.'
  ]
    .join('\n')
    .trim()
}
