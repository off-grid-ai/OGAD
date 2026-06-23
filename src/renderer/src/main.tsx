import './assets/main.css'
import './assets/onboarding.css'
import { applyTheme } from './theme'

// Apply the saved/system theme (dark default) before first paint.
applyTheme()

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PostHogProvider } from 'posthog-js/react'
import App from './App'
import { ThemeToggle } from './components/ThemeToggle'
import { TooltipProvider } from './components/ui/tooltip'

const options = {
  api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
  defaults: '2025-11-30',
} as const

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PostHogProvider options={options} apiKey={import.meta.env.VITE_PUBLIC_POSTHOG_API_KEY}>
      <TooltipProvider delayDuration={300}>
        <ThemeToggle />
        <App />
      </TooltipProvider>
    </PostHogProvider>
  </StrictMode>
)
