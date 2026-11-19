import { useCallback, useEffect, useState, type JSX } from 'react'
import { t } from '@offgrid/i18n'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import type { OnboardingGroupId } from '@offgrid/features'
import { LampContainer } from './ui/lamp'
import { deviceNoun } from '@renderer/lib/device'
import { cn } from '@renderer/lib/utils'
import type { ViewMode } from '@renderer/lib/view-modes'
import logo from '@/assets/logo.png'
import { Button } from './ui/button'
import { analyticsBridge } from '@renderer/lib/analytics'
import { ArrowRightIcon, CheckIcon, LockSimpleIcon } from '@phosphor-icons/react'
import { FeaturesStep, GroupsStep } from './onboarding/PickSteps'
import { GuideStep } from './onboarding/GuideStep'
import { LanguageSelect } from './LanguageSettingsSection'
import {
  ONBOARDING_OPEN_KEY,
  clearPicks,
  loadPicks,
  savePicks,
  toggleGroup,
  togglePart,
  type Picks
} from './onboarding/picks'

interface OnboardingProps {
  onComplete: () => void
}

const steps = [{ id: 'welcome' }, { id: 'groups' }, { id: 'features' }, { id: 'guide' }] as const
// Read when shown, so the label is in the app language (text in code reaches a catalog through t()).
const stepLabel = (id: (typeof steps)[number]['id']): string =>
  ({ welcome: t('Welcome'), groups: t('What you want'), features: t('The details'), guide: t('How it works') })[id]
type StepId = (typeof steps)[number]['id']

const ONBOARDING_STEP_KEY = 'onboarding_step'

/** Steps saved by older versions resume at the step that now holds what they showed. */
const OLDER_STEPS: Record<string, StepId> = {
  capabilities: 'groups',
  pro: 'groups',
  sync: 'features',
  connections: 'guide',
  private: 'guide'
}

function restoredStep(): number {
  const saved = localStorage.getItem(ONBOARDING_STEP_KEY) ?? ''
  const id = OLDER_STEPS[saved] ?? saved
  const byId = steps.findIndex((step) => step.id === id)
  if (byId >= 0) return byId
  // The oldest versions saved numbers: 1-3 were the pitch, 4 the private close.
  const value = Number(saved)
  if (!Number.isInteger(value) || value <= 0) return 0
  return value >= 4 ? 3 : 1
}

const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 }
}

