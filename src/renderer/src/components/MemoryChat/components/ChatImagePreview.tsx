import { memo } from 'react'
import { modelNameForFile } from '@renderer/lib/model-summary'
import type { ImageGenerationMetadata, OpenImage } from '../types'

function ImageMetadata({
  metadata
}: Readonly<{
  metadata?: ImageGenerationMetadata
}>): React.JSX.Element | null {
  if (!metadata) return null
  return (
    <p aria-label="Image generation metadata" className="mt-1.5 text-[10px] text-neutral-600">
      {metadata.width} × {metadata.height} · {metadata.steps} steps · CFG {metadata.cfgScale} · seed{' '}
      {metadata.seed}
      {metadata.model ? ` · ${modelNameForFile(metadata.model)}` : ''}
    </p>
  )
}

export const ChatImagePreview = memo(function ChatImagePreview({
  src,
  path,
  alt = 'Generated',
  metadata,
  className,
  fill = false,
  spacing,
  onOpen
}: Readonly<{
  src: string
  path?: string
  alt?: string
  metadata?: ImageGenerationMetadata
  className: string
  fill?: boolean
  /** Space around the picture, kept outside its edge. */
  spacing?: string
  onOpen: (image: OpenImage) => void
}>): React.JSX.Element {
  return (
    <div className={fill ? `w-full ${spacing ?? ''}` : spacing}>
      {/* A surface like every card: the field's light and click waves trace its edge. An <img>
          cannot draw them itself, so the button around it does, with the image's corners. */}
      <button
        type="button"
        data-og-surface=""
        aria-label={`Open ${alt}`}
        onClick={() => onOpen({ url: src, path })}
        className={`relative rounded-md ${fill ? 'block w-full max-w-full' : 'block max-w-full'}`}
      >
        {/* A block image: an inline one leaves a line gap under it, and the edge would trace
            the gap instead of the picture. */}
        <img
          src={src}
          alt={alt}
          className={`block ${className}`}
          loading="lazy"
          decoding="async"
          fetchPriority="low"
        />
      </button>
      <ImageMetadata metadata={metadata} />
    </div>
  )
})
