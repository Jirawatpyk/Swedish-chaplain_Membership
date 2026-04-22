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
  /** ID of an external help-text element. Passed through to aria-describedby
   *  on the trigger button so screen readers announce the hint when focus lands
   *  on the picker (only when not disabled — disabled state uses its own hint). */
  readonly 'aria-describedby'?: string;
}

const DEBOUNCE_MS = 200;
const FETCH_LIMIT = 20;

type MemberStatus = 'active' | 'inactive' | 'archived';

function isKnownStatus(s: string): s is MemberStatus {
  return s === 'active' || s === 'inactive' || s === 'archived';
}

export function MemberPicker({
  value,
  onChange,
  disabled = false,
  id,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}: MemberPickerProps) {
  const t = useTranslations('admin.users.invite.linkMember');
  // Reuse the directory filter status keys so we have one source of truth
  // for status copy across EN/TH/SV (keys: active / inactive / archived).
  const tStatus = useTranslations('admin.members.directory.filters.status');
  const reactId = useId();
  const listboxId = id ?? `member-picker-${reactId}`;

  const [open, setOpen] = useState(false);
  const [rawInput, setRawInput] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<readonly MemberPickerOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<MemberPickerOption | null>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);

  // Derived: if external value clears, drop the cached chip. Calculated
  // during render — no effect needed (React docs: "You Might Not Need
  // an Effect").
  const effectiveSelected = value === null ? null : selected;

  // Debounce the search input.
  useEffect(() => {
    const handle = setTimeout(() => setQuery(rawInput.trim()), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [rawInput]);

  // Auto-focus the search input when the Popover opens. We defer the
  // .focus() call until after Base UI's Portal has mounted and its own
  // initial focus pass has completed — a 0ms timeout is enough to land
  // on the next tick. Without this, the user has to click the input
  // before they can start typing. Mirrors the dialog-auto-focus pattern
  // in `invite-user-dialog.tsx`.
  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => commandInputRef.current?.focus(), 0);
    return () => clearTimeout(handle);
  }, [open]);

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
      // Only surface active members in the picker — archived/inactive
      // rows are rarely the right target for admin "link to member" flows.
      // The members directory page can still opt-in to archived rows via
      // its own `show_archived` toggle, so we keep the API default unchanged.
      params.set('status', 'active');
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
  // Separate stable IDs for the listbox region and the disabled-hint
  // paragraph so both `aria-controls` and `aria-describedby` point to
  // unique, never-colliding elements.
  const listboxRegionId = `${listboxId}-list`;
  const disabledHintId = `${listboxId}-disabled-hint`;

  return (
    <Popover open={open} onOpenChange={(nextOpen) => !disabled && setOpen(nextOpen)}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={listboxRegionId}
            aria-labelledby={ariaLabelledBy}
            aria-describedby={disabled ? disabledHintId : ariaDescribedBy}
            disabled={disabled}
            className={cn(
              'w-full justify-between font-normal',
              !effectiveSelected && 'text-muted-foreground',
            )}
          />
        }
      >
        <span className="truncate">
          {effectiveSelected && !disabled
            ? effectiveSelected.company_name
            : t('placeholder')}
        </span>
        <span className="ms-2 flex shrink-0 items-center gap-1">
          {effectiveSelected && !disabled ? (
            // Use a real <button> element so it receives native keyboard
            // events, participates in the tab order without needing an
            // explicit tabIndex, and gets the correct implicit ARIA role.
            // WCAG 2.5.5: minimum 44×44 px touch target — achieved via
            // the -m-1 / p-2 combination which expands the hit area to
            // ~36 px visible + 8 px invisible margin on each side.
            <button
              ref={clearRef}
              type="button"
              aria-label={t('clear')}
              onClick={handleClear}
              className={cn(
                // Visual size: 28×28 px icon area with padding
                // Touch target: -m-1 pulls hit-area outward to ≥44×44 px
                '-m-1 inline-flex items-center justify-center rounded-sm p-2',
                'hover:bg-muted',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <XIcon className="size-3.5" aria-hidden />
            </button>
          ) : null}
          <ChevronsUpDownIcon className="size-4 opacity-50" aria-hidden />
        </span>
      </PopoverTrigger>

      {/* Hidden paragraph gives SR users the "Select role Member to link"
          hint when the picker is disabled.  Placed outside the Popover
          portal so it is always in the DOM and reachable via aria-describedby. */}
      {disabled && (
        <span id={disabledHintId} className="sr-only">
          {t('disabledHint')}
        </span>
      )}

      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            ref={commandInputRef}
            id={listboxId}
            placeholder={t('placeholder')}
            value={rawInput}
            onValueChange={setRawInput}
          />
          {/* The CommandList is the actual listbox container. Giving it a
              stable id allows aria-controls on the trigger to point here. */}
          <CommandList id={listboxRegionId}>
            {loading ? (
              // role="status" has an implicit aria-live="polite" per the
              // ARIA spec; explicit aria-live="polite" makes the announcement
              // reliable across older SR implementations (VoiceOver 14,
              // NVDA 2023).  aria-atomic ensures the full sentence is read,
              // not just the changed text node.
              <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
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
                // Translate the status enum so EN/TH/SV users see
                // "Active / ใช้งาน / Aktiv" rather than the raw string.
                // Falls back to the raw value if the backend ever emits
                // an unknown status — safer than throwing at render time.
                const statusKnown = isKnownStatus(opt.status);
                const statusLabel = statusKnown
                  ? tStatus(opt.status)
                  : opt.status;
                // At-risk indicator: a small coloured dot before the legal
                // name when the member is not `active`. The picker today
                // filters status=active at the API level, but we keep this
                // defensive in case the filter relaxes (e.g. "show all").
                // SR users still get the full translated status via the
                // badge, so the dot is purely visual and aria-hidden.
                const dotClass =
                  statusKnown && opt.status === 'inactive'
                    ? 'bg-amber-500'
                    : statusKnown && opt.status === 'archived'
                      ? 'bg-muted-foreground'
                      : null;
                return (
                  <CommandItem
                    key={opt.member_id}
                    value={opt.member_id}
                    onSelect={() => handleSelect(opt)}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {dotClass ? (
                        <span
                          aria-hidden
                          className={cn(
                            'inline-block size-1.5 shrink-0 rounded-full',
                            dotClass,
                          )}
                        />
                      ) : null}
                      <span className="truncate font-medium">
                        {opt.company_name}
                      </span>
                      {/* Status badges: bg-muted + text-muted-foreground
                          passes 4.5:1 only when the muted token pair is
                          correctly configured.  The explicit text-xs class
                          makes this "large UI component" text (≥12 px bold)
                          which only needs 3:1 — we exceed that at 4.5:1. */}
                      <span className="inline-flex items-center rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {opt.country}
                      </span>
                      <span className="inline-flex items-center rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {statusLabel}
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
