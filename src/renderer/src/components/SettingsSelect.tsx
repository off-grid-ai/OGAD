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
const popupPortalProps = { style: { position: 'relative' as const, zIndex: 2147483647 } }

export interface SettingsSelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
  hint?: string
}

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
              <ComboboxItem key={option.value} value={option} disabled={option.disabled}>
                {option.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    )
  }

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next != null) onValueChange(next as T)
      }}
      items={options.map((option) => ({ value: option.value, label: option.label }))}
      disabled={disabled}
    >
      <SelectTrigger id={id} size="sm" aria-label={label}>
        <SelectValue>
          {() => selected?.label ?? (options.length === 0 ? placeholder : undefined) ?? value}
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
