'use client';

/**
 * MemberPicker — reusable combobox for selecting an existing member.
 *
 * Powers the F1 spec:672-678 "link to member" field on the admin
 * invite dialog, and any future surface that needs to pick a member
 * by search.
 *
 * Props:
 *   - value: MemberId | null — currently selected member id
 *   - onChange: (id: MemberId | null) => void — selection callback
 *   - disabled?: boolean — disables the trigger (used when role !== member)
 *   - disabledHint?: string — tooltip-like copy shown in place of the
 *     placeholder when disabled
 *
 * Behaviour:
 *   - Opens a Popover-anchored cmdk list fetched from
 *     `GET /api/members?q=...&limit=20`.
 *   - 200ms debounce on search input to limit request rate while typing.
 *   - Empty state + loading state inside the dropdown.
 *   - Clear button next to the selection chip.
 *   - Escape closes, Enter selects the highlighted row.
 *   - ARIA combobox pattern — the trigger has `role="combobox"` +
 *     `aria-expanded`, and `aria-controls` pointing to the listbox.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';
import { CheckIcon, ChevronsUpDownIcon, Loader2Icon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';

export interface MemberPickerOption {
  readonly member_id: string;
  readonly company_name: string;
  readonly country: string;
  readonly status: string;
}

interface ApiRow {
  readonly member_id: string;
  readonly company_name: string;
  readonly country: string;
  readonly status: string;
}

interface ApiResponse {
  readonly items?: readonly ApiRow[];
}

export interface MemberPickerProps {
  readonly value: string | null;
  readonly onChange: (id: string | null) => void;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly 'aria-labelledby'?: string;
}

const DEBOUNCE_MS = 200;
const FETCH_LIMIT = 20;

export function MemberPicker({
  value,
  onChange,
  disabled = false,
  id,
  'aria-labelledby': ariaLabelledBy,
}: MemberPickerProps) {
  const t = useTranslations('admin.users.invite.linkMember');
  const reactId = useId();
  const listboxId = id ?? `member-picker-${reactId}`;

  const [open, setOpen] = useState(false);
  const [rawInput, setRawInput] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<readonly MemberPickerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<MemberPickerOption | null>(null);

  // Derived: if external value clears, drop the cached chip. Calculated
  // during render — no effect needed (React docs: "You Might Not Need
  // an Effect").
  const effectiveSelected = value === null ? null : selected;

  // Debounce the search input.
  useEffect(() => {
    const handle = setTimeout(() => setQuery(rawInput.trim()), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [rawInput]);

  // Fetch members when popover opens OR the debounced query changes.
  // The `setLoading(true)` lives inside the async IIFE (not synchronously
  // in the effect body) to avoid the set-state-in-effect lint — React
  // schedules both state updates in the same batch either way.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();

    const run = async () => {
      setLoading(true);
      const params = new URLSearchParams({ limit: String(FETCH_LIMIT) });
      if (query.length > 0) params.set('q', query);
      try {
        const r = await fetch(`/api/members?${params.toString()}`, {
          method: 'GET',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        const data: ApiResponse = r.ok ? ((await r.json()) as ApiResponse) : { items: [] };
        if (cancelled) return;
        const rows = data.items ?? [];
        setItems(
          rows.map((row) => ({
            member_id: row.member_id,
            company_name: row.company_name,
            country: row.country,
            status: row.status,
          })),
        );
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, query]);

  const handleSelect = useCallback(
    (option: MemberPickerOption) => {
      setSelected(option);
      onChange(option.member_id);
      setOpen(false);
      setRawInput('');
    },
    [onChange],
  );

  const handleClear = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setSelected(null);
      onChange(null);
    },
    [onChange],
  );

  const clearRef = useRef<HTMLButtonElement>(null);

  return (
    <Popover open={open} onOpenChange={(nextOpen) => !disabled && setOpen(nextOpen)}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-labelledby={ariaLabelledBy}
            disabled={disabled}
            className={cn(
              'w-full justify-between font-normal',
              !effectiveSelected && 'text-muted-foreground',
            )}
          />
        }
      >
        <span className="truncate">
          {disabled
            ? t('disabledHint')
            : effectiveSelected
              ? effectiveSelected.company_name
              : t('placeholder')}
        </span>
        <span className="ms-2 flex shrink-0 items-center gap-1">
          {effectiveSelected && !disabled ? (
            <span
              ref={clearRef}
              role="button"
              tabIndex={0}
              aria-label={t('clear')}
              onClick={handleClear}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelected(null);
                  onChange(null);
                }
              }}
              className="rounded-sm p-0.5 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <XIcon className="size-3.5" aria-hidden />
            </span>
          ) : null}
          <ChevronsUpDownIcon className="size-4 opacity-50" aria-hidden />
        </span>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            id={listboxId}
            placeholder={t('placeholder')}
            value={rawInput}
            onValueChange={setRawInput}
          />
          <CommandList>
            {loading ? (
              <div
                role="status"
                className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground"
              >
                <Loader2Icon className="size-4 animate-spin" aria-hidden />
                <span>{t('loading')}</span>
              </div>
            ) : items.length === 0 ? (
              <CommandEmpty>{t('noMembersFound')}</CommandEmpty>
            ) : (
              items.map((opt) => {
                const isSelected = value === opt.member_id;
                return (
                  <CommandItem
                    key={opt.member_id}
                    value={opt.member_id}
                    onSelect={() => handleSelect(opt)}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="truncate font-medium">
                        {opt.company_name}
                      </span>
                      <span className="inline-flex items-center rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {opt.country}
                      </span>
                      <span className="inline-flex items-center rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {opt.status}
                      </span>
                    </div>
                    {isSelected ? (
                      <CheckIcon className="ms-auto size-4" aria-hidden />
                    ) : null}
                  </CommandItem>
                );
              })
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
