'use client'
import { cn } from '@renderer/lib/utils'
import { AnimatePresence, motion } from 'motion/react'
import React, { ReactNode, createContext, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface ModalContextType {
  open: boolean
  setOpen: (open: boolean) => void
}

const ModalContext = createContext<ModalContextType | undefined>(undefined)
const openModalStack: symbol[] = []

export const ModalProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [open, setOpen] = useState(false)

  return <ModalContext.Provider value={{ open, setOpen }}>{children}</ModalContext.Provider>
}

const useModal = (): ModalContextType => {
  const context = useContext(ModalContext)
  if (!context) {
    throw new Error('useModal must be used within a ModalProvider')
  }
  return context
}

export function Modal({ children }: { children: ReactNode }): React.JSX.Element {
  return <ModalProvider>{children}</ModalProvider>
}

export const ModalTrigger = ({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element => {
  const { setOpen } = useModal()
  return (
    <button
      className={cn(
        'px-4 py-2 rounded-md text-black dark:text-white text-center relative overflow-hidden',
        className
      )}
      onClick={() => setOpen(true)}
    >
      {children}
    </button>
  )
}

export const ModalBody = ({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.ReactPortal => {
  const { open, setOpen } = useModal()
  const modalRef = useRef<HTMLDivElement>(null)
  const modalId = useRef(Symbol('animated-modal'))
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return undefined

    const id = modalId.current
    const previousOverflow = document.body.style.overflow
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = 'hidden'
    openModalStack.push(id)

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || openModalStack.at(-1) !== id) return
      event.preventDefault()
      event.stopImmediatePropagation()
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    modalRef.current?.focus()

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const index = openModalStack.lastIndexOf(id)
      if (index >= 0) openModalStack.splice(index, 1)
      document.body.style.overflow = previousOverflow
      previousFocus.current?.focus()
    }
  }, [open, setOpen])

  useOutsideClick(modalRef, () => setOpen(false))

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{
            opacity: 0
          }}
          animate={{
            opacity: 1,
            backdropFilter: 'blur(10px)'
          }}
          exit={{
            opacity: 0,
            backdropFilter: 'blur(0px)'
          }}
          className="fixed [perspective:800px] [transform-style:preserve-3d] inset-0 h-full w-full  flex items-center justify-center z-50"
        >
          <Overlay />

          <motion.div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            className={cn(
              'min-h-[50%] max-h-[90%] md:max-w-[40%] bg-white dark:bg-neutral-950 border border-transparent dark:border-neutral-800 md:rounded-2xl relative z-50 flex flex-col flex-1 overflow-hidden',
              className
            )}
            initial={{
              opacity: 0,
              scale: 0.5,
              rotateX: 40,
              y: 40
            }}
            animate={{
              opacity: 1,
              scale: 1,
              rotateX: 0,
              y: 0
            }}
            exit={{
              opacity: 0,
              scale: 0.8,
              rotateX: 10
            }}
            transition={{
              type: 'spring',
              stiffness: 260,
              damping: 15
            }}
          >
            <CloseIcon />
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

export const ModalContent = ({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element => {
  return <div className={cn('flex flex-col flex-1 p-8 md:p-10', className)}>{children}</div>
}

export const ModalFooter = ({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element => {
  return (
    <div className={cn('flex justify-end p-4 bg-gray-100 dark:bg-neutral-900', className)}>
      {children}
    </div>
  )
}

const Overlay = ({ className }: { className?: string }): React.JSX.Element => {
  return (
    <motion.div
      initial={{
        opacity: 0
      }}
      animate={{
        opacity: 1,
        backdropFilter: 'blur(10px)'
      }}
      exit={{
        opacity: 0,
        backdropFilter: 'blur(0px)'
      }}
      className={`fixed inset-0 h-full w-full bg-black bg-opacity-50 z-50 ${className}`}
    ></motion.div>
  )
}

const CloseIcon = (): React.JSX.Element => {
  const { setOpen } = useModal()
  return (
    <button onClick={() => setOpen(false)} className="absolute top-4 right-4 group">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-black dark:text-white h-4 w-4 group-hover:scale-125 group-hover:rotate-3 transition duration-200"
      >
        <path stroke="none" d="M0 0h24v24H0z" fill="none" />
        <path d="M18 6l-12 12" />
        <path d="M6 6l12 12" />
      </svg>
    </button>
  )
}

// Hook to detect clicks outside of a component.
// Add it in a separate file, I've added here for simplicity
const useOutsideClick = (
  ref: React.RefObject<HTMLDivElement | null>,
  callback: (event: MouseEvent | TouchEvent) => void
): void => {
  useEffect(() => {
    const listener = (event: MouseEvent | TouchEvent): void => {
      // DO NOTHING if the element being clicked is the target element or their children
      if (!ref.current || !(event.target instanceof Node) || ref.current.contains(event.target)) {
        return
      }
      callback(event)
    }

    document.addEventListener('mousedown', listener)
    document.addEventListener('touchstart', listener)

    return () => {
      document.removeEventListener('mousedown', listener)
      document.removeEventListener('touchstart', listener)
    }
  }, [ref, callback])
}
