import { useState, useEffect } from 'react';
import { motion, AnimatePresence, stagger, useAnimate } from 'motion/react';
import { LampContainer } from './ui/lamp';
import { OrbitingCircles } from './ui/orbiting-circles';
import { StarsBackground } from './ui/stars-background';
import { BorderBeam } from './ui/border-beam';
import { cn } from '@renderer/lib/utils';
import logo from '@/assets/logo.png';
import {
  ArrowRight,
  Check,
  ChatCircle,
  Eye,
  Image as ImageIcon,
  Microphone,
  SpeakerHigh,
  FolderOpen,
  Cpu,
  LockKey,
  Sparkle,
} from '@phosphor-icons/react';

// Word-by-word blur-in, matching the brand's terminal feel.
function TextGenerate({ words, className, delay = 0 }: { words: string; className?: string; delay?: number }) {
  const [scope, animate] = useAnimate();
  const wordsArray = words.split(' ');
  useEffect(() => {
    const timer = setTimeout(() => {
      animate('span', { opacity: 1, filter: 'blur(0px)' }, { duration: 0.4, delay: stagger(0.08) });
    }, delay * 1000);
    return () => clearTimeout(timer);
  }, [animate, delay]);
  return (
    <motion.div ref={scope} className={cn('inline', className)}>
      {wordsArray.map((word, idx) => (
        <motion.span key={word + idx} className="opacity-0 inline-block" style={{ filter: 'blur(8px)' }}>
          {word}
          {idx < wordsArray.length - 1 ? ' ' : ''}
        </motion.span>
      ))}
    </motion.div>
  );
}

function AnimatedNumber({ value, delay = 0 }: { value: number; delay?: number }) {
  const [displayValue, setDisplayValue] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      const steps = 30;
      const increment = value / steps;
      let current = 0;
      const interval = setInterval(() => {
        current += increment;
        if (current >= value) { setDisplayValue(value); clearInterval(interval); }
        else setDisplayValue(Math.floor(current));
      }, 1000 / steps);
      return () => clearInterval(interval);
    }, delay * 1000);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return <span>{displayValue.toLocaleString()}</span>;
}

interface OnboardingProps {
  onComplete: () => void;
}

const steps = [{ id: 'welcome' }, { id: 'capabilities' }, { id: 'private' }];

const ORBIT = [
  { icon: ChatCircle, label: 'Chat' },
  { icon: Eye, label: 'Vision' },
  { icon: ImageIcon, label: 'Image' },
  { icon: Microphone, label: 'Voice' },
  { icon: SpeakerHigh, label: 'Speech' },
  { icon: FolderOpen, label: 'Projects' },
];

