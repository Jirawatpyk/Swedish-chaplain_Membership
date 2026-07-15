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
 *
 * `allowCustomValue` (PR-B task 6 review fix, Critical 1): this trigger is a
 * `<button>`, not an `<input>` — with no matching option there is otherwise
 * NO way to commit a value at all (Enter on an empty filtered list is a
 * no-op). Off by default, since a combobox backed by a closed enumerable
 * set (e.g. the ISO country list below) must never accept free text. Opt in
 * only where the option list is a legitimately incomplete filter over a
 * larger domain (e.g. Thai province/district/sub-district names narrowed by
 * postcode) — there, "no match" must never mean "no way forward". The
 * search box is CONTROLLED (`CommandInput value/onValueChange`) so the
 * typed text is available to render a "Use «text»" `CommandItem`; that item
 * is `forceMount`ed so cmdk's own relevance filter can never hide it, and
 * because cmdk tracks its keyboard-navigation "selected" item via a plain
 * DOM query over rendered `[cmdk-item]` elements (not a React-level list),
 * the forceMounted item is a real member of the arrow-key rotation like any
 * other option — `role="option"`, `aria-selected` toggles onto it exactly
 * like a normal item, and Enter commits whichever item currently holds
 * that state, so it is never a mouse-only affordance.
 *
 * `ComboboxProps` makes `customValueLabel` a REQUIRED companion of
 * `allowCustomValue` at the type level (a discriminated union — see below),
 * not an optional prop with an untranslated runtime fallback. A hardcoded
 * `Use "…"` string living in `components/ui/` is invisible to
 * `pnpm check:i18n` (it only scans `i18n/messages/*.json` + `t(...)`
 * call-sites), so the type checker is the enforcement mechanism instead:
 * a caller that sets `allowCustomValue` without `customValueLabel` fails
 * to compile.
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

