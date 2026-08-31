import { useMemo, useState, type FormEvent } from 'react'
import { ArrowLeft, FolderOpen } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import type { DemoPreset, PresetIntakeField } from './presetCatalog'
import { buildPresetPrompt, hasRequiredPresetAnswers, initialPresetAnswers } from './presetPrompt'

interface PresetSetupProps {
  preset: DemoPreset
  onSubmit: (prompt: string) => void
  onCancel: () => void
}

interface IntakeFieldProps {
  field: PresetIntakeField
  value: string
  onChange: (value: string) => void
}

const inputClass =
  'mt-1 w-full rounded-md border border-border bg-background px-2.5 py-2 text-xs text-foreground outline-none transition-colors focus:border-primary'

function IntakeField({ field, value, onChange }: IntakeFieldProps): React.ReactElement {
  const controlId = `preset-field-${field.id}`
  const helpId = `${controlId}-help`
  const chooseFolder = async (): Promise<void> => {
    const selected = await window.api.pickLocalFolder({
      title: field.label,
      ...(value ? { defaultPath: value } : {})
    })
    if (selected) onChange(selected)
  }

  const control = (() => {
    if (field.kind === 'textarea') {
      return (
        <textarea
          id={controlId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          required={field.required}
          aria-describedby={helpId}
          rows={3}
          className={`${inputClass} min-h-20 resize-y`}
        />
      )
    }
    if (field.kind === 'select') {
      return (
        <select
          id={controlId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={field.required}
          aria-describedby={helpId}
          className={inputClass}
        >
          {!value ? <option value="">Choose one</option> : null}
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )
    }
    if (field.kind === 'folder') {
      return (
        <div className="mt-1 flex gap-2">
          <input
            id={controlId}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field.placeholder}
            required={field.required}
            aria-describedby={helpId}
            spellCheck={false}
            className={`${inputClass} mt-0 min-w-0 flex-1`}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void chooseFolder()}
            aria-label={`Browse for ${field.label.toLowerCase()}`}
          >
            <FolderOpen />
            Browse
          </Button>
        </div>
      )
    }
    return (
      <input
        id={controlId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        required={field.required}
        aria-describedby={helpId}
        className={inputClass}
      />
    )
  })()

  return (
    <div className={field.kind === 'textarea' ? '@3xl:col-span-2' : ''}>
      <label
        htmlFor={controlId}
        className="text-[10px] uppercase tracking-wide text-muted-foreground"
      >
        {field.label}
        {field.required ? ' *' : ''}
      </label>
      {control}
      <p id={helpId} className="mt-1 text-[10px] leading-4 text-muted-foreground">
        {field.help}
      </p>
    </div>
  )
}

export function PresetSetup({ preset, onSubmit, onCancel }: PresetSetupProps): React.ReactElement {
  const [answers, setAnswers] = useState<Record<string, string>>(() => initialPresetAnswers(preset))
  const canStart = useMemo(() => hasRequiredPresetAnswers(preset, answers), [answers, preset])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!canStart) return
    onSubmit(buildPresetPrompt(preset, answers))
  }

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-4xl rounded-md border border-border bg-card p-4 text-left text-card-foreground"
      data-testid={`preset-intake-${preset.id}`}
      aria-labelledby={`preset-intake-title-${preset.id}`}
    >
      <div className="mb-4 border-b border-border pb-3">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-primary">
            <preset.icon className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {preset.title}
            </p>
            <h2 id={`preset-intake-title-${preset.id}`} className="mt-0.5 text-sm text-foreground">
              {preset.intake.title}
            </h2>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              {preset.intake.description}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 @3xl:grid-cols-2">
        {preset.intake.fields.map((field) => (
          <IntakeField
            key={field.id}
            field={field}
            value={answers[field.id] ?? ''}
            onChange={(value) => setAnswers((current) => ({ ...current, [field.id]: value }))}
          />
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="text-[10px] text-muted-foreground">* Required before the run starts</span>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            <ArrowLeft />
            Back
          </Button>
          <Button type="submit" size="sm" disabled={!canStart}>
            Start in chat
          </Button>
        </div>
      </div>
    </form>
  )
}