export function Onboarding({ onComplete }: OnboardingProps) {
  const [currentStep, setCurrentStep] = useState(0);

  const handleNext = (): void => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      localStorage.setItem('onboarding_completed', 'true');
      onComplete();
    }
  };

  return (
    <div className="fixed inset-0 overflow-hidden bg-neutral-950 font-mono">
      <AnimatePresence mode="wait">
        {/* Step 0 — Welcome */}
        {currentStep === 0 && (
          <motion.div key="step-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full w-full">
            <LampContainer className="min-h-screen bg-neutral-950">
              <motion.div
                initial={{ opacity: 0.5, y: 100 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.8, ease: 'easeInOut' }}
                className="text-center"
              >
                <h1 className="bg-gradient-to-br from-white to-neutral-400 py-4 bg-clip-text text-4xl font-semibold tracking-tight text-transparent md:text-7xl">
                  Off Grid AI
                </h1>
                <p className="mx-auto mt-4 max-w-xl text-lg text-neutral-400">
                  Private AI that runs on <span className="text-green-400">your</span> machine.
                  Your models, your data — <span className="text-green-400">no cloud, no accounts</span>.
                </p>
              </motion.div>
            </LampContainer>
          </motion.div>
        )}

        {/* Step 1 — One app, every model, all local */}
        {currentStep === 1 && (
          <motion.div key="step-1" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="relative h-full w-full bg-neutral-950">
            <StarsBackground className="absolute inset-0 opacity-30" starDensity={0.0002} />
            <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-6">
              <div className="mb-6 text-center">
                <TextGenerate words="One app. Every model. On your Mac." className="text-3xl font-semibold tracking-tight text-white md:text-5xl" delay={0} />
                <div className="mt-4">
                  <TextGenerate words="Download open models and chat, see, draw, listen, and speak — all on-device." className="text-neutral-400" delay={0.4} />
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.6, duration: 0.6 }}
                className="relative flex h-[400px] w-full max-w-[500px] items-center justify-center overflow-hidden"
              >
                <div className="absolute z-10 flex h-24 w-24 items-center justify-center rounded-2xl border border-green-500/30 bg-neutral-900">
                  <img src={logo} alt="Off Grid" className="h-12 w-12 rounded-lg" />
                </div>
                <OrbitingCircles radius={110} duration={26} iconSize={56}>
                  {ORBIT.slice(0, 3).map(({ icon: Icon, label }) => (
                    <div key={label} className="flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-xl border border-neutral-800 bg-neutral-900">
                      <Icon className="h-5 w-5 text-green-400" weight="regular" />
                      <span className="text-[8px] text-neutral-500">{label}</span>
                    </div>
                  ))}
                </OrbitingCircles>
                <OrbitingCircles radius={180} duration={32} reverse iconSize={56}>
                  {ORBIT.slice(3).map(({ icon: Icon, label }) => (
                    <div key={label} className="flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-xl border border-neutral-800 bg-neutral-900">
                      <Icon className="h-5 w-5 text-green-400" weight="regular" />
                      <span className="text-[8px] text-neutral-500">{label}</span>
                    </div>
                  ))}
                </OrbitingCircles>
              </motion.div>

              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1 }} className="mt-4 text-xs text-neutral-600">
                Text · Vision · Image · Voice · Speech — one local gateway
              </motion.p>
            </div>
          </motion.div>
        )}

        {/* Step 2 — Private + grows with you */}
        {currentStep === 2 && (
          <motion.div key="step-2" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="relative flex h-full w-full flex-col items-center justify-center bg-neutral-950 px-6">
            <StarsBackground className="absolute inset-0 opacity-20" starDensity={0.0002} />
            <div className="relative z-10 mx-auto max-w-4xl">
              <div className="mb-14 text-center">
                <TextGenerate words="Yours, and only yours." className="text-3xl font-semibold tracking-tight text-white md:text-4xl" delay={0} />
              </div>

              <div className="grid gap-6 md:grid-cols-3">
                {[
                  { icon: Cpu, title: 'Run anything locally', body: 'Download the latest open models — text, vision, image, voice, speech — and run them through one local gateway. No API keys.' },
                  { icon: LockKey, title: 'Truly private', body: 'Nothing leaves your device. No cloud, no telemetry, no account. Your conversations and files stay on your machine.' },
                  { icon: Sparkle, title: 'Never forgets', body: 'Pro lands July 2026: always on, it remembers everything you see and do, makes it instantly findable with unified search, and a proactive secretary surfaces what matters and acts for you. Join early access — or pay now for lifetime free + first access.', pro: true },
                ].map(({ icon: Icon, title, body, pro }, i) => (
                  <motion.div
                    key={title}
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 + i * 0.2, duration: 0.5 }}
                    className="group relative overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/50 p-8"
                  >
                    <BorderBeam duration={8} size={80} className={cn('opacity-0 transition-opacity group-hover:opacity-40', pro ? 'from-transparent via-green-500 to-transparent' : 'from-transparent via-neutral-700 to-transparent')} />
                    {pro && <span className="absolute right-4 top-4 rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-green-400">Pro</span>}
                    <div className={cn('mb-6 flex h-12 w-12 items-center justify-center rounded-xl border', pro ? 'border-green-500/30 bg-green-500/10' : 'border-neutral-700 bg-neutral-800')}>
                      <Icon className={cn('h-5 w-5', pro ? 'text-green-400' : 'text-neutral-400')} weight="regular" />
                    </div>
                    <h3 className="mb-3 text-lg font-medium text-white">{title}</h3>
                    <p className="text-sm leading-relaxed text-neutral-500">{body}</p>
                  </motion.div>
                ))}
              </div>

              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1, duration: 0.5 }} className="mt-12 flex items-center justify-center gap-12">
                <div className="text-center">
                  <div className="text-3xl font-light text-green-400"><AnimatedNumber value={100} delay={1.2} />%</div>
                  <div className="mt-1 text-xs uppercase tracking-wider text-neutral-600">Local</div>
                </div>
                <div className="h-8 w-px bg-neutral-800" />
                <div className="text-center">
                  <div className="text-3xl font-light text-white"><AnimatedNumber value={0} delay={1.3} /></div>
                  <div className="mt-1 text-xs uppercase tracking-wider text-neutral-600">Cloud</div>
                </div>
                <div className="h-8 w-px bg-neutral-800" />
                <div className="text-center">
                  <div className="text-3xl font-light tabular-nums text-white">∞</div>
                  <div className="mt-1 text-xs uppercase tracking-wider text-neutral-600">Private</div>
                </div>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Navigation */}
      <div className="fixed bottom-12 left-0 right-0 z-50 flex flex-col items-center gap-6">
        <div className="flex gap-2">
          {steps.map((_, idx) => (
            <motion.div
              key={idx}
              initial={false}
              animate={{ width: currentStep === idx ? 24 : 6, backgroundColor: currentStep === idx ? 'rgb(52 211 153)' : 'rgb(64 64 64)' }}
              className="h-1 rounded-full"
              transition={{ duration: 0.3 }}
            />
          ))}
        </div>
        <motion.button
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          onClick={handleNext}
          className="group flex items-center gap-2 rounded-full border border-green-500/40 bg-green-600/90 px-8 py-3 text-white transition-all duration-200 hover:bg-green-500"
        >
          <span className="text-sm font-medium">{currentStep === steps.length - 1 ? 'Start using Off Grid' : 'Continue'}</span>
          {currentStep === steps.length - 1 ? <Check className="h-4 w-4" weight="bold" /> : <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" weight="bold" />}
        </motion.button>
      </div>
    </div>
  );
}
