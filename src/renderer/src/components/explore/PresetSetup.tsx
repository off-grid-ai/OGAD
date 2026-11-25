import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { t, translate } from '@offgrid/i18n'
import {
  ArrowLeft,
  CheckCircle,
  FolderOpen,
  ImageSquare,
  PlugsConnected,
  Sparkle,
  X
} from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Card } from '@offgrid/operator-ui/operator/coss/card'
import { Checkbox } from '@offgrid/operator-ui/operator/animate/checkbox'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { LoadingDots } from '@/components/ui/loading-dots'
import { captureUrlForPath } from '../../../../shared/ogcapture-url'
import type { DemoPreset, PresetIntakeField } from './presetCatalog'
import { buildPresetPrompt, hasRequiredPresetAnswers, initialPresetAnswers } from './presetPrompt'
import { StylePresetPicker } from '../MemoryChat/components/StylePresetPicker'

interface PresetSetupProps {
  preset: DemoPreset
  onSubmit: (prompt: string) => void
  onCancel: () => void
  onOpenConnectors?: () => void
  styleThumbs?: Record<string, string>
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
  styleThumbs: Record<string, string>
}

const inputClass =
  'mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground outline-none transition-[border-color,box-shadow] duration-300 focus:border-primary focus:ring-[3px] focus:ring-primary/15'
const FIELD_LABEL = 'text-[10px] uppercase tracking-widest text-muted-foreground'
const EASE = [0.16, 1, 0.3, 1] as const

/** A field's name inside a sentence: lower-case in English, the translation as it is in other languages. */
function fieldName(label: string): string {
  const shown = translate(label)
  return shown === label ? label.toLowerCase() : shown
}

