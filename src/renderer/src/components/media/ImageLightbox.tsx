import type { ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { SidePanel } from '@renderer/components/SidePanel'
import { X } from '@phosphor-icons/react'
import { Button } from '@renderer/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@renderer/components/ui/tooltip'

export interface ImageLightboxImage {
  url: string
  alt: string
  dialogLabel: string
}

export function ImageLightbox({
  image,
  onClose,
  actions
}: Readonly<{
  image: ImageLightboxImage | null
  onClose: () => void
  actions?: ReactNode
}>): React.JSX.Element {
  return (
    <AnimatePresence>
      {image ? <ImageLightboxContent image={image} onClose={onClose} actions={actions} /> : null}
    </AnimatePresence>
  )
}

function ImageLightboxContent({
  image,
  onClose,
  actions
}: Readonly<{
  image: ImageLightboxImage
  onClose: () => void
  actions?: ReactNode
}>): React.JSX.Element {
  const reduceMotion = useReducedMotion()

  return (
    <SidePanel
      key="image-lightbox"
      ariaLabel={image.dialogLabel}
      onClose={onClose}
      className="w-[min(720px,92vw)] overflow-hidden text-white"
    >
      <header className="flex items-center justify-between gap-4 border-b border-neutral-900 px-6 py-4">
        <h2 className="min-w-0 truncate text-sm font-normal text-neutral-200">
          {image.dialogLabel}
        </h2>
        {/* Its own provider: the lightbox also opens from surfaces mounted outside the app shell. */}
        <TooltipProvider delayDuration={300}>
          <div className="flex shrink-0 items-center gap-1.5">
            {actions}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  aria-label="Close"
                  onClick={onClose}
                >
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Close</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        <motion.img
          src={image.url}
          alt={image.alt}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduceMotion ? undefined : { opacity: 0, scale: 0.99 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="max-h-full max-w-full rounded-md object-contain"
        />
      </div>
    </SidePanel>
  )
}
