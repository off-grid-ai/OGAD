import { useEffect, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import type { Artifact } from '@renderer/lib/artifact-parser'
import { artifactKindLabel } from '@renderer/lib/artifact-labels'
import { timeAgo } from '@renderer/lib/time'
import { ArtifactCanvas } from './ArtifactCanvas'

type SavedArtifact = Artifact & { id: string; title: string; created: number }

export function ProjectArtifacts({ projectId }: { projectId: string }): React.ReactElement {
  const [items, setItems] = useState<SavedArtifact[]>([])
  const [open, setOpen] = useState<Artifact | null>(null)

  useEffect(() => {
    void window.api
      .listArtifacts({ projectId })
      .then((artifacts) => setItems(artifacts))
      .catch(() => setItems([]))
  }, [projectId])

  return (
    <div className="w-full px-8 py-6">
      <div className="mb-5 text-[11px] uppercase tracking-widest text-neutral-600">
        {items.length} {items.length === 1 ? 'artifact' : 'artifacts'}
      </div>
      {items.length === 0 ? (
        <p className="py-10 text-center text-sm text-neutral-600">
          No artifacts yet — generate HTML, React, SVG, Mermaid, or docs in a chat scoped to this
          project and they’ll appear here.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {items.map((artifact) => (
            <button
              key={artifact.id}
              onClick={() => setOpen(artifact)}
              className="group flex flex-col gap-2 rounded-lg border border-neutral-800/80 bg-neutral-900/30 p-4 text-left transition-colors hover:border-green-500/50 hover:bg-neutral-900/60"
            >
              <div className="flex items-center justify-between">
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-400">
                  {artifactKindLabel(artifact.kind)}
                </span>
                <span className="text-[10px] text-neutral-600">
                  {artifact.created ? timeAgo(new Date(artifact.created).toISOString()) : ''}
                </span>
              </div>
              <span className="min-w-0 truncate text-sm text-neutral-200 group-hover:text-white">
                {artifact.title}
              </span>
            </button>
          ))}
        </div>
      )}
      <AnimatePresence>
        {open && <ArtifactCanvas artifact={open} onClose={() => setOpen(null)} />}
      </AnimatePresence>
    </div>
  )
}
