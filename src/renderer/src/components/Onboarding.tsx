import { useState, type JSX } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { TextEffect } from '@offgrid/operator-ui/operator/text-effect'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'
import { Badge } from '@offgrid/operator-ui/operator/coss/badge'
import { Card } from '@offgrid/operator-ui/operator/coss/card'
import { SettingRow, StatePill } from '@offgrid/operator-ui/operator/presence'
import { LampContainer } from './ui/lamp'
import { OrbitingCircles } from './ui/orbiting-circles'
import { deviceNoun, isMac } from '@renderer/lib/device'
import { cn } from '@renderer/lib/utils'
import logo from '@/assets/logo.png'
import { QuickConnections } from './QuickConnections'
import { Button } from './ui/button'
import {
  ArrowRight,
  Check,
  ChatCircle,
  Eye,
  Image as ImageIcon,
  Microphone,
  SpeakerHigh,
  FolderOpen,
  CalendarBlank,
  CheckSquare,
  Rewind,
  MagnifyingGlass,
  Graph,
  ShieldCheck,
  Waveform,
  ChatsCircle,
  ClipboardText,
  Devices,
  Files,
  Package,
  Browser,
  CursorClick,
  Cpu,
  Globe
} from '@phosphor-icons/react'

// Word-by-word blur-in, matching the brand's terminal feel. The library's TextEffect owns the
// motion (and drops it under reduced motion); this keeps the step markup reading as before.
function TextGenerate({
  words,
  className,
  delay = 0,
  as = 'div'
}: {
  words: string
  className?: string
  delay?: number
  as?: 'div' | 'h2' | 'p'
}): JSX.Element {
  return (
    <TextEffect as={as} per="word" preset="blur" delay={delay} className={className}>
      {words}
    </TextEffect>
  )
}

interface OnboardingProps {
  onComplete: () => void
}

const steps = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'capabilities', label: 'Models' },
  { id: 'pro', label: 'Pro' },
  { id: 'sync', label: 'Sync' },
  { id: 'connections', label: 'Connect' },
  { id: 'private', label: 'Ready' }
]
const ONBOARDING_STEP_KEY = 'onboarding_step'

function restoredStep(): number {
  const saved = localStorage.getItem(ONBOARDING_STEP_KEY)
  const byId = steps.findIndex((step) => step.id === saved)
  if (byId >= 0) return byId
  // Older versions saved numeric steps. Preserve their private close screen.
  const value = Number(saved)
  return Number.isInteger(value) && value >= 0 && value <= 4 ? (value === 4 ? 5 : value) : 0
}

const ORBIT = [
  { icon: ChatCircle, label: 'Chat' },
  { icon: Eye, label: 'Vision' },
  { icon: ImageIcon, label: 'Image' },
  { icon: Microphone, label: 'Voice' },
  { icon: SpeakerHigh, label: 'Speech' },
  { icon: Browser, label: 'Web Use' },
  { icon: CursorClick, label: 'Computer Use' },
  { icon: FolderOpen, label: 'Projects' }
]

// The Pro layer — every capability described by what it does, on-device.
const PRO_GRID = [
  {
    icon: Rewind,
    label: 'Replay',
    line: 'Rewinds your screen history, so the doc or number you saw last week is a scrub away, not a hunt.'
  },
  {
    icon: Microphone,
    label: 'Meetings',
    line: 'Records and transcribes your calls on-device, so you walk out with the decisions and to-dos already written.'
  },
  {
    icon: CheckSquare,
    label: 'Actions',
    line: 'Gets browser and desktop work done from chat with Web Use and Computer Use, while you can pause or take control.'
  },
  {
    icon: MagnifyingGlass,
    label: 'Memory',
    line: 'One search across everything you have seen, said, and saved, so you never lose a thing twice.'
  },
  {
    icon: Graph,
    label: 'Entities',
    line: 'Builds a record of every person and project on its own, so you walk into any call knowing where you left off.'
  },
  {
    icon: CalendarBlank,
    label: 'Day',
    line: 'Lays out your day from your work and the calendars you connect, so you start oriented instead of scrambling.'
  },
  {
    icon: ShieldCheck,
    label: 'Vault',
    line: `Encrypts passwords, keys, and secret files with a key that never leaves this ${deviceNoun()}, so they stay yours alone.`
  },
  {
    icon: Waveform,
    label: 'Voice',
    line: `Hold ${isMac() ? 'Option' : 'Alt'}+Space and talk - transcribed locally and pasted at your cursor, so you type with your voice anywhere.`
  }
]

