import React, { useState } from 'react'
import { Copy, Check } from '@phosphor-icons/react'

/** Small copy-to-clipboard button with a brief "Copied" confirmation. Shared so the
 *  gateway and pairing panels (and anywhere else) copy the same way. */
export function CopyButton({
  text,
  label = 'Copy'
}: {
  text: string
  label?: string
}): React.ReactElement {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }
      className="flex items-center gap-1.5 rounded-md border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:border-neutral-500 hover:text-white"
    >
      {done ? (
        <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" weight="bold" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {done ? 'Copied' : label}
    </button>
  )
}
