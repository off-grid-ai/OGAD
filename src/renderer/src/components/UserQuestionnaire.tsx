import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { StarsBackground } from './ui/stars-background';
import { BorderBeam } from './ui/border-beam';
import { cn } from '@renderer/lib/utils';
import { ArrowLeft, ArrowRight } from '@phosphor-icons/react';

// Types
interface UserProfile {
    role?: string;
    companySize?: string;
    aiUsageFrequency?: string;
    primaryTools?: string[];
    painPoints?: string[];
    primaryUseCase?: string;
    privacyConcern?: string;
    expectedBenefit?: string;
    referralSource?: string;
}

interface QuestionnaireProps {
    onComplete: (profile: UserProfile) => void;
    onSkip?: () => void;
}

// Animated text reveal
function TextReveal({ children, delay = 0 }: { children: string; delay?: number }) {
    const words = children.split(' ');

    return (
        <span>
            {words.map((word, i) => (
                <motion.span
                    key={i}
                    className="inline-block mr-[0.3em]"
                    initial={{ opacity: 0, filter: 'blur(8px)', y: 10 }}
                    animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
                    transition={{
                        duration: 0.4,
                        delay: delay + i * 0.05,
                        ease: [0.25, 0.1, 0.25, 1],
                    }}
                >
                    {word}
                </motion.span>
            ))}
        </span>
    );
}

// Progress bar
function Progress({ current, total }: { current: number; total: number }) {
    const progress = (current / total) * 100;

    return (
        <div className="w-full max-w-[280px] mx-auto mb-14">
            <div className="flex justify-between mb-3">
                <span className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">
                    Step {current} of {total}
                </span>
                <span className="text-[10px] uppercase tracking-[0.2em] text-neutral-400">
                    {Math.round(progress)}%
                </span>
            </div>
            <div className="h-[2px] bg-neutral-800 rounded-full overflow-hidden relative">
                <motion.div
                    className="h-full bg-gradient-to-r from-neutral-600 via-neutral-400 to-neutral-600 rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1] }}
                />
            </div>
        </div>
    );
}

// Selection card
function SelectCard({
    title,
    description,
    selected,
    onClick,
    delay = 0
}: {
    title: string;
    description?: string;
    selected: boolean;
    onClick: () => void;
    delay?: number;
}) {
    return (
        <motion.div
            onClick={onClick}
            className="relative cursor-pointer mb-3"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay, ease: [0.25, 0.1, 0.25, 1] }}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
        >
            {selected && (
                <BorderBeam
                    size={150}
                    duration={8}
                    borderWidth={1}
                    className="from-neutral-600/30 via-neutral-400/40 to-neutral-600/30"
                />
            )}
            <div
                className={cn(
                    "relative p-5 rounded-2xl border transition-all duration-300 overflow-hidden",
                    selected
                        ? "bg-neutral-800/40 border-neutral-700"
                        : "bg-neutral-900/40 border-neutral-800 hover:border-neutral-700"
                )}
            >
                <div className="flex justify-between items-center">
                    <div>
                        <div className={cn(
                            "text-[15px] font-light transition-colors",
                            selected ? "text-white" : "text-neutral-300"
                        )}>
                            {title}
                        </div>
                        {description && (
                            <div className="text-[11px] text-neutral-500 mt-1">
                                {description}
                            </div>
                        )}
                    </div>
                    <div className={cn(
                        "w-[18px] h-[18px] rounded-full border-[1.5px] flex items-center justify-center transition-all",
                        selected ? "border-neutral-400 bg-neutral-700" : "border-neutral-700"
                    )}>
                        {selected && (
                            <motion.div
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                className="w-2 h-2 rounded-full bg-neutral-300"
                            />
                        )}
                    </div>
                </div>
            </div>
        </motion.div>
    );
}

