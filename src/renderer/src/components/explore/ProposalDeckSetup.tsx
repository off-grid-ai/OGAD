import { useState } from 'react'
import { FolderOpen } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import type { DemoPreset } from './presetCatalog'

const DEFAULT_OUTPUT = '/Users/user/wednesday/cro/proposals'
const EXAMPLE_STYLE = '/Users/user/wednesday/cro/proposals/ABSLI'

interface ProposalDeckSetupProps {
  preset: DemoPreset
  onRun: (preset: DemoPreset) => void
  onCancel: () => void
}

interface FolderFieldProps {
  id: string
  label: string
  help: string
  value: string
  onChange: (value: string) => void
}

function FolderField({ id, label, help, value, onChange }: FolderFieldProps): React.ReactElement {
  const chooseFolder = async (): Promise<void> => {
    const selected = await window.api.pickLocalFolder({
      title: label,
      ...(value ? { defaultPath: value } : {})
    })
    if (selected) onChange(selected)
  }
  return (
    <div>
      <label htmlFor={id} className="text-[10px] uppercase tracking-wide text-neutral-500">
        {label}
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-[11px] text-neutral-200 outline-none focus:border-green-600"
          spellCheck={false}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void chooseFolder()}
          aria-label={`Browse for ${label.toLowerCase()}`}
        >
          <FolderOpen />
          Browse
        </Button>
      </div>
      <p className="mt-1 text-[10px] leading-4 text-neutral-600">{help}</p>
    </div>
  )
}

export function ProposalDeckSetup({
  preset,
  onRun,
  onCancel
}: ProposalDeckSetupProps): React.ReactElement {
  const [sourceFolder, setSourceFolder] = useState('')
  const [outputFolder, setOutputFolder] = useState(DEFAULT_OUTPUT)
  const [styleFolder, setStyleFolder] = useState(EXAMPLE_STYLE)
  const canStart = sourceFolder.trim() && outputFolder.trim()

  const start = (): void => {
    if (!canStart) return
    const prompt = [
      preset.prompt,
      `I selected this content folder: ${sourceFolder.trim()}`,
      `Save the completed deck under this folder: ${outputFolder.trim()}`,
      styleFolder.trim()
        ? `Use this folder only as a visual style example: ${styleFolder.trim()}`
        : 'Use the standard Off Grid AI presentation style.',
      'These are the only local folders I authorize for this proposal.'
    ].join('\n')
    onRun({ ...preset, prompt })
  }

  return (
    <div
      className="col-span-full rounded-md border border-neutral-700 bg-neutral-950 p-3"
      data-testid="proposal-deck-setup"
    >
      <div className="mb-3">
        <h4 className="text-xs text-neutral-100">Choose your proposal files</h4>
        <p className="mt-1 text-[11px] text-neutral-500">
          Off Grid AI reads the content folder and saves the finished deck where you choose.
        </p>
      </div>
      <div className="grid gap-3 @3xl:grid-cols-2">
        <FolderField
          id="proposal-source-folder"
          label="Content folder"
          help="Required. Choose the notes, proof, prior copy, and client material for this deck."
          value={sourceFolder}
          onChange={setSourceFolder}
        />
        <FolderField
          id="proposal-output-folder"
          label="Save under"
          help="A new company folder is created here. Existing work stays unchanged."
          value={outputFolder}
          onChange={setOutputFolder}
        />
        <FolderField
          id="proposal-style-folder"
          label="Style example (optional)"
          help="ABSLI is an example. Choose any deck folder, or leave this blank."
          value={styleFolder}
          onChange={setStyleFolder}
        />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={!canStart} onClick={start}>
          Start in chat
        </Button>
      </div>
    </div>
  )
}
