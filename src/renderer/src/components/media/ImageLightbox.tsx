import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { acquireNativeSurfaceOcclusion } from '@renderer/lib/native-surface-occlusion'

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
  return createPortal(
    <AnimatePresence>
      {image ? <ImageLightboxContent image={image} onClose={onClose} actions={actions} /> : null}
    </AnimatePresence>,
    document.body
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
  const dialogRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()

  // The live browser is a native Electron child view above renderer DOM. Hide
  // only that presentation surface while the modal is mounted. The page and
  // active Web Use task continue unchanged.
  useLayoutEffect(() => acquireNativeSurfaceOcclusion(), [])

  useEffect(() => {
    dialogRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <motion.div
      ref={dialogRef}
      key="image-lightbox"
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/85 p-10"
      role="dialog"
      aria-modal="true"
      aria-label={image.dialogLabel}
      tabIndex={-1}
      initial={reduceMotion ? false : { opacity: 0, backdropFilter: 'blur(0px)' }}
      animate={{ opacity: 1, backdropFilter: reduceMotion ? 'none' : 'blur(8px)' }}
      exit={reduceMotion ? undefined : { opacity: 0, backdropFilter: 'blur(0px)' }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.4, 0, 0.2, 1] }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        {actions}
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 transition-colors hover:text-white"
        >
          Close
        </button>
      </div>
      <motion.img
        src={image.url}
        alt={image.alt}
        initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={reduceMotion ? undefined : { opacity: 0, scale: 0.98 }}
        transition={
          reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 30 }
        }
        className="max-h-full max-w-full rounded-md object-contain"
      />
    </motion.div>
  )
}