// Multi-select checkbox card
function CheckCard({
    label,
    sublabel,
    selected,
    onClick,
    delay = 0
}: {
    label: string;
    sublabel?: string;
    selected: boolean;
    onClick: () => void;
    delay?: number;
}) {
    return (
        <motion.div
            onClick={onClick}
            className={cn(
                "p-4 rounded-xl border cursor-pointer flex items-center gap-3 transition-all duration-300",
                selected
                    ? "bg-neutral-800/40 border-neutral-700"
                    : "bg-neutral-900/40 border-neutral-800 hover:border-neutral-700"
            )}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay, duration: 0.35 }}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
        >
            <div className={cn(
                "w-[18px] h-[18px] rounded-md border-[1.5px] flex items-center justify-center flex-shrink-0 transition-all",
                selected ? "border-neutral-400 bg-neutral-700" : "border-neutral-700"
            )}>
                <motion.svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{ opacity: selected ? 1 : 0, scale: selected ? 1 : 0 }}
                    transition={{ duration: 0.15 }}
                >
                    <path
                        d="M2 5L4 7L8 3"
                        stroke="rgb(212 212 212)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                    />
                </motion.svg>
            </div>
            <div>
                <div className={cn(
                    "text-sm font-light",
                    selected ? "text-white" : "text-neutral-300"
                )}>
                    {label}
                </div>
                {sublabel && (
                    <div className="text-[10px] text-neutral-500 mt-0.5 uppercase tracking-wider">
                        {sublabel}
                    </div>
                )}
            </div>
        </motion.div>
    );
}

// Pill button
function Pill({
    children,
    selected,
    onClick,
    delay = 0
}: {
    children: React.ReactNode;
    selected: boolean;
    onClick: () => void;
    delay?: number;
}) {
    return (
        <motion.button
            onClick={onClick}
            className={cn(
                "px-5 py-3 rounded-full border text-sm font-light transition-all duration-300",
                selected
                    ? "border-neutral-600 bg-neutral-800/60 text-white"
                    : "border-neutral-800 bg-transparent text-neutral-400 hover:border-neutral-700 hover:text-neutral-300"
            )}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay, duration: 0.35 }}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
        >
            {children}
        </motion.button>
    );
}

// Question data with strategic intent
const ROLE_OPTIONS = [
    { value: 'engineer', title: 'Software Engineer', description: 'Building products and systems' },
    { value: 'designer', title: 'Designer', description: 'UI/UX, product, or graphic design' },
    { value: 'researcher', title: 'Researcher / Analyst', description: 'Data analysis, market research' },
    { value: 'writer', title: 'Writer / Content Creator', description: 'Articles, copy, documentation' },
    { value: 'founder', title: 'Founder / Executive', description: 'Running or leading a company' },
    { value: 'student', title: 'Student', description: 'Learning and studying' },
    { value: 'other', title: 'Other', description: 'Something else entirely' },
];

const COMPANY_SIZE_OPTIONS = ['Solo / Freelance', '2-10', '11-50', '51-200', '200+', 'Student/Personal'];

const USAGE_FREQUENCY_OPTIONS = [
    { value: 'power', title: 'Multiple times daily', description: 'AI is essential to my workflow' },
    { value: 'regular', title: 'Daily', description: 'I use AI tools every day' },
    { value: 'moderate', title: 'Several times a week', description: 'Regular but not constant' },
    { value: 'occasional', title: 'Occasionally', description: 'When I have specific needs' },
];

const AI_TOOLS = [
    { value: 'chatgpt', label: 'ChatGPT', company: 'OpenAI' },
    { value: 'claude', label: 'Claude', company: 'Anthropic' },
    { value: 'gemini', label: 'Gemini', company: 'Google' },
    { value: 'perplexity', label: 'Perplexity', company: 'Search AI' },
    { value: 'copilot', label: 'GitHub Copilot', company: 'Microsoft' },
    { value: 'cursor', label: 'Cursor', company: 'Cursor' },
    { value: 'grok', label: 'Grok', company: 'xAI' },
    { value: 'other', label: 'Other', company: 'Various' },
];

const PAIN_POINTS = [
    { value: 'context_loss', label: 'Losing context between sessions', sublabel: 'AI forgets what we discussed' },
    { value: 'search', label: 'Cannot search past conversations', sublabel: 'Hard to find old chats' },
    { value: 'fragmented', label: 'Conversations scattered across tools', sublabel: 'No unified view' },
    { value: 'repetition', label: 'Repeating myself to AI', sublabel: 'Re-explaining preferences' },
    { value: 'organization', label: 'Hard to organize AI outputs', sublabel: 'Useful info gets lost' },
    { value: 'learning', label: 'AI does not learn about me', sublabel: 'No personalization over time' },
];

