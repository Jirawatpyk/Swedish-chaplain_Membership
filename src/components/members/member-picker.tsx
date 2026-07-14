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

// At-risk visual indicator — `null` means no dot (active / unknown).
// Keeping the mapping as a const-asserted object lets a future status
// addition surface as a TS error at the call site rather than silently
// falling through.
const STATUS_DOT_CLASS: Record<MemberStatus, string | null> = {
  active: null,
  inactive: 'bg-amber-500',
  archived: 'bg-muted-foreground',
};

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
  const [fetchError, setFetchError] = useState(false);
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
      // Clear stale error banner before each new fetch — avoids a
      // confusing "failed to load" message lingering after the user
      // types a new query and we haven't yet received the response.
      setFetchError(false);
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
        if (!r.ok) {
          // Non-2xx (e.g. 401/500) — surface a fetch error state so the
          // dropdown does not silently degrade to "No members found",
          // which the admin would mistake for an empty directory.
          if (!cancelled) {
            setItems([]);
            setFetchError(true);
          }
          console.error(
            `[member-picker] /api/members responded ${r.status}`,
          );
          return;
        }
        const data = (await r.json()) as ApiResponse;
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
        setFetchError(false);
      } catch (e) {
        if (!cancelled) {
          setItems([]);
          // AbortError is expected on open/close race — don't flag it.
          if (!(e instanceof DOMException && e.name === 'AbortError')) {
            setFetchError(true);
          }
        }
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

  const clearRef = useRef<HTMLSpanElement>(null);
  // Separate stable ID for the disabled-hint paragraph so aria-describedby
  // points to a unique, never-colliding element.
  const disabledHintId = `${listboxId}-disabled-hint`;

  // The listbox's real id is NOT `${listboxId}-list` — cmdk generates
  // `CommandList`'s id internally via its own `useId()` call and
  // unconditionally overwrites any `id` prop passed to `<CommandList>`
  // (verified against cmdk@1.1.1's source: `{...c, id: b.listId}`, the
  // internal id always wins the prop spread). Pre-computing an id here and
  // pointing `aria-controls` at it — as this component previously did — is
  // a latent bug: the id never lands on the DOM, so a screen reader
  // following `aria-controls` finds nothing. Instead, read the REAL
  // rendered id back off cmdk's own documented `[cmdk-list]` selector via a
  // ref callback (fires in the same commit the Command tree mounts/unmounts,
  // so there's no timing race against Base UI's portal-mount). Same
  // technique as `src/components/ui/combobox.tsx`.
  const [listboxRegionId, setListboxRegionId] = useState<string | undefined>(undefined);
  const captureListboxRegionId = useCallback((node: HTMLDivElement | null) => {
    setListboxRegionId(node?.querySelector<HTMLElement>('[cmdk-list]')?.id);
  }, []);

  return (
    <Popover open={open} onOpenChange={(nextOpen) => !disabled && setOpen(nextOpen)}>
      <PopoverTrigger
        render={
          <Button
            id={listboxId}
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
            // Use span with role="button" — NOT <button> — because
            // PopoverTrigger already renders a <button>, and nesting
            // <button> inside <button> is invalid HTML and causes a
            // React hydration error. Span keeps inline layout flush
            // with the chevron while Enter/Space keyboard handlers
            // preserve full keyboard a11y.
            <span
              ref={clearRef}
              role="button"
              tabIndex={0}
              aria-label={t('clear')}
              onClick={handleClear}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  setSelected(null);
                  onChange(null);
                }
              }}
              className={cn(
                'inline-flex size-5 items-center justify-center rounded-sm',
                'hover:bg-muted',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <XIcon className="size-3.5" aria-hidden />
            </span>
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
        className="w-[var(--anchor-width)] max-w-[calc(100vw-2rem)] p-0"
        align="start"
      >
        {/* `display: contents` — purely a ref anchor to read cmdk's real
            listbox id back (see `captureListboxRegionId` above); must not
            participate in Command's own flex layout. */}
        <div ref={captureListboxRegionId} className="contents">
          <Command shouldFilter={false}>
            <CommandInput
              ref={commandInputRef}
              placeholder={t('placeholder')}
              value={rawInput}
              onValueChange={setRawInput}
            />
            {/* The CommandList is the actual listbox container. Its real id
                is generated internally by cmdk (see `captureListboxRegionId`
                above) — do not pass an `id` prop here, cmdk overwrites it. */}
            <CommandList>
              {loading ? (
                // role="status" has an implicit aria-live="polite" per the
                // ARIA spec; explicit aria-live="polite" makes the
                // announcement reliable across older SR implementations
                // (VoiceOver 14, NVDA 2023). aria-atomic ensures the full
                // sentence is read, not just the changed text node.
                <div
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground"
                >
                  <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden />
                  <span>{t('loading')}</span>
                </div>
              ) : fetchError ? (
                <div
                  role="alert"
                  className="px-3 py-4 text-sm text-destructive"
                >
                  {t('fetchError')}
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
                  const dotClass = statusKnown
                    ? STATUS_DOT_CLASS[opt.status]
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
                            correctly configured. The explicit text-xs class
                            makes this "large UI component" text (≥12 px
                            bold) which only needs 3:1 — we exceed that at
                            4.5:1. */}
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
        </div>
      </PopoverContent>
    </Popover>
  );
}