export function Onboarding({ onComplete }: OnboardingProps): JSX.Element {
  const [currentStep, setCurrentStep] = useState(restoredStep)
  // The furthest step reached: Forward (Cmd+]) goes back up to it, never past it.
  const [reached, setReached] = useState(restoredStep)
  const [picks, setPicks] = useState<Picks>(loadPicks)
  const [connectionBusy, setConnectionBusy] = useState(false)
  // Opt-in analytics: unticked unless the user ticks it.
  const [shareAnalytics, setShareAnalytics] = useState(false)
  const reducedMotion = useReducedMotion()
  const last = steps.length - 1
  const stepId = steps[currentStep]!.id

  const goTo = useCallback((index: number): void => {
    localStorage.setItem(ONBOARDING_STEP_KEY, steps[index]!.id)
    setCurrentStep(index)
    setReached((r) => Math.max(r, index))
  }, [])

  const updatePicks = (next: Picks): void => {
    setPicks(next)
    savePicks(next)
  }

  const finish = (open?: ViewMode): void => {
    localStorage.removeItem(ONBOARDING_STEP_KEY)
    localStorage.setItem('onboarding_completed', 'true')
    if (open) localStorage.setItem(ONBOARDING_OPEN_KEY, open)
    // Either answer counts as asked, so no prompt asks again soon.
    if (shareAnalytics) {
      // What was picked goes with the opt-in, once consent is on.
      void Promise.resolve(analyticsBridge()?.optIn?.('setup')).then(() =>
        analyticsBridge()?.capture?.('onboarding_picks', {
          groups: picks.groups.join(','),
          features: picks.parts.join(',')
        })
      )
    } else void analyticsBridge()?.dismissPrompt?.()
    onComplete()
  }

  // Skip: no picks, so model setup does what it did before onboarding asked. Analytics was not
  // asked, so the app's own prompt asks later.
  const skip = (): void => {
    clearPicks()
    localStorage.removeItem(ONBOARDING_STEP_KEY)
    localStorage.setItem('onboarding_completed', 'true')
    onComplete()
  }

  const next = (): void => {
    if (currentStep < last) goTo(currentStep + 1)
    else finish()
  }

  // Every step is a route: Cmd+[ goes back, Cmd+] goes forward to a step already reached.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '[' && currentStep > 0) {
        e.preventDefault()
        goTo(currentStep - 1)
      } else if (e.key === ']' && currentStep < reached) {
        e.preventDefault()
        goTo(currentStep + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentStep, reached, goTo])

  const nextLabel =
    stepId === 'features'
      ? t('Show me how it works')
      : stepId === 'guide'
        ? t('Set up my models')
        : t('Continue')
  const nothingPicked =
    (stepId === 'groups' && picks.groups.length === 0) ||
    (stepId === 'features' && picks.parts.length === 0)

  return (
    <div className="fixed inset-0 overflow-hidden">
      <AnimatePresence mode="wait">
        {stepId === 'welcome' && (
          <motion.div key="welcome" {...fade} className="relative h-full w-full bg-neutral-950">
            {/* The language, set to the computer's; the same list as Settings → Language. */}
            <div className="absolute right-6 top-6 z-10 w-48">
              <LanguageSelect id="onboarding-language" />
            </div>
            <LampContainer className="min-h-screen bg-neutral-950">
              <motion.div
                initial={{ opacity: 0.5, y: 100 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.8, ease: 'easeInOut' }}
                className="text-center"
              >
                <div className="mx-auto mb-2 flex size-16 items-center justify-center rounded-2xl border border-green-500/30 bg-neutral-900 shadow-[0_0_48px_-8px_rgb(var(--og-rgb-primary)/0.6)] md:size-20">
                  <img src={logo} alt="" className="size-9 md:size-11" />
                </div>
                <h1 className="bg-gradient-to-br from-white to-neutral-400 py-4 bg-clip-text text-4xl font-semibold tracking-tight text-transparent md:text-7xl">
                  Off Grid AI
                </h1>
                <p className="mx-auto mt-4 max-w-xl text-lg text-neutral-400">
                  Your AI workspace starts on{' '}
                  <span className="text-emerald-600 dark:text-emerald-400">your</span>{' '}
                  {deviceNoun()}. Local models and your data need no Off Grid AI cloud or account.
                </p>
              </motion.div>
            </LampContainer>
          </motion.div>
        )}

        {stepId === 'groups' && (
          <motion.div
            key="groups"
            {...fade}
            className="flex h-full w-full flex-col overflow-y-auto px-12 pb-32 pt-12"
          >
            <GroupsStep
              picks={picks}
              onToggle={(id: OnboardingGroupId) => updatePicks(toggleGroup(picks, id))}
            />
          </motion.div>
        )}

        {stepId === 'features' && (
          <motion.div
            key="features"
            {...fade}
            className="flex h-full w-full flex-col overflow-y-auto px-12 pb-32 pt-12"
          >
            <FeaturesStep picks={picks} onToggle={(id) => updatePicks(togglePart(picks, id))} />
          </motion.div>
        )}

        {stepId === 'guide' && (
          <motion.div key="guide" {...fade} className="h-full w-full px-12 pb-28 pt-12">
            <GuideStep
              picks={picks}
              shareAnalytics={shareAnalytics}
              onShareAnalytics={setShareAnalytics}
              onConnectionBusy={setConnectionBusy}
              onOpen={(view) => finish(view)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Navigation */}
      <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background/80 px-12 py-4 backdrop-blur-xl">
        <div className="flex w-full items-center justify-between gap-6">
          <p className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
            <LockSimpleIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Everything runs on your {deviceNoun()}. Nothing leaves it.
          </p>
          {/* A quiet progress line: thin segments, one gliding emerald pill, the step's name below. */}
          <div
            role="progressbar"
            aria-label="Onboarding progress"
            aria-valuemin={1}
            aria-valuemax={steps.length}
            aria-valuenow={currentStep + 1}
            aria-valuetext={`Step ${currentStep + 1} of ${steps.length}: ${stepLabel(steps[currentStep]!.id)}`}
            className="flex flex-col items-center gap-2"
          >
            <div className="flex items-center gap-1.5">
              {steps.map(({ id }, index) => (
                <motion.span
                  key={id}
                  layout={!reducedMotion}
                  transition={{ type: 'spring', stiffness: 380, damping: 34 }}
                  className={cn(
                    'relative h-1 overflow-hidden rounded-full bg-border',
                    index === currentStep ? 'w-10' : 'w-6'
                  )}
                >
                  {index < currentStep && <span className="absolute inset-0 bg-primary/45" />}
                  {index === currentStep && (
                    <motion.span
                      layoutId={reducedMotion ? undefined : 'onboarding-step'}
                      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
                      className="absolute inset-0 rounded-full bg-primary shadow-[0_0_10px_rgb(var(--og-rgb-primary)/0.75)]"
                    />
                  )}
                </motion.span>
              ))}
            </div>
            <span className="grid h-4 place-items-center">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={currentStep}
                  aria-hidden
                  initial={reducedMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reducedMotion ? undefined : { opacity: 0, y: -4 }}
                  transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                  className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
                >
                  {stepLabel(steps[currentStep]!.id)}
                </motion.span>
              </AnimatePresence>
            </span>
          </div>
          <div className="flex items-center gap-3">
            {currentStep > 0 && (
              <Button
                variant="ghost"
                disabled={connectionBusy}
                onClick={() => goTo(currentStep - 1)}
              >
                Back
              </Button>
            )}
            {(stepId === 'groups' || stepId === 'features') && (
              <Button variant="ghost" onClick={skip}>
                Skip, set it up
              </Button>
            )}
            <Button onClick={next} disabled={connectionBusy || nothingPicked} className="group">
              <TextMorph as="span" className="text-sm font-medium">
                {nextLabel}
              </TextMorph>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={currentStep === last ? 'finish' : 'next'}
                  className="flex"
                  initial={reducedMotion ? false : { opacity: 0, scale: 0.5, rotate: -30 }}
                  animate={{ opacity: 1, scale: 1, rotate: 0 }}
                  exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, rotate: 30 }}
                  transition={
                    reducedMotion
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 500, damping: 28 }
                  }
                >
                  {currentStep === last ? (
                    <CheckIcon className="h-4 w-4" weight="bold" />
                  ) : (
                    <ArrowRightIcon
                      className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                      weight="bold"
                    />
                  )}
                </motion.span>
              </AnimatePresence>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
