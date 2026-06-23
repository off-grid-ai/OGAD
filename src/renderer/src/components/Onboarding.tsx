import { useState, useEffect } from 'react';
import { motion, AnimatePresence, stagger, useAnimate } from 'motion/react';
import { LampContainer } from './ui/lamp';
import { OrbitingCircles } from './ui/orbiting-circles';
import { StarsBackground } from './ui/stars-background';
import { BorderBeam } from './ui/border-beam';
import { cn } from '@renderer/lib/utils';
import { UserQuestionnaire } from './UserQuestionnaire';

import { ArrowRight, Check, Brain, Database, Network, Chat as MessageSquare } from '@phosphor-icons/react';

// Brand SVG Icons
const OpenAIIcon = ({ className }: { className?: string }) => (
    <svg role="img" viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>
    </svg>
);

const ClaudeIcon = ({ className }: { className?: string }) => (
    <svg role="img" viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/>
    </svg>
);

const GeminiIcon = ({ className }: { className?: string }) => (
    <svg role="img" viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/>
    </svg>
);

const PerplexityIcon = ({ className }: { className?: string }) => (
    <svg role="img" viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M22.3977 7.0896h-2.3106V.0676l-7.5094 6.3542V.1577h-1.1554v6.1966L4.4904 0v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318 6.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676 4.8691 4.4634H5.6458V2.6262zM2.7576 16.332V8.245h7.8476l-6.1149 6.1147v1.9723H2.7576zm2.8882 5.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764 5.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766 5.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948 8.245h7.8478v8.087z"/>
    </svg>
);

const GrokIcon = ({ className }: { className?: string }) => (
    <svg role="img" viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/>
    </svg>
);

// Text Generate Effect - matching Dashboard style
function TextGenerate({ 
    words, 
    className,
    delay = 0 
}: { 
    words: string; 
    className?: string;
    delay?: number;
}) {
    const [scope, animate] = useAnimate();
    const wordsArray = words.split(" ");
    
    useEffect(() => {
        const timer = setTimeout(() => {
            animate(
                "span",
                { opacity: 1, filter: "blur(0px)" },
                { duration: 0.4, delay: stagger(0.08) }
            );
        }, delay * 1000);
        
        return () => clearTimeout(timer);
    }, [animate, delay]);
    
    return (
        <motion.div ref={scope} className={cn("inline", className)}>
            {wordsArray.map((word, idx) => (
                <motion.span
                    key={word + idx}
                    className="opacity-0 inline-block"
                    style={{ filter: "blur(8px)" }}
                >
                    {word}{idx < wordsArray.length - 1 ? "\u00A0" : ""}
                </motion.span>
            ))}
        </motion.div>
    );
}

// Animated counter for stats
function AnimatedNumber({ value, delay = 0 }: { value: number; delay?: number }) {
    const [displayValue, setDisplayValue] = useState(0);
    
    useEffect(() => {
        const timer = setTimeout(() => {
            const duration = 1000;
            const steps = 30;
            const increment = value / steps;
            let current = 0;
            
            const interval = setInterval(() => {
                current += increment;
                if (current >= value) {
                    setDisplayValue(value);
                    clearInterval(interval);
                } else {
                    setDisplayValue(Math.floor(current));
                }
            }, duration / steps);
            
            return () => clearInterval(interval);
        }, delay * 1000);
        
        return () => clearTimeout(timer);
    }, [value, delay]);
    
    return <span>{displayValue.toLocaleString()}</span>;
}

interface OnboardingProps {
    onComplete: () => void;
}

const steps = [
    { id: 'welcome' },
    { id: 'connect' },
    { id: 'features' },
];