const SYNC_GRID = [
  {
    icon: ChatsCircle,
    label: 'Workspace',
    line: 'Chats, projects, messages, tool results, and knowledge stay current.'
  },
  {
    icon: ClipboardText,
    label: 'Copied text',
    line: 'Copy on one device. Paste from another.'
  },
  {
    icon: Files,
    label: 'Files',
    line: 'Screenshots, downloads, generated media, and attachments move directly.'
  },
  {
    icon: Package,
    label: 'Models',
    line: 'See and switch the active Chat, Image, Transcription, Voice, and Computer Use model on a named Desktop.'
  }
]

export function Onboarding({ onComplete }: OnboardingProps): JSX.Element {
  const [currentStep, setCurrentStep] = useState(restoredStep)
  const [connectionBusy, setConnectionBusy] = useState(false)
  const reducedMotion = useReducedMotion()

  const handleNext = (): void => {
    if (currentStep < steps.length - 1) {
      const nextStep = currentStep + 1
      localStorage.setItem(ONBOARDING_STEP_KEY, steps[nextStep]!.id)
      setCurrentStep(nextStep)
    } else {
      localStorage.removeItem(ONBOARDING_STEP_KEY)
      localStorage.setItem('onboarding_completed', 'true')
      onComplete()
    }
  }

  return (
    <div className="fixed inset-0 overflow-hidden font-mono">
      <AnimatePresence mode="wait">
        {/* Step 0 — Welcome */}
        {currentStep === 0 && (
          <motion.div
            key="step-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full w-full bg-neutral-950"
          >
            <LampContainer className="min-h-screen bg-neutral-950">
              <motion.div
                initial={{ opacity: 0.5, y: 100 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.8, ease: 'easeInOut' }}
                className="text-center"
              >
                <img
                  src={logo}
                  alt=""
                  className="mx-auto mb-2 size-16 rounded-2xl shadow-[0_0_48px_-8px_rgb(var(--og-rgb-primary)/0.6)] md:size-20"
                />
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

        {/* Step 1 — One app, every model, all local */}
        {currentStep === 1 && (
          <motion.div
            key="step-1"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="relative h-full w-full"
          >
            <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-6">
              <div className="mb-6 text-center">
                <TextGenerate
                  words={`Choose what runs on your ${deviceNoun()}.`}
                  as="h2"
                  className="text-3xl font-semibold tracking-tight text-white md:text-5xl"
                  delay={0}
                />
                <div className="mt-4">
                  <TextGenerate
                    words="Chat, read images, generate images, transcribe, speak, browse with Web Use, and run Computer Use with local models. Add a model server only when you want one."
                    as="p"
                    className="mx-auto max-w-2xl text-neutral-400"
                    delay={0.4}
                  />
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.6, duration: 0.6 }}
                className="relative flex h-[424px] w-full max-w-[500px] items-center justify-center overflow-hidden"
              >
                <div className="absolute z-10 flex h-24 w-24 items-center justify-center rounded-2xl border border-green-500/30 bg-neutral-900">
                  <img src={logo} alt="Off Grid AI" className="h-12 w-12 rounded-lg" />
                </div>
                <OrbitingCircles radius={110} duration={26} iconSize={56}>
                  {ORBIT.slice(0, 4).map(({ icon: Icon, label }) => (
                    <div
                      key={label}
                      className="flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-xl border border-neutral-800 bg-neutral-900"
                    >
                      <Icon
                        className="h-5 w-5 text-emerald-600 dark:text-emerald-400"
                        weight="regular"
                      />
                      <span className="max-w-full px-0.5 text-center text-[8px] leading-[1.05] text-neutral-500">
                        {label}
                      </span>
                    </div>
                  ))}
                </OrbitingCircles>
                <OrbitingCircles radius={180} duration={32} reverse iconSize={56}>
                  {ORBIT.slice(4).map(({ icon: Icon, label }) => (
                    <div
                      key={label}
                      className="flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-xl border border-neutral-800 bg-neutral-900"
                    >
                      <Icon
                        className="h-5 w-5 text-emerald-600 dark:text-emerald-400"
                        weight="regular"
                      />
                      <span className="max-w-full px-0.5 text-center text-[8px] leading-[1.05] text-neutral-500">
                        {label}
                      </span>
                    </div>
                  ))}
                </OrbitingCircles>
              </motion.div>

              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1 }}
                className="mt-4 text-xs text-neutral-600"
              >
                Chat / Vision / Image / Transcription / Voice / Web Use / Computer Use
              </motion.p>
            </div>
          </motion.div>
        )}

        {/* Step 2 — The Pro layer: it starts remembering */}
        {currentStep === 2 && (
          <motion.div
            key="step-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="relative flex h-full w-full flex-col items-center justify-center bg-neutral-950 px-6"
          >
            <div className="relative z-10 mx-auto max-w-5xl">
              <div className="mb-2 text-center">
                <Badge variant="success">Off Grid AI Pro · live now</Badge>
              </div>
              <div className="mb-3 text-center">
                <TextGenerate
                  words="Then it starts remembering."
                  as="h2"
                  className="text-3xl font-semibold tracking-tight text-white md:text-4xl"
                  delay={0}
                />
              </div>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 }}
                className="mx-auto mb-10 max-w-2xl text-center text-sm text-neutral-400"
              >
                The free app runs models. Pro adds the always-on layer: turn on capture and Off Grid
                AI keeps a private record of what you see and do, then acts on it with your
                approval. Every one runs on-device. Nothing is uploaded.
              </motion.p>

              <AnimatedGroup
                preset="blur-slide"
                className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
              >
                {PRO_GRID.map(({ icon: Icon, label, line }) => (
                  <Card
                    key={label}
                    className="group h-full w-full p-5 transition-colors hover:border-green-500/30"
                  >
                    <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800 transition-colors group-hover:border-green-500/30 group-hover:bg-green-500/10">
                      <Icon
                        className="h-4 w-4 text-neutral-400 transition-colors group-hover:text-emerald-500"
                        weight="regular"
                      />
                    </div>
                    <h3 className="mb-1.5 text-[13px] font-medium text-white">{label}</h3>
                    <p className="text-xs leading-relaxed text-neutral-500">{line}</p>
                  </Card>
                ))}
              </AnimatedGroup>

              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1 }}
                className="mt-8 text-center text-xs text-neutral-600"
              >
                Pro is live now. $119 once or $7.99/month - one license across up to 5 devices.
              </motion.p>
            </div>
          </motion.div>
        )}

        {/* Step 3 - Sync */}
        {currentStep === 3 && (
          <motion.div
            key="step-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="relative flex h-full w-full flex-col items-center justify-center bg-neutral-950 px-6"
          >
            <div className="relative z-10 mx-auto grid w-full max-w-6xl grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(420px,0.95fr)] lg:items-center">
              <div>
                <div className="mb-4 flex items-center gap-2 text-[11px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                  <Devices className="h-4 w-4" weight="regular" />
                  Five-device mesh
                </div>
                <TextGenerate
                  words="Your devices work as one."
                  as="h2"
                  className="text-3xl font-semibold tracking-tight text-white md:text-5xl"
                  delay={0}
                />
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.5 }}
                  className="mt-5 max-w-2xl text-sm leading-6 text-neutral-400"
                >
                  Sync your workspace directly between up to five total devices, including this one.
                  Off Grid AI uses LAN first and Nearby when needed. Traffic is encrypted between
                  paired devices. No Off Grid AI server receives it. In Off Grid AI Mobile, choose a
                  paired Desktop by name. You can use its tools and change its active models.
                </motion.p>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.7 }}
                  className="mt-4 max-w-2xl border-l border-green-500/40 pl-3 text-xs leading-5 text-neutral-500"
                >
                  One Pro license covers the mesh. Pair a licensed device, or enter your license key
                  on this one.
                </motion.p>
              </div>

              <AnimatedGroup preset="blur-slide" className="grid grid-cols-2 gap-3">
                {SYNC_GRID.map(({ icon: Icon, label, line }) => (
                  <Card
                    key={label}
                    className="h-full min-h-36 w-full p-5 transition-colors duration-300 hover:border-green-500/30"
                  >
                    <Icon
                      className="mb-5 h-5 w-5 text-emerald-600 dark:text-emerald-400"
                      weight="regular"
                    />
                    <h3 className="text-[13px] font-medium text-white">{label}</h3>
                    <p className="mt-2 text-xs leading-5 text-neutral-500">{line}</p>
                  </Card>
                ))}
              </AnimatedGroup>
            </div>
          </motion.div>
        )}

        {currentStep === 4 && (
          <motion.div
            key="connections"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full overflow-y-auto px-12 pb-40 pt-10"
          >
            <div className="w-full">
              <div className="mb-10 flex items-center justify-between border-b border-neutral-800 pb-4">
                <div className="flex items-center gap-3">
                  <img src={logo} alt="" className="size-6 object-contain" />
                  <span className="text-xs tracking-widest">OFF GRID AI</span>
                </div>
                <span className="text-xs text-neutral-400">SETUP / 05</span>
              </div>
              <QuickConnections onBusyChange={setConnectionBusy} />
              <p className="mt-5 text-xs text-neutral-400">
                Optional. You can add or change connections in Integrations later.
              </p>
            </div>
          </motion.div>
        )}

        {/* Private close */}
        {currentStep === 5 && (
          <motion.div
            key="step-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="relative flex h-full w-full flex-col items-center justify-center bg-neutral-950 px-6"
          >
            <div className="relative z-10 mx-auto max-w-2xl text-center">
              <TextGenerate
                words="You choose where each model runs."
                as="h2"
                className="text-3xl font-semibold tracking-tight text-white md:text-5xl"
                delay={0}
              />
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.6 }}
                className="mx-auto mt-5 max-w-xl text-neutral-400"
              >
                Local models run in your {`${deviceNoun()}'s`} RAM. A saved model server receives
                prompts only while you select it. Personal Mesh does not copy server API keys to Off
                Grid AI Mobile.
              </motion.p>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 1, duration: 0.5 }}
                className="mx-auto mt-12 max-w-md divide-y divide-border/50 text-left"
              >
                {/* Local is the default and reads on; remote stays a quiet choice. */}
                <SettingRow
                  icon={<Cpu aria-hidden="true" />}
                  title="Local"
                  description={`Runs in your ${deviceNoun()}'s memory.`}
                >
                  <StatePill tone="on" label="Default" />
                </SettingRow>
                <SettingRow
                  icon={<Globe aria-hidden="true" />}
                  title="Remote"
                  description="A model server you add and select."
                >
                  <StatePill tone="off" label="Your choice" />
                </SettingRow>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Navigation */}
      <div
        className={
          currentStep === 4
            ? 'fixed bottom-0 left-0 right-0 z-50 border-t border-neutral-800 bg-neutral-950/80 px-12 py-5 backdrop-blur-xl'
            : 'fixed bottom-12 left-0 right-0 z-50 flex flex-col items-center gap-6'
        }
      >
        <div
          className={
            currentStep === 4
              ? 'flex w-full items-center justify-between'
              : 'flex flex-col items-center gap-6'
          }
        >
          {/* A quiet progress line: thin segments, one gliding emerald pill, the step's name centred below. */}
          <div
            role="progressbar"
            aria-label="Onboarding progress"
            aria-valuemin={1}
            aria-valuemax={steps.length}
            aria-valuenow={currentStep + 1}
            aria-valuetext={`Step ${currentStep + 1} of ${steps.length}: ${steps[currentStep]!.label}`}
            className="flex flex-col items-center gap-2"
          >
            <div className="flex items-center gap-1.5">
              {steps.map(({ label }, index) => (
                <motion.span
                  key={label}
                  layout={!reducedMotion}
                  transition={{ type: 'spring', stiffness: 380, damping: 34 }}
                  className={cn(
                    'relative h-1 overflow-hidden rounded-full bg-neutral-800',
                    index === currentStep ? 'w-8' : 'w-3'
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
                  className="text-xs text-neutral-500"
                >
                  {steps[currentStep]!.label}
                </motion.span>
              </AnimatePresence>
            </span>
          </div>
          <div className="flex items-center gap-3">
            {currentStep === 4 && (
              <Button variant="ghost" disabled={connectionBusy} onClick={handleNext}>
                Skip for now
              </Button>
            )}
            <Button
              onClick={handleNext}
              disabled={currentStep === 4 && connectionBusy}
              className="group"
            >
              <TextMorph as="span" className="text-sm font-medium">
                {currentStep === steps.length - 1 ? 'Start using Off Grid AI' : 'Continue'}
              </TextMorph>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={currentStep === steps.length - 1 ? 'finish' : 'next'}
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
                  {currentStep === steps.length - 1 ? (
                    <Check className="h-4 w-4" weight="bold" />
                  ) : (
                    <ArrowRight
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
