import { Check, X } from '@phosphor-icons/react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

// The plain-language version of docs/ANALYTICS.md. Change both together.
export const WE_SHARE = [
  'Which screens and features you use, and for how long',
  'Model downloads and loads: the public model name, its size and how long it took',
  'How each reply went: speed, a rough length and whether it finished',
  'Crash reports with file names and line numbers only',
  'Your platform, app version, memory size, OS version and language'
] as const

export const WE_NEVER_SHARE = [
  'Your prompts, replies, transcripts or tool results',
  'File names, document names, paths, web addresses or IP addresses',
  'What you search for',
  'Names of models you imported or connectors you added yourself',
  'Your email, license key or any account or device ID'
] as const

export function WhatWeShareDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-neutral-700 bg-neutral-950 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>What we share</DialogTitle>
          <DialogDescription className="leading-relaxed">
            Only when you turn it on. It is anonymous: a random ID for this install, reset when you
            turn analytics off. Your chats and files never leave your computer.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 text-xs leading-relaxed sm:grid-cols-2">
          <section aria-labelledby="analytics-we-share">
            <h3
              id="analytics-we-share"
              className="mb-2 text-[11px] uppercase tracking-wide text-neutral-400"
            >
              We share
            </h3>
            <ul className="space-y-1.5">
              {WE_SHARE.map((item) => (
                <li key={item} className="flex gap-2 text-neutral-200">
                  <Check aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  {item}
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="analytics-never-share">
            <h3
              id="analytics-never-share"
              className="mb-2 text-[11px] uppercase tracking-wide text-neutral-400"
            >
              We never share
            </h3>
            <ul className="space-y-1.5">
              {WE_NEVER_SHARE.map((item) => (
                <li key={item} className="flex gap-2 text-neutral-200">
                  <X aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                  {item}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
