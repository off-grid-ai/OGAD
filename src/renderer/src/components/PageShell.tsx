import type { CSSProperties, ReactNode } from 'react'
import { PageHeader } from '@offgrid/operator-ui/operator/experience'
import { cn } from '@renderer/lib/utils'

/**
 * The one frame every top-level screen renders in: the library's PageHeader on the page
 * gutters and max width, an optional toolbar row under it, then the screen's body on the
 * same gutters. The route host adds no padding of its own, so this is the only place the
 * gutters and the max width live. A screen never hand-rolls its own header or padding.
 *
 * Two layout choices, both on this component:
 * - `fill`: the body does not scroll. It is a full-height column, and the screen scrolls
 *   its own regions (a list beside a detail, a thread above a composer).
 * - `bleed`: the documented opt-out for a full-bleed stage (a video watch stage, a canvas).
 *   The header stays on the gutters; the body spans edge to edge with no gutters.
 */
export interface PageShellProps {
  title: string
  /** One sentence under the title. */
  description?: ReactNode
  /** Small mono line above the title. */
  eyebrow?: ReactNode
  /** Right-aligned actions; keep to one primary. */
  actions?: ReactNode
  /** A row pinned under the header on the gutters: tabs, filters, search. */
  toolbar?: ReactNode
  /** The body is a full-height column and the screen scrolls its own regions. */
  fill?: boolean
  /** Opt out of the body gutters and max width, for a full-bleed stage. */
  bleed?: boolean
  children?: ReactNode
  className?: string
  /** Inline style on the page, e.g. room reserved for a side canvas. */
  style?: CSSProperties
}

/** Page gutters, top padding and max width: the guard test asserts every screen gets these. */
export const PAGE_GUTTER = 'px-8'
export const PAGE_TOP = 'pt-8'
export const PAGE_MAX_WIDTH = 'mx-auto w-full max-w-[1920px]'

export function PageShell({
  title,
  description,
  eyebrow,
  actions,
  toolbar,
  fill = false,
  bleed = false,
  children,
  className,
  style
}: PageShellProps): React.JSX.Element {
  return (
    <div
      data-slot="page-shell"
      data-bleed={bleed || undefined}
      className={cn('flex h-full min-h-0 flex-col', className)}
      style={style}
    >
      <div data-slot="page-shell-header" className={cn('shrink-0', PAGE_TOP, PAGE_GUTTER)}>
        <div className={PAGE_MAX_WIDTH}>
          {/* Keyed by the title, so a new title (another day, another project) reveals again. */}
          <PageHeader
            key={title}
            className={cn('[&>div:first-child]:max-w-full', toolbar ? 'pb-5' : 'pb-6')}
            title={title}
            description={description}
            eyebrow={eyebrow}
            actions={actions}
          />
          {toolbar ? <div className="pb-4">{toolbar}</div> : null}
        </div>
      </div>
      {/* One element is the body: the gutters, the max width and the scroll live together, so the
          shell adds as little depth as it can above every screen's content. */}
      <div
        data-slot="page-content"
        // Back/Forward restores the page's scroll position on this element (route-history).
        data-route-scroll={fill ? undefined : ''}
        className={cn(
          'min-h-0 flex-1',
          bleed ? 'w-full' : cn(PAGE_MAX_WIDTH, PAGE_GUTTER),
          fill ? 'flex flex-col overflow-hidden pb-6' : 'overflow-y-auto pb-8'
        )}
      >
        {children}
      </div>
    </div>
  )
}
