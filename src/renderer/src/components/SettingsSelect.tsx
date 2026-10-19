import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue
} from '@offgrid/operator-ui/operator/coss/select'
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup
} from '@offgrid/operator-ui/operator/coss/combobox'

// Portals are appended to body. Match SidePanel's top layer so a popup opened from
// a panel paints after it and can receive pointer input instead of sitting behind it.
// Fixed at the viewport origin with no size: the positioner measures from (0, 0), as it computes.
// A `relative` container sat wherever the body's flow put it (its right edge), so for the first
// frame the popup landed a whole window width off to the right and below the window; the page
// grew to twice its width and the view behind the panel scrolled sideways.
const popupPortalProps = {
  style: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    width: 0,
    height: 0,
    zIndex: 2147483647
  }
}

export interface SettingsSelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
  hint?: string
  /** Capability meta shown muted on the right of the row, so the list helps you choose. */
  meta?: React.ReactNode
}

// The library keeps a 1rem column on every row for the selected item's check mark. A list with no
// selected option (a model slot offers only the OTHER models) never draws that mark, so the empty
// column only pushed every label right: collapse it there, and labels sit flush under the input.
// A list that does show a selection keeps the column, so its check mark has room.
const unselectableItemClassName =
  '!grid-cols-[0px_minmax(0,1fr)] !gap-0 ps-[calc(--spacing(2.5)-1px)] pe-2'

// Every settings picker. A long list (installed models) is searchable, so it is a combobox you
// type into; everything else is a plain select whose options roll open from the trigger.
export function SettingsSelect<T extends string>({
  id,
  label,
  value,
  options,
  placeholder,
  searchable = false,
  disabled = false,
  onValueChange
}: {
  id: string
  label: string
  value: T
  options: readonly SettingsSelectOption<T>[]
  placeholder?: string
  searchable?: boolean
  disabled?: boolean
  onValueChange: (value: T) => void
}): React.JSX.Element {
  const selected = options.find((option) => option.value === value)

  if (searchable) {
    return (
      <Combobox<SettingsSelectOption<T>>
        items={options}
        value={selected ?? null}
        onValueChange={(option) => {
          if (option) onValueChange(option.value)
        }}
        itemToStringLabel={(option) => option.label}
        isItemEqualToValue={(option, current) => option.value === current.value}
        disabled={disabled}
      >
        <ComboboxInput
          id={id}
          size="sm"
          aria-label={label}
          placeholder={options.length === 0 ? placeholder : 'Search models'}
          triggerProps={{ 'aria-label': `Show ${label.toLowerCase()} options` }}
        />
        <ComboboxPopup portalProps={popupPortalProps}>
          <ComboboxEmpty>No matching models.</ComboboxEmpty>
          <ComboboxList>
            {(option: SettingsSelectOption<T>) => (
              <ComboboxItem
                key={option.value}
                value={option}
                disabled={option.disabled}
                className={selected ? undefined : unselectableItemClassName}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{option.label}</span>
                  {option.meta ? (
                    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      {option.meta}
                    </span>
                  ) : null}
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    )
  }

  return (
    // Not modal: a modal select locks page scroll while open (overflow hidden on the document and a
    // resized body), which reflows the window under a side panel and makes the whole panel jump.
    <Select
      modal={false}
      value={value}
      onValueChange={(next) => {
        if (next != null) onValueChange(next as T)
      }}
      items={options.map((option) => ({ value: option.value, label: option.label }))}
      disabled={disabled}
    >
      <SelectTrigger id={id} size="sm" aria-label={label}>
        <SelectValue>
          {() =>
            selected?.label ??
            (options.length === 0 || value === '' ? placeholder : undefined) ??
            value
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup portalProps={popupPortalProps}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            <span>
              <span className="block">{option.label}</span>
              {option.hint && (
                <span className="block text-xs text-muted-foreground">{option.hint}</span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  )
}