const USE_CASES = [
    { value: 'coding', title: 'Coding and Development', description: 'Writing code, debugging, architecture' },
    { value: 'writing', title: 'Writing and Content', description: 'Articles, documentation, copy' },
    { value: 'research', title: 'Research and Learning', description: 'Deep dives, understanding topics' },
    { value: 'productivity', title: 'Work Productivity', description: 'Email, planning, summarizing' },
    { value: 'creative', title: 'Creative Projects', description: 'Brainstorming, ideation, design' },
    { value: 'data', title: 'Data and Analysis', description: 'Analyzing data, generating insights' },
];

const PRIVACY_OPTIONS = [
    { value: 'critical', title: 'Critical', description: 'I work with sensitive data, privacy is essential' },
    { value: 'important', title: 'Very Important', description: 'I prefer local-first solutions' },
    { value: 'moderate', title: 'Moderate', description: 'Balance between features and privacy' },
    { value: 'low', title: 'Not a major concern', description: 'Convenience matters more' },
];

const REFERRAL_OPTIONS = [
    { value: 'twitter', title: 'Twitter / X' },
    { value: 'reddit', title: 'Reddit' },
    { value: 'hackernews', title: 'Hacker News' },
    { value: 'friend', title: 'Friend or colleague' },
    { value: 'producthunt', title: 'Product Hunt' },
    { value: 'search', title: 'Search engine' },
    { value: 'other', title: 'Other' },
];

