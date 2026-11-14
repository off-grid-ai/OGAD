import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The @offgrid/design type scale (main.css @theme --text-*). Unregistered, tailwind-merge reads
// text-label as a colour and drops it beside text-muted-foreground.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ['display', 'h1', 'h2', 'h3', 'body', 'body-small', 'label', 'meta'] } }
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