export function Onboarding({ onComplete }: OnboardingProps) {
    const [currentStep, setCurrentStep] = useState(0);
    // Questionnaire removed; kept as a const-false guard so the legacy block below never renders.
    const [showQuestionnaire] = useState(false);

    const handleNext = () => {
        if (currentStep < steps.length - 1) {
            setCurrentStep(currentStep + 1);
        } else {
            // Questionnaire removed: complete onboarding directly.
            localStorage.setItem('onboarding_completed', 'true');
            onComplete();
        }
    };

    const handleQuestionnaireComplete = async (profile: any) => {
        try {
            await window.api.saveUserProfile(profile);
            console.log('User profile saved:', profile);
        } catch (e) {
            console.error('Failed to save user profile:', e);
        }
        localStorage.setItem('onboarding_completed', 'true');
        onComplete();
    };

    const handleQuestionnaireSkip = () => {
        localStorage.setItem('onboarding_completed', 'true');
        onComplete();
    };

    // Show questionnaire after main onboarding
    if (showQuestionnaire) {
        return (
            <UserQuestionnaire 
                onComplete={handleQuestionnaireComplete}
                onSkip={handleQuestionnaireSkip}
            />
        );
    }

    return (
        <div className="fixed inset-0 overflow-hidden bg-neutral-950">
            <AnimatePresence mode="wait">
                {/* Step 0: Welcome with Lamp Effect */}
                {currentStep === 0 && (
                    <motion.div
                        key="step-0"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="h-full w-full"
                    >
                        <LampContainer className="min-h-screen bg-neutral-950">
                            <motion.div
                                initial={{ opacity: 0.5, y: 100 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                transition={{
                                    delay: 0.3,
                                    duration: 0.8,
                                    ease: "easeInOut",
                                }}
                                className="text-center"
                            >
                                <h1 className="bg-gradient-to-br from-neutral-100 to-neutral-400 py-4 bg-clip-text text-4xl font-light tracking-tight text-transparent md:text-7xl">
                                    Your Knowledge Base
                                </h1>
                                <p className="mt-4 text-neutral-500 max-w-lg mx-auto text-lg">
                                    All your AI conversations in one searchable place
                                </p>
                            </motion.div>
                        </LampContainer>
                    </motion.div>
                )}

                {/* Step 1: Connect with Orbiting Circles */}
                {currentStep === 1 && (
                    <motion.div
                        key="step-1"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="h-full w-full bg-neutral-950 relative"
                    >
                        <StarsBackground className="absolute inset-0 opacity-30" starDensity={0.0002} />
                        
                        <div className="min-h-screen flex flex-col items-center justify-center px-6 relative z-10">
                            {/* Header */}
                            <div className="text-center mb-8">
                                <TextGenerate 
                                    words="Connect Your Assistants" 
                                    className="text-3xl md:text-5xl font-light text-white tracking-tight"
                                    delay={0}
                                />
                                <div className="mt-4">
                                    <TextGenerate 
                                        words="Seamlessly import from all your AI tools" 
                                        className="text-neutral-500"
                                        delay={0.4}
                                    />
                                </div>
                            </div>
                            
                            {/* Orbiting Circles */}
                            <motion.div
                                initial={{ opacity: 0, scale: 0.8 }}
                                animate={{ opacity: 1, scale: 1 }}
                                transition={{ delay: 0.6, duration: 0.6 }}
                                className="relative flex h-[400px] w-full max-w-[500px] items-center justify-center overflow-hidden"
                            >
                                {/* Center element - Brain hub */}
                                <div className="absolute z-10 flex h-20 w-20 items-center justify-center rounded-full bg-neutral-900 border border-neutral-800">
                                    <Brain className="h-10 w-10 text-neutral-400" />
                                </div>
                                
                                {/* Inner orbit - 3 icons */}
                                <OrbitingCircles radius={100} duration={25} iconSize={48}>
                                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-900 border border-neutral-800">
                                        <OpenAIIcon className="h-6 w-6 text-neutral-400" />
                                    </div>
                                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-900 border border-neutral-800">
                                        <ClaudeIcon className="h-6 w-6 text-neutral-400" />
                                    </div>
                                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-900 border border-neutral-800">
                                        <GeminiIcon className="h-6 w-6 text-neutral-400" />
                                    </div>
                                </OrbitingCircles>
                                
                                {/* Outer orbit - 2 icons, reversed */}
                                <OrbitingCircles radius={170} duration={30} reverse iconSize={48}>
                                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-900 border border-neutral-800">
                                        <PerplexityIcon className="h-6 w-6 text-neutral-400" />
                                    </div>
                                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-900 border border-neutral-800">
                                        <GrokIcon className="h-6 w-6 text-neutral-400" />
                                    </div>
                                </OrbitingCircles>
                            </motion.div>

                            {/* Source labels */}
                            <motion.p
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ delay: 1 }}
                                className="text-xs text-neutral-600 mt-4"
                            >
                                ChatGPT, Claude, Gemini, Perplexity, Grok
                            </motion.p>
                        </div>
                    </motion.div>
                )}

                {/* Step 2: Features */}
                {currentStep === 2 && (
                    <motion.div
                        key="step-2"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="h-full w-full flex flex-col items-center justify-center px-6 bg-neutral-950"
                    >
                        <StarsBackground className="absolute inset-0 opacity-20" starDensity={0.0002} />
                        
                        <div className="max-w-4xl mx-auto relative z-10">
                            {/* Header */}
                            <div className="text-center mb-16">
                                <TextGenerate 
                                    words="How it works" 
                                    className="text-3xl md:text-4xl font-light text-white tracking-tight"
                                    delay={0}
                                />
                            </div>

                            {/* Feature cards */}
                            <div className="grid md:grid-cols-3 gap-6">
                                {/* Feature 1 */}
                                <motion.div
                                    initial={{ opacity: 0, y: 30 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: 0.3, duration: 0.5 }}
                                    className="p-8 rounded-2xl bg-neutral-900/50 border border-neutral-800 relative overflow-hidden group"
                                >
                                    <BorderBeam duration={8} size={80} className="from-transparent via-neutral-700 to-transparent opacity-0 group-hover:opacity-40 transition-opacity" />
                                    <div className="w-12 h-12 rounded-xl bg-neutral-800 border border-neutral-700 flex items-center justify-center mb-6">
                                        <MessageSquare className="w-5 h-5 text-neutral-400" />
                                    </div>
                                    <h3 className="text-lg font-medium text-white mb-3">Capture</h3>
                                    <p className="text-sm text-neutral-500 leading-relaxed">
                                        Automatically imports conversations from your AI assistants as you chat
                                    </p>
                                </motion.div>

                                {/* Feature 2 */}
                                <motion.div
                                    initial={{ opacity: 0, y: 30 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: 0.5, duration: 0.5 }}
                                    className="p-8 rounded-2xl bg-neutral-900/50 border border-neutral-800 relative overflow-hidden group"
                                >
                                    <BorderBeam duration={8} size={80} className="from-transparent via-neutral-700 to-transparent opacity-0 group-hover:opacity-40 transition-opacity" />
                                    <div className="w-12 h-12 rounded-xl bg-neutral-800 border border-neutral-700 flex items-center justify-center mb-6">
                                        <Database className="w-5 h-5 text-neutral-400" />
                                    </div>
                                    <h3 className="text-lg font-medium text-white mb-3">Extract</h3>
                                    <p className="text-sm text-neutral-500 leading-relaxed">
                                        Extracts key insights, entities, and facts from every conversation
                                    </p>
                                </motion.div>

                                {/* Feature 3 */}
                                <motion.div
                                    initial={{ opacity: 0, y: 30 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: 0.7, duration: 0.5 }}
                                    className="p-8 rounded-2xl bg-neutral-900/50 border border-neutral-800 relative overflow-hidden group"
                                >
                                    <BorderBeam duration={8} size={80} className="from-transparent via-neutral-700 to-transparent opacity-0 group-hover:opacity-40 transition-opacity" />
                                    <div className="w-12 h-12 rounded-xl bg-neutral-800 border border-neutral-700 flex items-center justify-center mb-6">
                                        <Network className="w-5 h-5 text-neutral-400" />
                                    </div>
                                    <h3 className="text-lg font-medium text-white mb-3">Connect</h3>
                                    <p className="text-sm text-neutral-500 leading-relaxed">
                                        Builds a knowledge graph linking related concepts and ideas
                                    </p>
                                </motion.div>
                            </div>

                            {/* Bottom stat preview */}
                            <motion.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 1, duration: 0.5 }}
                                className="mt-12 flex items-center justify-center gap-12"
                            >
                                <div className="text-center">
                                    <div className="text-3xl font-light text-white">
                                        <AnimatedNumber value={100} delay={1.2} />%
                                    </div>
                                    <div className="text-xs text-neutral-600 uppercase tracking-wider mt-1">Local</div>
                                </div>
                                <div className="w-px h-8 bg-neutral-800" />
                                <div className="text-center">
                                    <div className="text-3xl font-light text-white">
                                        <AnimatedNumber value={0} delay={1.3} />
                                    </div>
                                    <div className="text-xs text-neutral-600 uppercase tracking-wider mt-1">Cloud Storage</div>
                                </div>
                                <div className="w-px h-8 bg-neutral-800" />
                                <div className="text-center">
                                    <div className="text-3xl font-light text-white tabular-nums">∞</div>
                                    <div className="text-xs text-neutral-600 uppercase tracking-wider mt-1">Private</div>
                                </div>
                            </motion.div>
                        </div>
                    </motion.div>
                )}

                {/* Step 3: Ready - Transition to Questionnaire */}
                {currentStep === 3 && (
                    <motion.div
                        key="step-3"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="h-full w-full flex flex-col items-center justify-center px-6 bg-neutral-950"
                    >
                        <StarsBackground className="absolute inset-0 opacity-20" starDensity={0.0002} />
                        
                        <div className="max-w-xl mx-auto text-center relative z-10">
                            {/* Success icon */}
                            <motion.div
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                transition={{ duration: 0.5, type: 'spring', stiffness: 200 }}
                                className="mb-12"
                            >
                                <div className="w-24 h-24 mx-auto rounded-full bg-neutral-900 border border-neutral-800 flex items-center justify-center relative">
                                    <motion.div
                                        initial={{ scale: 0 }}
                                        animate={{ scale: 1 }}
                                        transition={{ delay: 0.3 }}
                                    >
                                        <Check className="w-12 h-12 text-neutral-400" strokeWidth={1.5} />
                                    </motion.div>
                                    {/* Pulse ring */}
                                    <motion.div
                                        initial={{ opacity: 0, scale: 0.8 }}
                                        animate={{ opacity: [0.3, 0], scale: [1, 1.5] }}
                                        transition={{ duration: 2, repeat: Infinity }}
                                        className="absolute inset-0 rounded-full border border-neutral-700"
                                    />
                                </div>
                            </motion.div>

                            {/* Ready message */}
                            <div className="mb-4">
                                <TextGenerate 
                                    words="Almost there" 
                                    className="text-4xl md:text-5xl font-light text-white tracking-tight"
                                    delay={0.4}
                                />
                            </div>
                            
                            <div className="mb-6">
                                <TextGenerate 
                                    words="Help us personalize your experience with a few quick questions" 
                                    className="text-neutral-500"
                                    delay={0.8}
                                />
                            </div>

                            {/* Questionnaire info */}
                            <motion.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 1.2 }}
                                className="mb-8"
                            >
                                <div className="inline-flex items-center gap-3 px-5 py-3 rounded-2xl bg-neutral-900/60 border border-neutral-800">
                                    <span className="text-sm text-neutral-400">Takes less than 2 minutes</span>
                                </div>
                            </motion.div>

                            {/* What we'll ask */}
                            <motion.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 1.4 }}
                                className="flex flex-wrap items-center justify-center gap-4"
                            >
                                {['Your role', 'Tools you use', 'How we can help'].map((tip) => (
                                    <div key={tip} className="flex items-center gap-2 text-neutral-600">
                                        <div className="w-1 h-1 rounded-full bg-neutral-700" />
                                        <span className="text-sm">{tip}</span>
                                    </div>
                                ))}
                            </motion.div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Navigation */}
            <div className="fixed bottom-12 left-0 right-0 flex flex-col items-center gap-6 z-50">
                {/* Progress dots */}
                <div className="flex gap-2">
                    {steps.map((_, idx) => (
                        <motion.div
                            key={idx}
                            initial={false}
                            animate={{
                                width: currentStep === idx ? 24 : 6,
                                backgroundColor: currentStep === idx ? "rgb(163 163 163)" : "rgb(64 64 64)"
                            }}
                            className="h-1 rounded-full"
                            transition={{ duration: 0.3 }}
                        />
                    ))}
                </div>

                {/* Next button */}
                <motion.button
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.5 }}
                    onClick={handleNext}
                    className="flex items-center gap-2 px-8 py-3 rounded-full bg-neutral-900 border border-neutral-800 text-neutral-300 hover:bg-neutral-800 hover:border-neutral-700 hover:text-white transition-all duration-200 group"
                >
                    <span className="text-sm font-medium">
                        {currentStep === steps.length - 1 ? 'Get Started' : 'Continue'}
                    </span>
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                </motion.button>
            </div>
        </div>
    );
}