export function UserQuestionnaire({ onComplete, onSkip }: QuestionnaireProps) {
    const [step, setStep] = useState(1);
    const [direction, setDirection] = useState(1);
    const [answers, setAnswers] = useState<UserProfile>({
        primaryTools: [],
        painPoints: [],
    });

    const totalSteps = 8;

    const toggleArray = (key: keyof UserProfile, value: string) => {
        setAnswers(prev => {
            const arr = (prev[key] as string[]) || [];
            return {
                ...prev,
                [key]: arr.includes(value)
                    ? arr.filter(v => v !== value)
                    : [...arr, value],
            };
        });
    };

    const goNext = () => {
        setDirection(1);
        if (step === totalSteps) {
            onComplete(answers);
        } else {
            setStep(s => s + 1);
        }
    };

    const goBack = () => {
        setDirection(-1);
        setStep(s => Math.max(s - 1, 1));
    };

    const slideVariants = {
        enter: (dir: number) => ({ x: dir > 0 ? 60 : -60, opacity: 0, filter: 'blur(6px)' }),
        center: { x: 0, opacity: 1, filter: 'blur(0px)' },
        exit: (dir: number) => ({ x: dir < 0 ? 60 : -60, opacity: 0, filter: 'blur(6px)' }),
    };

    const canProceed = (): boolean => {
        switch (step) {
            case 1: return !!answers.role;
            case 2: return !!answers.companySize;
            case 3: return !!answers.aiUsageFrequency;
            case 4: return (answers.primaryTools?.length || 0) > 0;
            case 5: return (answers.painPoints?.length || 0) > 0;
            case 6: return !!answers.primaryUseCase;
            case 7: return !!answers.privacyConcern;
            case 8: return true; // Optional
            default: return true;
        }
    };

    return (
        <div className="fixed inset-0 overflow-hidden bg-neutral-950">
            <StarsBackground className="absolute inset-0 opacity-20" starDensity={0.0002} />

            {/* Background orbs */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <motion.div
                    className="absolute w-[600px] h-[600px] rounded-full -top-[200px] -right-[200px]"
                    style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.02) 0%, transparent 70%)' }}
                    animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0.8, 0.5] }}
                    transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
                />
                <motion.div
                    className="absolute w-[500px] h-[500px] rounded-full -bottom-[150px] -left-[150px]"
                    style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.015) 0%, transparent 70%)' }}
                    animate={{ scale: [1, 1.3, 1], opacity: [0.3, 0.6, 0.3] }}
                    transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
                />
            </div>

            <div className="h-full flex flex-col items-center justify-center px-6 py-12 relative z-10">
                <div className="w-full max-w-[540px] h-full max-h-[600px] flex flex-col">
                    {/* Fixed Progress Bar */}
                    <div className="flex-shrink-0">
                        {step <= totalSteps && <Progress current={step} total={totalSteps} />}
                    </div>

                    {/* Fixed Height Content Area with Scroll */}
                    <div className="flex-1 min-h-0 overflow-hidden">
                        <AnimatePresence mode="wait" custom={direction}>
                            {/* Step 1: Role */}
                            {step === 1 && (
                                <motion.div
                                    key="step1"
                                    custom={direction}
                                    variants={slideVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                                    className="h-full flex flex-col"
                                >
                                    <div className="flex-shrink-0">
                                        <motion.p
                                            className="text-[10px] uppercase tracking-[0.25em] text-neutral-500 mb-4"
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                        >
                                            About You
                                        </motion.p>
                                        <h2 className="text-[clamp(28px,5vw,38px)] font-extralight text-white leading-tight mb-8">
                                            <TextReveal delay={0.1}>What best describes your role?</TextReveal>
                                        </h2>
                                    </div>
                                    <div className="flex-1 overflow-y-auto pr-2 -mr-2 p-2 -mt-2">
                                        {ROLE_OPTIONS.map((option, i) => (
                                            <SelectCard
                                                key={option.value}
                                                title={option.title}
                                                description={option.description}
                                                selected={answers.role === option.value}
                                                onClick={() => setAnswers({ ...answers, role: option.value })}
                                                delay={0.25 + i * 0.05}
                                            />
                                        ))}
                                    </div>
                                </motion.div>
                            )}

                            {/* Step 2: Company Size */}
                            {step === 2 && (
                                <motion.div
                                    key="step2"
                                    custom={direction}
                                    variants={slideVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                                    className="h-full flex flex-col"
                                >
                                    <div className="flex-shrink-0">
                                        <motion.p
                                            className="text-[10px] uppercase tracking-[0.25em] text-neutral-500 mb-4"
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                        >
                                            Context
                                        </motion.p>
                                        <h2 className="text-[clamp(28px,5vw,38px)] font-extralight text-white leading-tight mb-8">
                                            <TextReveal delay={0.1}>What is your team or company size?</TextReveal>
                                        </h2>
                                    </div>
                                    <div className="flex-1 overflow-y-auto">
                                        <div className="flex flex-wrap gap-3">
                                            {COMPANY_SIZE_OPTIONS.map((size, i) => (
                                                <Pill
                                                    key={size}
                                                    selected={answers.companySize === size}
                                                    onClick={() => setAnswers({ ...answers, companySize: size })}
                                                    delay={0.25 + i * 0.04}
                                                >
                                                    {size}
                                                </Pill>
                                            ))}
                                        </div>
                                    </div>
                                </motion.div>
                            )}

                            {/* Step 3: AI Usage Frequency */}
                            {step === 3 && (
                                <motion.div
                                    key="step3"
                                    custom={direction}
                                    variants={slideVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                                    className="h-full flex flex-col"
                                >
                                    <div className="flex-shrink-0">
                                        <motion.p
                                            className="text-[10px] uppercase tracking-[0.25em] text-neutral-500 mb-4"
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                        >
                                            Usage
                                        </motion.p>
                                        <h2 className="text-[clamp(28px,5vw,38px)] font-extralight text-white leading-tight mb-8">
                                            <TextReveal delay={0.1}>How often do you use AI tools?</TextReveal>
                                        </h2>
                                    </div>
                                    <div className="flex-1 overflow-y-auto pr-2 -mr-2 p-2 -mt-2">
                                        {USAGE_FREQUENCY_OPTIONS.map((option, i) => (
                                            <SelectCard
                                                key={option.value}
                                                title={option.title}
                                                description={option.description}
                                                selected={answers.aiUsageFrequency === option.value}
                                                onClick={() => setAnswers({ ...answers, aiUsageFrequency: option.value })}
                                                delay={0.25 + i * 0.06}
                                            />
                                        ))}
                                    </div>
                                </motion.div>
                            )}

                            {/* Step 4: Primary Tools */}
                            {step === 4 && (
                                <motion.div
                                    key="step4"
                                    custom={direction}
                                    variants={slideVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                                    className="h-full flex flex-col"
                                >
                                    <div className="flex-shrink-0">
                                        <motion.p
                                            className="text-[10px] uppercase tracking-[0.25em] text-neutral-500 mb-4"
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                        >
                                            Tools
                                        </motion.p>
                                        <h2 className="text-[clamp(28px,5vw,38px)] font-extralight text-white leading-tight mb-4">
                                            <TextReveal delay={0.1}>Which AI tools do you use?</TextReveal>
                                        </h2>
                                        <motion.p
                                            className="text-[11px] text-neutral-500 mb-6 uppercase tracking-wider"
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            transition={{ delay: 0.35 }}
                                        >
                                            Select all that apply
                                        </motion.p>
                                    </div>
                                    <div className="flex-1 overflow-y-auto pr-2 -mr-2 p-2 -mt-2">
                                        <div className="grid grid-cols-2 gap-3">
                                            {AI_TOOLS.map((tool, i) => (
                                                <CheckCard
                                                    key={tool.value}
                                                    label={tool.label}
                                                    sublabel={tool.company}
                                                    selected={answers.primaryTools?.includes(tool.value) || false}
                                                    onClick={() => toggleArray('primaryTools', tool.value)}
                                                    delay={0.3 + i * 0.04}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                </motion.div>
                            )}

                            {/* Step 5: Pain Points */}
                            {step === 5 && (
                                <motion.div
                                    key="step5"
                                    custom={direction}
                                    variants={slideVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                                    className="h-full flex flex-col"
                                >
                                    <div className="flex-shrink-0">
                                        <motion.p
                                            className="text-[10px] uppercase tracking-[0.25em] text-neutral-500 mb-4"
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                        >
                                            Challenges
                                        </motion.p>
                                        <h2 className="text-[clamp(28px,5vw,38px)] font-extralight text-white leading-tight mb-4">
                                            <TextReveal delay={0.1}>What frustrates you most about AI tools?</TextReveal>
                                        </h2>
                                        <motion.p
                                            className="text-[11px] text-neutral-500 mb-6 uppercase tracking-wider"
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            transition={{ delay: 0.35 }}
                                        >
                                            Select your top frustrations
                                        </motion.p>
                                    </div>
                                    <div className="flex-1 overflow-y-auto pr-2 -mr-2 p-2 -mt-2">
                                        <div className="space-y-3">
                                            {PAIN_POINTS.map((pain, i) => (
                                                <CheckCard
                                                    key={pain.value}
                                                    label={pain.label}
                                                    sublabel={pain.sublabel}
                                                    selected={answers.painPoints?.includes(pain.value) || false}
                                                    onClick={() => toggleArray('painPoints', pain.value)}
                                                    delay={0.3 + i * 0.05}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                </motion.div>
                            )}

                            {/* Step 6: Primary Use Case */}
                            {step === 6 && (
                                <motion.div
                                    key="step6"
                                    custom={direction}
                                    variants={slideVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                                    className="h-full flex flex-col"
                                >
                                    <div className="flex-shrink-0">
                                        <motion.p
                                            className="text-[10px] uppercase tracking-[0.25em] text-neutral-500 mb-4"
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                        >
                                            Intent
                                        </motion.p>
                                        <h2 className="text-[clamp(28px,5vw,38px)] font-extralight text-white leading-tight mb-8">
                                            <TextReveal delay={0.1}>What do you primarily use AI for?</TextReveal>
                                        </h2>
                                    </div>
                                    <div className="flex-1 overflow-y-auto pr-2 -mr-2 p-2 -mt-2">
                                        {USE_CASES.map((uc, i) => (
                                            <SelectCard
                                                key={uc.value}
                                                title={uc.title}
                                                description={uc.description}
                                                selected={answers.primaryUseCase === uc.value}
                                                onClick={() => setAnswers({ ...answers, primaryUseCase: uc.value })}
                                                delay={0.25 + i * 0.05}
                                            />
                                        ))}
                                    </div>
                                </motion.div>
                            )}

                            {/* Step 7: Privacy Concern */}
                            {step === 7 && (
                                <motion.div
                                    key="step7"
                                    custom={direction}
                                    variants={slideVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                                    className="h-full flex flex-col"
                                >
                                    <div className="flex-shrink-0">
                                        <motion.p
                                            className="text-[10px] uppercase tracking-[0.25em] text-neutral-500 mb-4"
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                        >
                                            Privacy
                                        </motion.p>
                                        <h2 className="text-[clamp(28px,5vw,38px)] font-extralight text-white leading-tight mb-8">
                                            <TextReveal delay={0.1}>How important is data privacy to you?</TextReveal>
                                        </h2>
                                    </div>
                                    <div className="flex-1 overflow-y-auto pr-2 -mr-2 p-2 -mt-2">
                                        {PRIVACY_OPTIONS.map((option, i) => (
                                            <SelectCard
                                                key={option.value}
                                                title={option.title}
                                                description={option.description}
                                                selected={answers.privacyConcern === option.value}
                                                onClick={() => setAnswers({ ...answers, privacyConcern: option.value })}
                                                delay={0.25 + i * 0.06}
                                            />
                                        ))}
                                    </div>
                                </motion.div>
                            )}

                            {/* Step 8: Referral Source (Optional) */}
                            {step === 8 && (
                                <motion.div
                                    key="step8"
                                    custom={direction}
                                    variants={slideVariants}
                                    initial="enter"
                                    animate="center"
                                    exit="exit"
                                    transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                                    className="h-full flex flex-col"
                                >
                                    <div className="flex-shrink-0">
                                        <motion.p
                                            className="text-[10px] uppercase tracking-[0.25em] text-neutral-500 mb-4"
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                        >
                                            Discovery
                                        </motion.p>
                                        <h2 className="text-[clamp(28px,5vw,38px)] font-extralight text-white leading-tight mb-4">
                                            <TextReveal delay={0.1}>How did you hear about us?</TextReveal>
                                        </h2>
                                        <motion.p
                                            className="text-[11px] text-neutral-500 mb-6 uppercase tracking-wider"
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            transition={{ delay: 0.35 }}
                                        >
                                            Optional but helps us understand our community
                                        </motion.p>
                                    </div>
                                    <div className="flex-1 overflow-y-auto">
                                        <div className="flex flex-wrap gap-3">
                                            {REFERRAL_OPTIONS.map((ref, i) => (
                                                <Pill
                                                    key={ref.value}
                                                    selected={answers.referralSource === ref.value}
                                                    onClick={() => setAnswers({ ...answers, referralSource: ref.value })}
                                                    delay={0.3 + i * 0.04}
                                                >
                                                    {ref.title}
                                                </Pill>
                                            ))}
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    {/* Fixed Navigation */}
                    <div className="flex-shrink-0 pt-8">
                        <div className="flex justify-between items-center">
                            <button
                                onClick={goBack}
                                disabled={step === 1}
                                className={cn(
                                    "flex items-center gap-2 text-[11px] uppercase tracking-wider font-medium transition-all",
                                    step === 1
                                        ? "text-neutral-700 cursor-not-allowed"
                                        : "text-neutral-500 hover:text-neutral-300"
                                )}
                            >
                                <ArrowLeft className="w-3.5 h-3.5" />
                                Back
                            </button>

                            <button
                                onClick={goNext}
                                disabled={!canProceed() && step !== 8}
                                className={cn(
                                    "flex items-center gap-2 px-6 py-3 rounded-full border text-[11px] uppercase tracking-wider font-medium transition-all",
                                    canProceed() || step === 8
                                        ? "border-neutral-700 text-neutral-200 hover:bg-neutral-800 hover:border-neutral-600"
                                        : "border-neutral-800 text-neutral-600 cursor-not-allowed"
                                )}
                            >
                                {step === totalSteps ? 'Complete' : 'Continue'}
                                <ArrowRight className="w-3.5 h-3.5" />
                            </button>
                        </div>

                        {/* Skip option */}
                        {onSkip && (
                            <button
                                onClick={onSkip}
                                className="block mx-auto mt-6 text-[11px] text-neutral-600 hover:text-neutral-400 transition-colors uppercase tracking-wider"
                            >
                                Skip for now
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
