import { memo } from 'react'
import type { ImageGenerationMetadata, OpenImage } from '../types'

function ImageMetadata({
  metadata
}: Readonly<{
  metadata?: ImageGenerationMetadata
}>): React.JSX.Element | null {
  console.log('MemoryChat ImageMetadata rendered')
  if (!metadata) return null
  return (
    <p aria-label="Image generation metadata" className="mt-1.5 text-[10px] text-neutral-600">
      {metadata.width} × {metadata.height} · {metadata.steps} steps · CFG {metadata.cfgScale} · seed{' '}
      {metadata.seed}
      {metadata.model ? ` · ${metadata.model}` : ''}
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
  onOpen
}: Readonly<{
  src: string
  path?: string
  alt?: string
  metadata?: ImageGenerationMetadata
  className: string
  fill?: boolean
  onOpen: (image: OpenImage) => void
}>): React.JSX.Element {
  console.log('MemoryChat ChatImagePreview rendered')
  return (
    <div className={fill ? 'w-full' : undefined}>
      <button
        type="button"
        aria-label={`Open ${alt}`}
        onClick={() => onOpen({ url: src, path })}
        className={fill ? 'block w-full max-w-full' : 'block max-w-full'}
      >
        <img
          src={src}
          alt={alt}
          className={className}
          loading="lazy"
          decoding="async"
          fetchPriority="low"
        />
      </button>
      <ImageMetadata metadata={metadata} />
    </div>
  )
})
