'use client';

/**
 * DV-4 — Admin member-picker.
 *
 * A standalone Popover + cmdk combobox for an admin to pick the member
 * they are composing a broadcast on behalf of (the proxy-submit flow).
 * The trigger button shows the selected company name (or the placeholder)
 * and forwards `triggerRef` so the compose form can re-focus it when the
 * submit route returns `broadcast_member_not_found`.
 *
 * The server-search effect is a copy-adapt of the cancellable fetch in
 * `src/components/events/relink-registration-dialog.tsx:203-271`
 * (`useDeferredValue` + `fetchSeqRef` race-guard + `AbortController` +
 * zod-validated response). It is NOT an import — the two surfaces have
 * different shells (dialog vs popover) and different selection semantics.
 *
 * Popover/Button wiring follows this repo's Base UI primitives
 * (`src/components/members/member-picker.tsx`): `PopoverTrigger render={…}`
 * (Base UI render prop, NOT Radix `asChild`) and `var(--anchor-width)`
 * (Base UI anchor width, NOT `--radix-popover-trigger-width`).
 */

import { useEffect, useId, useRef, useState, useDeferredValue } from 'react';
import { z } from 'zod';
import { Check, ChevronsUpDown, Loader2Icon } from 'lucide-react';
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

export interface MemberPickerOption {
  readonly memberId: string;
  readonly companyName: string;
  readonly primaryContactName: string | null;
}

const SearchResponseSchema = z.object({
  items: z.array(
    z.object({
      memberId: z.string().uuid(),
      companyName: z.string(),
      primaryContactName: z.string().nullable(),
    }),
  ),
});

export interface MemberPickerProps {
  readonly value: MemberPickerOption | null;
  readonly onSelect: (m: MemberPickerOption | null) => void;
  readonly label: string;
  readonly placeholder: string;
  readonly searchFailedText: string;
  readonly emptyText: string;
  readonly loadingText: string;
  readonly disabled?: boolean;
  readonly triggerRef?: React.Ref<HTMLButtonElement>;
}

export function MemberPicker({
  value,
  onSelect,
  label,
  placeholder,
  searchFailedText,
  emptyText,
  loadingText,
  disabled,
  triggerRef,
}: MemberPickerProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<readonly MemberPickerOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const deferredSearch = useDeferredValue(search);
  const trimmedQuery = deferredSearch.trim();
  // fetch sequence counter — each effect run increments + captures the id;
  // only the most-recent in-flight request is allowed to mutate state, so
  // a slow earlier response can't clobber a fast later one across keystrokes.
  const fetchSeqRef = useRef(0);
  const labelId = useId();

  /* eslint-disable react-hooks/set-state-in-effect --
   * Legitimate data-fetching effect mirroring relink-registration-dialog.tsx:203-271
   * (cancellable fetch; `searching` flips synchronously on query change so the
   * loading row in the CommandList gives the user immediate feedback before the
   * network resolves — results depend on live server state, so the use-memo
   * alternative doesn't apply). */
  useEffect(() => {
    if (!open || trimmedQuery === '') return;
    const controller = new AbortController();
    fetchSeqRef.current += 1;
    const mySeq = fetchSeqRef.current;
    setSearching(true);
    setSearchError(false);
    void fetch(
      `/api/admin/members/search?q=${encodeURIComponent(trimmedQuery)}&limit=10`,
      { signal: controller.signal, headers: { Accept: 'application/json' } },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`member-search responded ${res.status}`);
        const parsed = SearchResponseSchema.safeParse(await res.json());
        if (!parsed.success) throw new Error('member-search response shape invalid');
        return parsed.data;
      })
      .then((data) => {
        if (mySeq !== fetchSeqRef.current) return; // stale response
        setResults(data.items);
      })
      .catch((err: unknown) => {
        // AbortError is thrown when the query changes mid-flight — expected.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (mySeq !== fetchSeqRef.current) return; // stale failure
        // Distinct from the empty state so a network-degraded admin isn't
        // told the member doesn't exist. Logged for E2E / local visibility.
        console.error('member-search fetch failed', err);
        setResults([]);
        setSearchError(true);
      })
      .finally(() => {
        if (mySeq !== fetchSeqRef.current) return; // stale finalize
        setSearching(false);
      });
    return () => controller.abort();
  }, [trimmedQuery, open]);

  useEffect(() => {
    if (!open) {
      setSearch('');
      setResults([]);
      setSearching(false);
      setSearchError(false);
    }
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const emptyMessage = searchError ? searchFailedText : emptyText;
  // Visible results — empty when the user has cleared the input so stale
  // results from a previous query don't briefly flash and stay selectable
  // under an empty search box (mirrors relink-registration-dialog.tsx:295).
  const visibleResults = trimmedQuery === '' ? [] : results;

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium">
        {label}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              ref={triggerRef}
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-labelledby={labelId}
              disabled={disabled}
              className="h-9 w-full justify-between font-normal"
            />
          }
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value ? value.companyName : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" aria-hidden />
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--anchor-width)] max-w-[calc(100vw-2rem)] p-0"
          align="start"
        >
          <Command shouldFilter={false}>
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder={placeholder}
            />
            <CommandList>
              {searching && (
                // role="status" has an implicit aria-live="polite"; the
                // explicit attribute makes the announcement reliable across
                // older SR implementations. Mirrors members/member-picker.tsx.
                <div
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground"
                >
                  <Loader2Icon
                    className="size-4 motion-safe:animate-spin"
                    aria-hidden
                  />
                  <span>{loadingText}</span>
                </div>
              )}
              {/* Only show the empty-state after a real search ran and
                  returned nothing — never on an empty query before a search,
                  and never while a fetch is in flight. */}
              {trimmedQuery !== '' && !searching && (
                <CommandEmpty>{emptyMessage}</CommandEmpty>
              )}
              <CommandGroup>
                {visibleResults.map((m) => (
                  <CommandItem
                    key={m.memberId}
                    value={m.memberId}
                    onSelect={() => {
                      onSelect(m);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 size-4',
                        value?.memberId === m.memberId
                          ? 'opacity-100'
                          : 'opacity-0',
                      )}
                      aria-hidden
                    />
                    <span className="flex flex-col">
                      <span>{m.companyName}</span>
                      {m.primaryContactName && (
                        <span className="text-xs text-muted-foreground">
                          {m.primaryContactName}
                        </span>
                      )}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