type ComboboxCommonProps = {
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

/**
 * Discriminated on `allowCustomValue` (a11y re-review Minor fix): a bare
 * `allowCustomValue?: boolean` + `customValueLabel?: fn` pair let a caller
 * opt into the creatable-combobox affordance while forgetting the label,
 * silently falling back to a hardcoded English string that `pnpm
 * check:i18n` cannot see (it lives in `components/ui/`, not
 * `i18n/messages/*.json`). Splitting into a union makes that combination a
 * COMPILE error instead — the next consumer cannot get it wrong.
 */
export type ComboboxProps =
  | (ComboboxCommonProps & {
      /** Off by default — see the file-header comment. */
      readonly allowCustomValue?: false | undefined;
      readonly customValueLabel?: undefined;
    })
  | (ComboboxCommonProps & {
      /** Opt-in creatable-combobox affordance — see the file-header comment. */
      readonly allowCustomValue: true;
      /** Formats the "commit the typed text" item's label, e.g.
       * `(typed) => tf('useTypedValueLabel', { value: typed })`. REQUIRED
       * whenever `allowCustomValue` is set — there is no untranslated
       * fallback; every call site must pass a translated one. */
      readonly customValueLabel: (typed: string) => string;
    });

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
  allowCustomValue,
  customValueLabel,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [listboxId, setListboxId] = React.useState<string | undefined>(undefined);
  // Controlled search text (only needed to power `allowCustomValue`'s "Use
  // «text»" item below) — reset on every close via `captureListboxId`'s
  // unmount branch so reopening the popover always starts from a blank
  // search, matching cmdk's own uncontrolled behaviour.
  const [search, setSearch] = React.useState('');
  const selected = options.find((o) => o.value === value);

  // Window-scroll guard for the open transition.
  //
  // When the popover opens with a value already selected (e.g. the member
  // form's Country field defaults to Thailand), cmdk scrolls the selected
  // command item into view with `scrollIntoView({ block: 'nearest' })` the
  // instant the list mounts. Base UI's Positioner has not fixed-positioned
  // the portaled popup yet at that moment, so the item still sits in document
  // flow near the top — and the scroll bubbles up to the WINDOW, jerking the
  // whole page to the top. (An unselected combobox — the address district
  // pickers — has no item to scroll to, so it never triggers this.) Base UI's
  // own focus-on-open can bubble a scroll the same way. We snapshot the window
  // scroll offset the moment the popover opens and restore it in a layout
  // effect below — which, being an ancestor effect, runs AFTER cmdk's own
  // child effect but BEFORE paint, so the stray scroll never shows.
  const scrollRestoreRef = React.useRef<{ x: number; y: number } | null>(null);
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (disabled) return;
      if (nextOpen) scrollRestoreRef.current = { x: window.scrollX, y: window.scrollY };
      setOpen(nextOpen);
    },
    [disabled],
  );
  React.useLayoutEffect(() => {
    if (!open) return;
    const target = scrollRestoreRef.current;
    if (!target) return;
    const restore = () => {
      if (window.scrollX !== target.x || window.scrollY !== target.y) {
        window.scrollTo(target.x, target.y);
      }
    };
    // Immediate pass catches a same-commit scroll (Base UI's focus-on-open on
    // an unselected combobox). cmdk's selected-item scroll is different: its
    // `ce` runs in a layout effect that a *self-scheduled* setState defers to a
    // LATER synchronous commit — after this effect has already run — so we also
    // restore on the next animation frame, which fires after every synchronous
    // commit in this task but before paint, so the stray scroll never shows.
    restore();
    const raf = requestAnimationFrame(() => {
      restore();
      scrollRestoreRef.current = null;
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Ref callback (not useRef+useEffect) so this fires in the SAME commit
  // that mounts/unmounts the Command tree, regardless of exactly when Base
  // UI's own portal mount lands relative to the `open` state flip. See the
  // file-header comment for why we can't just set `id` on `<CommandList>`.
  const captureListboxId = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      setListboxId(undefined);
      setSearch('');
      return;
    }
    setListboxId(node.querySelector<HTMLElement>('[cmdk-list]')?.id);
  }, []);

  const trimmedSearch = search.trim();
  const showCustomValueItem =
    Boolean(allowCustomValue) &&
    trimmedSearch !== '' &&
    !options.some((o) => o.value === trimmedSearch);

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
    <Popover open={open} onOpenChange={handleOpenChange}>
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
          {/* Task 6 review fix: a value committed via `allowCustomValue` is
              NOT in `options` (it was typed, not selected), so `selected`
              above is `undefined` for it — display the raw committed value
              instead of falling through to the placeholder. Fixed at the
              primitive so a consumer opting into `allowCustomValue` never
              has to re-inject the value into `options` itself (the trap
              `address-section.tsx`'s `withCurrentValue` helper worked around
              for its own three fields, but the next consumer would not know
              to repeat). */}
          {selected?.label ?? (allowCustomValue && value ? value : placeholder)}
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
            <CommandInput
              placeholder={searchPlaceholder}
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              {/* Suppressed once the custom-value item is showing — "No
                  district found." next to "Use «text»" is redundant noise,
                  not information. */}
              {!showCustomValueItem && <CommandEmpty>{emptyMessage}</CommandEmpty>}
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
                      className="flex cursor-pointer items-start gap-2"
                    >
                      <CheckIcon
                        className={cn(
                          'mt-0.5 size-4 shrink-0',
                          value === o.value ? 'opacity-100' : 'opacity-0',
                        )}
                        aria-hidden="true"
                      />
                      {/* Label over detail, not side by side. The popup is
                          `--anchor-width` — the trigger's width — and the
                          address fields sit in a 3-column grid, so a Thai
                          sub-district and its English romanisation on one
                          line ("คลองตันเหนือ  Khlong Tan Nuea") collide at
                          ~280px. Widening the popup past the anchor is not
                          an option: a `min-w-[20rem]` once overflowed a
                          320px viewport (searchable-combobox.tsx:82-84).
                          `min-w-0` is what actually lets `truncate` work —
                          a flex child's default `min-width:auto` refuses to
                          shrink below its content. */}
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{o.label}</span>
                        {o.detail && (
                          <span className="truncate text-xs text-muted-foreground">
                            {o.detail}
                          </span>
                        )}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
              {showCustomValueItem && customValueLabel && (
                // `forceMount`: cmdk's own relevance filter would otherwise
                // hide this item whenever the typed text doesn't fuzzy-match
                // its own value string — it must ALWAYS be selectable while
                // visible, that's the whole point (Critical 1 fix).
                // `customValueLabel &&`: narrows the union's `| undefined`
                // for the type checker. Never actually undefined here at
                // runtime — `showCustomValueItem` is only true when
                // `allowCustomValue` is, and the `ComboboxProps` union makes
                // `customValueLabel` required whenever `allowCustomValue` is.
                <CommandItem
                  value={`__custom-value__${trimmedSearch}`}
                  forceMount
                  onSelect={() => {
                    onChange(trimmedSearch);
                    setOpen(false);
                  }}
                  className="cursor-pointer italic"
                >
                  {customValueLabel(trimmedSearch)}
                </CommandItem>
              )}
            </CommandList>
          </Command>
        </div>
      </PopoverContent>
    </Popover>
  );
}
