import { CaretDown } from '@phosphor-icons/react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'

export interface SettingsSelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

export function SettingsSelect<T extends string>({
  id,
  label,
  value,
  options,
  placeholder,
  disabled = false,
  onValueChange
}: {
  id: string
  label: string
  value: T
  options: readonly SettingsSelectOption<T>[]
  placeholder?: string
  disabled?: boolean
  onValueChange: (value: T) => void
}): React.JSX.Element {
  const selected = options.find((option) => option.value === value)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          id={id}
          type="button"
          aria-label={label}
          className="flex w-full items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-left text-xs text-neutral-200 outline-none transition-colors hover:border-neutral-700 focus-visible:border-green-500 focus-visible:ring-2 focus-visible:ring-green-500/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="truncate">
            {selected?.label ?? (options.length === 0 ? placeholder : undefined) ?? value}
          </span>
          <CaretDown aria-hidden className="size-3.5 shrink-0 text-neutral-500" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onEscapeKeyDown={(event) => event.stopPropagation()}
        className="max-h-64 w-(--radix-dropdown-menu-trigger-width) min-w-56 border-neutral-800 bg-neutral-950 text-neutral-200 shadow-none"
      >
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(nextValue) => onValueChange(nextValue as T)}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              className="text-xs focus:bg-green-500/15 focus:text-green-300"
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
