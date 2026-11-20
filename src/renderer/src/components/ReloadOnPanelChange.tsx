import { Fragment, useEffect, useState } from 'react'

/**
 * Re-reads a Settings section when the paired browser's panel changes it: the children mount again
 * and load fresh values, so this screen never shows the old value or saves it back.
 */
export function ReloadOnPanelChange({
  section,
  children
}: {
  section: string
  children: React.ReactNode
}): React.JSX.Element {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const off = window.api.proOn?.('settings:changed-elsewhere', (change: unknown) => {
      if ((change as { section?: unknown } | null)?.section === section) setVersion((n) => n + 1)
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [section])
  return <Fragment key={version}>{children}</Fragment>
}
