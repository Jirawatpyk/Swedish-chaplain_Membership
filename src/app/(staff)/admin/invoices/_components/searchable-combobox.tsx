/**
 * SearchableCombobox — cmdk-backed popover combobox for F4 forms
 * where a plain <select> would be unusable at 100+ rows (member
 * picker, plan picker if we ever grow the catalogue).
 *
 * Composes existing UI primitives:
 *   - `@/components/ui/popover` (Base UI) for the anchor + positioner
 *   - `@/components/ui/command` (cmdk) for search + virtualised list
 *   - `@/components/ui/button` for the trigger
 *
 * Controlled: caller owns `value` + `onChange`. Returns the option's
 * stable id (e.g. UUID). Filter matches against the option's `label`
 * via cmdk's built-in fuzzy match.
 */
'use client';

import * as React from 'react';
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type ComboboxOption = {
  readonly value: string;
  readonly label: string;
  /** Optional right-aligned metadata (e.g. annual fee) */
  readonly detail?: string;
};

export function SearchableCombobox({
  options,
  value,
  onChange,
  placeholder,
  emptyMessage,
  searchPlaceholder,
  ariaLabel,
  disabled,
  id,
}: {
  readonly options: readonly ComboboxOption[];
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder: string;
  readonly emptyMessage: string;
  readonly searchPlaceholder: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly id?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={ariaLabel}
            disabled={disabled}
            className="w-full justify-between"
          />
        }
      >
        <span className={cn('truncate', !selected && 'text-muted-foreground')}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronsUpDownIcon className="ml-2 size-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-[var(--anchor-width)] min-w-[20rem] p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  keywords={[o.label]}
                  onSelect={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className="flex cursor-pointer items-center justify-between gap-2"
                >
                  <span className="flex items-center gap-2">
                    <CheckIcon
                      className={cn(
                        'size-4',
                        value === o.value ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    {o.label}
                  </span>
                  {o.detail && (
                    <span className="ml-auto text-xs text-muted-foreground">{o.detail}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