function IntakeField({
  field,
  value,
  onChange,
  onEnhance,
  enhancing = false,
  enhancementError,
  styleThumbs
}: IntakeFieldProps): React.ReactElement {
  const controlId = `preset-field-${field.id}`
  const reduceMotion = useReducedMotion()
  const labelId = `${controlId}-label`
  const helpId = `${controlId}-help`
  const chooseFolder = async (): Promise<void> => {
    const selected = await window.api.pickLocalFolder({
      title: field.label,
      ...(value ? { defaultPath: value } : {})
    })
    if (selected) onChange(selected)
  }
  const chooseImage = async (): Promise<void> => {
    const selected = await window.api.pickImageForGen()
    if (!selected) return
    const kept = await window.api.keepInitImage(selected)
    if (kept?.path) onChange(kept.path)
  }

  if (field.kind === 'style') {
    const presets = (field.options ?? []).map((option) => ({ name: option.value, prompt: '' }))
    return (
      <div className="@3xl:col-span-2">
        <StylePresetPicker
          activeStyle={value || null}
          presets={presets}
          styleThumbs={styleThumbs}
          onChange={(style) => onChange(style ?? '')}
        />
        <p id={helpId} className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {field.help}
        </p>
      </div>
    )
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
              aria-label={t('Enhance {0} with AI', fieldName(field.label))}
              title="Enhance with local AI"
              className="absolute bottom-2 right-2 text-muted-foreground hover:text-primary disabled:cursor-wait"
            >
              {enhancing ? (
                <span role="status" aria-label="AI enhancement in progress">
                  <LoadingDots size="small" className="px-0" />
                </span>
              ) : (
                <Sparkle className="h-3.5 w-3.5" />
              )}
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
          className="mt-2 grid gap-2.5 @2xl:grid-cols-2"
        >
          {field.options?.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-2 text-xs text-foreground"
            >
              <Checkbox
                checked={selected.has(option.value)}
                onCheckedChange={(checked) => {
                  const next = new Set(selected)
                  if (checked) next.add(option.value)
                  else next.delete(option.value)
                  onChange([...next].join('; '))
                }}
                className="mt-0.5"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      )
    }
    if (field.kind === 'folder') {
      return (
        <div className="mt-2 flex gap-2">
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={() => void chooseFolder()}
                aria-label={t('Browse for {0}', fieldName(field.label))}
              >
                <FolderOpen />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Browse</TooltipContent>
          </Tooltip>
        </div>
      )
    }
    if (field.kind === 'image') {
      return (
        <div className="mt-2 flex gap-3">
          {value ? (
            <img
              src={captureUrlForPath(value)}
              alt="Selected hero reference"
              className="h-16 w-16 shrink-0 rounded-lg border border-border object-cover"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <input
              id={controlId}
              value={value}
              readOnly
              placeholder="No reference image selected"
              aria-describedby={helpId}
              className={`${inputClass} mt-0 min-w-0`}
            />
            <div className="mt-2 flex gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label="Choose image"
                    onClick={() => void chooseImage()}
                  >
                    <ImageSquare />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Choose image</TooltipContent>
              </Tooltip>
              {value ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Clear"
                      onClick={() => onChange('')}
                    >
                      <X />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Clear</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
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
            aria-label={t('Enhance {0} with AI', fieldName(field.label))}
            title="Enhance with local AI"
            className="absolute bottom-1.5 right-1.5 text-muted-foreground hover:text-primary disabled:cursor-wait"
          >
            {enhancing ? (
              <span role="status" aria-label="AI enhancement in progress">
                <LoadingDots size="small" className="px-0" />
              </span>
            ) : (
              <Sparkle className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      )
    }
    return (
      <input
        id={controlId}
        type={field.kind === 'number' ? 'number' : 'text'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        required={field.required}
        min={field.min}
        max={field.max}
        step={field.kind === 'number' ? 1 : undefined}
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
        <p id={labelId} className={FIELD_LABEL}>
          {field.label}
          {field.required ? ' *' : ''}
        </p>
      ) : (
        <label id={labelId} htmlFor={controlId} className={FIELD_LABEL}>
          {field.label}
          {field.required ? ' *' : ''}
        </label>
      )}
      {control}
      <p id={helpId} className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {field.help}
      </p>
      <AnimatePresence initial={false}>
        {enhancementError ? (
          <motion.p
            key="enhancement-error"
            className="mt-1 text-xs leading-relaxed text-destructive"
            role="alert"
            initial={reduceMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.3, ease: EASE }}
          >
            {enhancementError}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export function PresetSetup({
  preset,
  onSubmit,
  onCancel,
  onOpenConnectors,
  styleThumbs = {}
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
  const reduceMotion = useReducedMotion()

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
    const prompt = `${currentValue ? 'Edit this short form answer for clarity.' : 'Create a useful surprise answer for this empty form field.'}

God action: ${preset.title}
Form purpose: ${preset.intake.title}
Form question: ${field.label}
Answer to edit: ${currentValue || '(empty)'}
Other form answers for context:
${context || '(none)'}

${format}
${
  currentValue
    ? 'Preserve the original meaning. Do not invent missing facts.'
    : 'Invent plausible, concrete details that fit this assistant action, the field guidance, and the other answers. Make a clear choice instead of listing options.'
}
Keep the result under 240 characters. Return only the answer.`
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
      const refused =
        /^(?:i\s+(?:cannot|can't|won't)|unable to|sorry[,\s]|i'm sorry)/i.test(enhanced) ||
        /(?:safety guidelines|system prompt|cannot comply)/i.test(enhanced)
      if (refused) {
        setEnhancementError({
          fieldId: field.id,
          message: 'AI enhancement did not return an edited value. Your original text is unchanged.'
        })
      } else if (enhanced) {
        setAnswers((current) => ({ ...current, [field.id]: enhanced }))
      }
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
    // Its own provider: the setup card also renders outside the app shell's provider.
    <TooltipProvider delayDuration={300}>
      <Card className="w-full max-w-4xl text-left">
        <form
          onSubmit={submit}
          className="p-6"
          data-testid={`preset-intake-${preset.id}`}
          aria-labelledby={`preset-intake-title-${preset.id}`}
        >
          <div className="mb-6 flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-primary">
              <preset.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className={FIELD_LABEL}>{preset.title}</p>
              <h2
                id={`preset-intake-title-${preset.id}`}
                className="mt-1.5 text-base text-foreground"
              >
                {preset.intake.title}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-neutral-500">
                {preset.intake.description}
              </p>
            </div>
          </div>

          <AnimatePresence initial={false}>
            {recommendedConnector && connectorReady !== null ? (
              <motion.div
                key="connector"
                className="overflow-hidden"
                initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.4, ease: EASE }}
              >
                <div
                  className={`mb-6 flex items-center gap-3 rounded-lg border px-4 py-3 ${
                    connectorReady ? 'border-green-500/50 bg-green-500/5' : 'border-border'
                  }`}
                >
                  {connectorReady ? (
                    <CheckCircle className="h-4 w-4 shrink-0 text-primary" weight="fill" />
                  ) : (
                    <PlugsConnected className="h-4 w-4 shrink-0 text-primary" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-foreground">
                      {connectorReady
                        ? `${recommendedConnector} is connected`
                        : `Connect ${recommendedConnector} for direct access`}
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
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
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div className="grid gap-x-6 gap-y-5 @3xl:grid-cols-2">
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
                styleThumbs={styleThumbs}
              />
            ))}
          </div>

          <div className="mt-6 flex items-center justify-between gap-3 border-t border-neutral-900 pt-4">
            <span className="text-xs text-muted-foreground">* Required before the run starts</span>
            <div className="flex gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Back"
                    onClick={onCancel}
                  >
                    <ArrowLeft />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Back</TooltipContent>
              </Tooltip>
              <Button type="submit" size="sm" disabled={!canStart || enhancingFieldId !== null}>
                Start in chat
              </Button>
            </div>
          </div>
        </form>
      </Card>
    </TooltipProvider>
  )
}
