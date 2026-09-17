import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowLeft, CheckCircle, FolderOpen, PlugsConnected, Sparkle } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import type { DemoPreset, PresetIntakeField } from './presetCatalog'
import { buildPresetPrompt, hasRequiredPresetAnswers, initialPresetAnswers } from './presetPrompt'

interface PresetSetupProps {
  preset: DemoPreset
  onSubmit: (prompt: string) => void
  onCancel: () => void
  onOpenConnectors?: () => void
}

interface ConnectorSummary {
  name: string
  status: string
}

interface IntakeFieldProps {
  field: PresetIntakeField
  value: string
  onChange: (value: string) => void
  onEnhance?: () => void
  enhancing?: boolean
  enhancementError?: string
}

const inputClass =
  'mt-1 w-full rounded-md border border-border bg-background px-2.5 py-2 text-xs text-foreground outline-none transition-colors focus:border-primary'

function IntakeField({
  field,
  value,
  onChange,
  onEnhance,
  enhancing = false,
  enhancementError
}: IntakeFieldProps): React.ReactElement {
  const controlId = `preset-field-${field.id}`
  const labelId = `${controlId}-label`
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
        <div className="relative">
          <textarea
            id={controlId}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field.placeholder}
            required={field.required}
            aria-describedby={helpId}
            rows={3}
            className={`${inputClass} min-h-20 ${onEnhance ? 'resize-none pb-8 pr-9' : 'resize-y'}`}
          />
          {onEnhance ? (
            <Button
              type="button"
              onClick={onEnhance}
              disabled={enhancing}
              variant="ghost"
              size="icon-xs"
              aria-label={`Enhance ${field.label.toLowerCase()} with AI`}
              title="Enhance with local AI"
              className="absolute bottom-2 right-2 text-muted-foreground hover:text-primary disabled:cursor-wait"
            >
              <Sparkle className={`h-3.5 w-3.5 ${enhancing ? 'animate-pulse text-primary' : ''}`} />
            </Button>
          ) : null}
        </div>
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
    if (field.kind === 'checkboxes') {
      const selected = new Set(
        value
          .split(';')
          .map((item) => item.trim())
          .filter(Boolean)
      )
      return (
        <div
          id={controlId}
          role="group"
          aria-labelledby={labelId}
          aria-describedby={helpId}
          className="mt-1 grid gap-2 rounded-md border border-border bg-background p-3 @2xl:grid-cols-2"
        >
          {field.options?.map((option) => (
            <label
              key={option.value}
              className="flex items-start gap-2 text-[11px] text-foreground"
            >
              <input
                type="checkbox"
                checked={selected.has(option.value)}
                onChange={(event) => {
                  const next = new Set(selected)
                  if (event.target.checked) next.add(option.value)
                  else next.delete(option.value)
                  onChange([...next].join('; '))
                }}
                className="mt-0.5 accent-primary"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
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
    if (onEnhance) {
      return (
        <div className="relative">
          <input
            id={controlId}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field.placeholder}
            required={field.required}
            aria-describedby={helpId}
            className={`${inputClass} pr-9`}
          />
          <Button
            type="button"
            onClick={onEnhance}
            disabled={enhancing}
            variant="ghost"
            size="icon-xs"
            aria-label={`Enhance ${field.label.toLowerCase()} with AI`}
            title="Enhance with local AI"
            className="absolute bottom-1.5 right-1.5 text-muted-foreground hover:text-primary disabled:cursor-wait"
          >
            <Sparkle className={`h-3.5 w-3.5 ${enhancing ? 'animate-pulse text-primary' : ''}`} />
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
    <div
      className={field.kind === 'textarea' || field.kind === 'checkboxes' ? '@3xl:col-span-2' : ''}
    >
      {field.kind === 'checkboxes' ? (
        <p id={labelId} className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {field.label}
          {field.required ? ' *' : ''}
        </p>
      ) : (
        <label
          id={labelId}
          htmlFor={controlId}
          className="text-[10px] uppercase tracking-wide text-muted-foreground"
        >
          {field.label}
          {field.required ? ' *' : ''}
        </label>
      )}
      {control}
      <p id={helpId} className="mt-1 text-[10px] leading-4 text-muted-foreground">
        {field.help}
      </p>
      {enhancementError ? (
        <p className="mt-1 text-[10px] leading-4 text-destructive" role="alert">
          {enhancementError}
        </p>
      ) : null}
    </div>
  )
}

export function PresetSetup({
  preset,
  onSubmit,
  onCancel,
  onOpenConnectors
}: PresetSetupProps): React.ReactElement {
  const [answers, setAnswers] = useState<Record<string, string>>(() => initialPresetAnswers(preset))
  const [enhancingFieldId, setEnhancingFieldId] = useState<string | null>(null)
  const [enhancementError, setEnhancementError] = useState<{
    fieldId: string
    message: string
  } | null>(null)
  const [connectorReady, setConnectorReady] = useState<boolean | null>(null)
  const canStart = useMemo(() => hasRequiredPresetAnswers(preset, answers), [answers, preset])
  const recommendedConnector = preset.intake.recommendedConnector

  const enhanceField = async (field: PresetIntakeField): Promise<void> => {
    if (enhancingFieldId) return
    setEnhancingFieldId(field.id)
    setEnhancementError(null)
    const currentValue = answers[field.id]?.trim() ?? ''
    const context = preset.intake.fields
      .filter((item) => item.id !== field.id && answers[item.id]?.trim())
      .map((item) => `${item.label}: ${answers[item.id]?.trim() ?? ''}`)
      .join('\n')
    const format =
      field.id === 'topic'
        ? 'Write one clear, specific learning goal in one short sentence.'
        : field.id === 'relatedTopics'
          ? 'Write 3 to 6 specific adjacent concepts as a comma-separated list.'
          : field.id === 'avoid'
            ? 'Write a concise comma-separated list of low-signal topics, formats, or source traits to exclude. Do not invent named creators.'
            : `Rewrite the value so it is clear, specific, concise, and suitable for "${field.label}". Follow this field guidance: ${field.help}`
    const prompt = `Improve one field in an Assistant workflow.

Field: ${field.label}
Current value: ${currentValue || '(empty)'}
Other approved settings:
${context || '(none)'}

${format}
Preserve the user's intent. Do not invent missing facts or add actions, permissions, platforms, creators, hashtags, or commentary. Keep the result under 240 characters. Return only the replacement field value.`
    try {
      const result = await window.api.ragChat(
        prompt,
        undefined,
        [],
        null,
        undefined,
        true,
        undefined,
        false
      )
      const enhanced = result.answer
        .trim()
        .replace(/^```(?:text)?\s*/i, '')
        .replace(/\s*```$/, '')
        .replace(/^['"]|['"]$/g, '')
        .trim()
        .slice(0, 240)
      if (enhanced) setAnswers((current) => ({ ...current, [field.id]: enhanced }))
    } catch {
      setEnhancementError({
        fieldId: field.id,
        message: 'AI enhancement is unavailable. You can keep editing this field.'
      })
    } finally {
      setEnhancingFieldId(null)
    }
  }

  useEffect(() => {
    if (!recommendedConnector) return
    let cancelled = false
    const listConnectors = window.api.mcpList
    const connectorsRequest =
      typeof listConnectors === 'function' ? listConnectors() : Promise.resolve([])
    void connectorsRequest
      .then((connectors) => {
        if (cancelled) return
        const match = (connectors as ConnectorSummary[]).find(
          (connector) => connector.name.toLowerCase() === recommendedConnector.toLowerCase()
        )
        setConnectorReady(Boolean(match && match.status === 'ok'))
      })
      .catch(() => {
        if (!cancelled) setConnectorReady(false)
      })
    return () => {
      cancelled = true
    }
  }, [recommendedConnector])

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

      {recommendedConnector && connectorReady !== null ? (
        <div className="mb-4 flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2.5">
          {connectorReady ? (
            <CheckCircle className="h-4 w-4 shrink-0 text-primary" weight="fill" />
          ) : (
            <PlugsConnected className="h-4 w-4 shrink-0 text-primary" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-foreground">
              {connectorReady
                ? `${recommendedConnector} is connected`
                : `Connect ${recommendedConnector} for direct access`}
            </p>
            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              {connectorReady
                ? `Off Grid AI can use ${recommendedConnector} to find the right item.`
                : 'You can continue without it. Off Grid AI will use Computer Use instead.'}
            </p>
          </div>
          {!connectorReady && onOpenConnectors ? (
            <Button type="button" size="sm" variant="outline" onClick={onOpenConnectors}>
              Connect
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3 @3xl:grid-cols-2">
        {preset.intake.fields.map((field) => (
          <IntakeField
            key={field.id}
            field={field}
            value={answers[field.id] ?? ''}
            onChange={(value) => setAnswers((current) => ({ ...current, [field.id]: value }))}
            onEnhance={
              field.kind === 'text' || field.kind === 'textarea'
                ? () => void enhanceField(field)
                : undefined
            }
            enhancing={enhancingFieldId === field.id}
            enhancementError={
              enhancementError?.fieldId === field.id ? enhancementError.message : undefined
            }
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
          <Button type="submit" size="sm" disabled={!canStart || enhancingFieldId !== null}>
            Start in chat
          </Button>
        </div>
      </div>
    </form>
  )
}
