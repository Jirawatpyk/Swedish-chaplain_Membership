'use client';

/**
 * Combobox — ARIA-complete cmdk-backed popover combobox.
 *
 * Promoted from `src/app/(staff)/admin/invoices/_components/searchable-
 * combobox.tsx` (PR-B task 5) with the five ARIA hooks that file was
 * missing, taken from `src/components/members/member-picker.tsx:254-261`
 * (the shipped ARIA reference): `aria-expanded`, `aria-haspopup="listbox"`,
 * `aria-controls`, `aria-labelledby`, `aria-describedby`. The old
 * `ariaLabel` prop is deliberately NOT carried forward — it would detach
 * the accessible name from the caller's visible `<Label>` and break the
 * FieldError + FormErrorSummary wiring the member form depends on.
 * `aria-labelledby` is required to name the control instead.
 *
 * `id` is a required prop (not internally generated) so the caller's
 * `<Label htmlFor={id}>` names the trigger deterministically — the trigger
 * renders `id={id}`.
 *
 * The listbox's own id is a DIFFERENT story: cmdk generates `CommandList`'s
 * id internally via its own `useId()` call and unconditionally overwrites
 * any `id` prop passed to `<CommandList>` (verified against cmdk@1.1.1's
 * source — `{...c, id: b.listId}`, the internal id always wins the spread).
 * So `aria-controls` cannot be pre-computed; it is captured off the REAL
 * rendered node via a ref callback on a `[cmdk-list]` ancestor — cmdk
 * documents `[cmdk-list]` as a stable public selector for CSS targeting,
 * so reading it back is not reverse-engineering an implementation detail.
 * `aria-controls` is therefore absent while the popover is closed (there is
 * nothing to point at — Base UI unmounts the popup content) and appears
 * only once the listbox actually exists in the DOM.
 *
 * Composes existing UI primitives:
 *   - `@/components/ui/popover` (Base UI) for the anchor + positioner —
 *     built-in Escape-to-close + return-focus-to-trigger (floating-ui-
 *     react's useDismiss / FloatingFocusManager), no custom handling needed.
 *   - `@/components/ui/command` (cmdk) for search + listbox.
 *   - `@/components/ui/button` for the trigger.
 */
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
  /** Optional right-aligned metadata (e.g. annual fee). */
  readonly detail?: string;
  /** Optional group heading; options sharing a group render under it. */
  readonly group?: string;
};

export type ComboboxProps = {
  readonly options: readonly ComboboxOption[];
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder: string;
  readonly searchPlaceholder: string;
  readonly emptyMessage: string;
  readonly id: string;
  // `| undefined` (not just `?:`) on every optional prop below: under
  // `exactOptionalPropertyTypes`, a caller that FORWARDS its own optional
  // prop (e.g. `country-combobox.tsx` passing through a possibly-`undefined`
  // `aria-labelledby`) assigns the key with an explicit `undefined` value,
  // which `?: string` alone rejects.
  readonly 'aria-labelledby'?: string | undefined;
  readonly 'aria-describedby'?: string | undefined;
  readonly 'aria-invalid'?: boolean | undefined;
  readonly 'aria-required'?: boolean | undefined;
  readonly disabled?: boolean | undefined;
};

export function Combobox({
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  id,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  'aria-required': ariaRequired,
  disabled,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [listboxId, setListboxId] = React.useState<string | undefined>(undefined);
  const selected = options.find((o) => o.value === value);

  // Ref callback (not useRef+useEffect) so this fires in the SAME commit
  // that mounts/unmounts the Command tree, regardless of exactly when Base
  // UI's own portal mount lands relative to the `open` state flip. See the
  // file-header comment for why we can't just set `id` on `<CommandList>`.
  const captureListboxId = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      setListboxId(undefined);
      return;
    }
    setListboxId(node.querySelector<HTMLElement>('[cmdk-list]')?.id);
  }, []);

  // Preserve first-appearance order of each group (Map iteration order
  // matches insertion order in JS) — the caller controls group order by
  // the order options appear in, e.g. "Suggested" before "All countries".
  const groups = React.useMemo(() => {
    const byGroup = new Map<string | undefined, ComboboxOption[]>();
    for (const opt of options) {
      const bucket = byGroup.get(opt.group);
      if (bucket) bucket.push(opt);
      else byGroup.set(opt.group, [opt]);
    }
    return Array.from(byGroup.entries());
  }, [options]);

  return (
    <Popover open={open} onOpenChange={(nextOpen) => !disabled && setOpen(nextOpen)}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-labelledby={ariaLabelledBy}
            aria-describedby={ariaDescribedBy}
            aria-invalid={ariaInvalid}
            aria-required={ariaRequired}
            disabled={disabled}
            className="w-full justify-between font-normal"
          />
        }
      >
        <span className={cn('truncate', !selected && 'text-muted-foreground')}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronsUpDownIcon className="ml-2 size-4 shrink-0 opacity-50" aria-hidden="true" />
      </PopoverTrigger>
      {/* L6 (searchable-combobox.tsx): dropped min-w-[20rem]=320px which
          overflowed smallest-viewport mobile (iPhone SE 320px). Popover
          sizes to its anchor with a max of viewport − 2rem gutter — do
          not reintroduce a min-width. */}
      <PopoverContent
        className="w-[var(--anchor-width)] max-w-[calc(100vw-2rem)] p-0"
        align="start"
      >
        {/* `display: contents` — purely a ref anchor to read cmdk's real
            listbox id back; must not participate in Command's own flex
            layout (see file-header comment). */}
        <div ref={captureListboxId} className="contents">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyMessage}</CommandEmpty>
              {groups.map(([group, opts]) => (
                <CommandGroup key={group ?? '__ungrouped'} heading={group}>
                  {opts.map((o) => (
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
                          aria-hidden="true"
                        />
                        {o.label}
                      </span>
                      {o.detail && (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {o.detail}
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </div>
      </PopoverContent>
    </Popover>
  );
}
