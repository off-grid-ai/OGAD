import type { ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { SidePanel } from '@renderer/components/SidePanel'

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
      <header className="flex items-center justify-between gap-3 border-b border-neutral-900 px-4 py-3">
        <h2 className="min-w-0 truncate text-sm font-normal text-neutral-200">
          {image.dialogLabel}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:text-white"
          >
            Close
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <motion.img
          src={image.url}
          alt={image.alt}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduceMotion ? undefined : { opacity: 0, scale: 0.99 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: 'easeOut' }}
          className="max-h-full max-w-full rounded-md object-contain"
        />
      </div>
    </SidePanel>
  )
}
