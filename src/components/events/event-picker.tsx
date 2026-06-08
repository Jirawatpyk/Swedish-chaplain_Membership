'use client';

/**
 * T025 (Feature 013 · F6.1) — Event picker dropdown for CSV import.
 *
 * Renders the admin's events (from `GET /api/admin/events`) as a
 * combobox-style dropdown. Filename hint pre-suggests the best fuzzy
 * match via Sørensen-Dice bigram similarity (threshold ≥0.65 per FR-004).
 * The "Create new event" CTA opens an inline event-create modal (T026 —
 * MVP shortcut: opens admin events route in a new tab; full inline form
 * deferred to a follow-up session per US1 scope).
 *
 * Pure client component. The parent (`csv-mapping-form`) holds the
 * selected `eventId` state and forwards it to the import API.
 *
 * Accessibility:
 *   - Combobox pattern: `<button role="combobox">` + popover listbox.
 *   - Keyboard nav: ArrowUp/Down/Enter/Escape inherited from `cmdk`.
 *   - aria-live announces the fuzzy-match hint when filename changes.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations, useFormatter } from 'next-intl';
import { Check, ChevronsUpDown, Plus, RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface EventPickerOption {
  readonly eventId: string;
  readonly name: string;
  readonly startDate: string;
}

export interface EventPickerProps {
  readonly value: string | null;
  readonly onChange: (eventId: string | null, event: EventPickerOption | null) => void;
  /**
   * Filename of the currently-loaded CSV (used for Sørensen-Dice fuzzy
   * matching against event names per FR-004). `null` disables the hint.
   */
  readonly filenameHint?: string | null;
  /**
   * Optional pre-loaded events list — for testing seams. When omitted,
   * the component fetches from `GET /api/admin/events`.
   */
  readonly events?: ReadonlyArray<EventPickerOption>;
  /** Inline CTA to open the event-create modal (T026 — MVP placeholder). */
  readonly onCreateNew?: () => void;
  /**
   * R2 (Round 2 — code-reviewer): imperative add of a freshly-created
   * event so the parent (csv-mapping-form) can push the inline-created
   * event into the dropdown state immediately on `onCreated`, avoiding
   * the stale-label window between create-success and the next refresh.
   */
  readonly registerAddEvent?: (
    add: (event: EventPickerOption) => void,
  ) => void;
  /**
   * Optional `id` of an external `<Label>` element. When set, the
   * combobox trigger uses `aria-labelledby={triggerAriaLabelledBy}`
   * instead of the default `aria-label={t('triggerAriaLabel')}`. This
   * lets a form-shaped surface (e.g. csv-mapping-form) wire a visible
   * label without producing duplicate accessible names.
   */
  readonly triggerAriaLabelledBy?: string;
}

// ---------------------------------------------------------------------------
// Sørensen-Dice bigram similarity — pure helper per FR-004 (~30 LOC).
// ---------------------------------------------------------------------------

function bigrams(s: string): string[] {
  const normalized = s.trim().toLowerCase();
  if (normalized.length < 2) return [];
  const out: string[] = [];
  for (let i = 0; i < normalized.length - 1; i++) {
    out.push(normalized.slice(i, i + 2));
  }
  return out;
}

function sorensenDice(a: string, b: string): number {
  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  if (aBigrams.length === 0 || bBigrams.length === 0) return 0;
  const bMap = new Map<string, number>();
  for (const bg of bBigrams) {
    bMap.set(bg, (bMap.get(bg) ?? 0) + 1);
  }
  let intersection = 0;
  for (const bg of aBigrams) {
    const count = bMap.get(bg) ?? 0;
    if (count > 0) {
      intersection += 1;
      bMap.set(bg, count - 1);
    }
  }
  return (2 * intersection) / (aBigrams.length + bBigrams.length);
}

/**
 * Returns the best-matching event + its similarity score for the given
 * filename, or null if no event scores ≥0.65 (FR-004 threshold). The
 * filename is normalised (extension stripped, hyphens → spaces) before
 * matching.
 *
 * UX-I3 (Round 1): score now surfaced so the UI can render confidence
 * ("Auto-suggested from filename — 92% match") and admins can decide
 * whether to trust the suggestion at-a-glance.
 */
export interface FilenameSuggestion {
  readonly event: EventPickerOption;
  readonly score: number; // 0..1
}

export function suggestEventFromFilename(
  filename: string,
  events: ReadonlyArray<EventPickerOption>,
): FilenameSuggestion | null {
  const stripped = filename
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  let bestScore = 0.65;
  let bestEvent: EventPickerOption | null = null;
  for (const event of events) {
    const score = sorensenDice(stripped, event.name);
    if (score >= bestScore) {
      bestScore = score;
      bestEvent = event;
    }
  }
  return bestEvent === null ? null : { event: bestEvent, score: bestScore };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EventPicker(props: EventPickerProps): React.JSX.Element {
  const t = useTranslations('admin.events.import.eventPicker');
  // UX-C-2 (Round 1 — enterprise-ux-designer): use next-intl
  // `useFormatter` so dates render in the user's session locale, not
  // the browser locale. Avoids the th-TH (BE) vs en-US (CE) mix on
  // pages where some surfaces use locale-aware formatters and others
  // don't.
  const formatter = useFormatter();
  const popoverContentId = useId();
  const [open, setOpen] = useState(false);
  const [fetchedEvents, setFetchedEvents] = useState<
    ReadonlyArray<EventPickerOption>
  >(props.events ?? []);
  // T060 debug fix: track locally-added events (via
  // `addPickerEventRef`) SEPARATELY from the fetched list so a
  // race-condition fetch overwrite cannot wipe out a freshly-created
  // event. Pattern:
  //   - mount-effect fetch resolves later → `setFetchedEvents(...)`
  //   - inline-modal onCreated → `setLocallyAddedEvents(prev =>
  //       [event, ...prev])`
  //   - displayed `events` = locallyAdded ⊕ fetched (deduped)
  // Without this split, the previously-observed race was: user clicks
  // "Create new event" + submits before the mount-fetch resolves →
  // POST 201 fires `addEvent` (state has new event) → mount-fetch then
  // resolves with stale list → `setEvents(stale)` overwrites → button
  // re-renders to "Choose an event…" placeholder.
  const [locallyAddedEvents, setLocallyAddedEvents] = useState<
    ReadonlyArray<EventPickerOption>
  >([]);
  const events = useMemo<ReadonlyArray<EventPickerOption>>(() => {
    if (locallyAddedEvents.length === 0) return fetchedEvents;
    const fetchedIds = new Set(fetchedEvents.map((e) => e.eventId));
    const onlyLocal = locallyAddedEvents.filter(
      (e) => !fetchedIds.has(e.eventId),
    );
    return [...onlyLocal, ...fetchedEvents];
  }, [fetchedEvents, locallyAddedEvents]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shared cancellation ref consumed by both the mount-effect and the
  // refresh button — without a single source of truth, a per-click
  // signal would leak setState on unmount during in-flight fetches.
  const loadCancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Single shared loader for both initial mount and refresh button.
  // `cancelled` flag protects unmount race; setError(null) before fetch
  // clears stale errors on retry.
  const loadEvents = useCallback(
    async (signal: { cancelled: boolean }): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        // Page size 100 covers SweCham's typical ~12-event-per-year
        // cadence with headroom. Pagination affordance is deferred to
        // v1.x — chambers with >100 events need a search query upstream.
        const res = await fetch('/api/admin/events?pageSize=100');
        if (!res.ok) {
          // R2-S-2 (Round 2 — silent-failure-hunter): log status code
          // so dev debugging can distinguish 429 vs 500 vs kill-switch.
          console.warn(
            '[F6.1] event-picker fetch returned non-OK',
            { status: res.status },
          );
          if (!signal.cancelled) setError(t('loadErrorDetail'));
          return;
        }
        const body = (await res.json()) as {
          items?: ReadonlyArray<{
            eventId?: string;
            name?: string;
            startDate?: string;
          }>;
        };
        const normalised = (body.items ?? [])
          .filter(
            (e): e is EventPickerOption =>
              typeof e.eventId === 'string' &&
              typeof e.name === 'string' &&
              typeof e.startDate === 'string',
          )
          .map((e) => ({
            eventId: e.eventId,
            name: e.name,
            startDate: e.startDate,
          }));
        if (!signal.cancelled) setFetchedEvents(normalised);
      } catch (e) {
        // S-1 (Round 1 — silent-failure-hunter): preserve console
        // diagnostic for dev so "why isn't my picker loading?" is
        // debuggable without breakpoints.
        console.error('[F6.1] event-picker fetch failed', e);
        if (!signal.cancelled) setError(t('loadErrorDetail'));
      } finally {
        if (!signal.cancelled) setLoading(false);
      }
    },
    [t],
  );

  // Fetch events list on mount (if not provided via props). The shared
  // cancel ref ensures refresh-then-unmount cancels the in-flight load.
  useEffect(() => {
    if (props.events !== undefined) return;
    // Reset the shared signal on remount.
    loadCancelRef.current = { cancelled: false };
    void loadEvents(loadCancelRef.current);
    return () => {
      loadCancelRef.current.cancelled = true;
    };
  }, [props.events, loadEvents]);

  // Expose an imperative `add` to the parent so a freshly-created
  // event lands in `events` state immediately after `onCreated`,
  // preventing the stale "Select an event…" label between create-
  // success and the next refresh round-trip.
  const registerAddEvent = props.registerAddEvent;
  useEffect(() => {
    if (registerAddEvent === undefined) return;
    registerAddEvent((event) => {
      // Write to the locallyAddedEvents state — fetch-overwrite-safe
      // (the mount-effect setFetchedEvents path cannot wipe items
      // from this list). Dedup against existing locally-added items.
      setLocallyAddedEvents((prev) =>
        prev.some((e) => e.eventId === event.eventId)
          ? prev
          : [event, ...prev],
      );
    });
  }, [registerAddEvent]);

  const selected = useMemo(
    () => events.find((e) => e.eventId === props.value) ?? null,
    [events, props.value],
  );

  // Compute filename-hint suggestion when the upload's filename changes.
  const suggestion = useMemo(
    () =>
      props.filenameHint
        ? suggestEventFromFilename(props.filenameHint, events)
        : null,
    [props.filenameHint, events],
  );
  const suggestedEvent = suggestion?.event ?? null;
  const suggestionScore = suggestion?.score ?? 0;

  // Auto-apply suggestion when no event is currently selected. The
  // `props.value === null` guard means the effect is a no-op if the
  // admin has already picked an event manually — so refreshing the
  // events list (which can re-trigger a `suggestedEvent` identity
  // change) cannot override their selection. Including `props.value`
  // in deps closes the stale-closure window enterprise-ux R3 flagged.
  const propsValue = props.value;
  const propsOnChange = props.onChange;
  const propsFilenameHint = props.filenameHint;
  useEffect(() => {
    if (
      suggestedEvent !== null &&
      propsValue === null &&
      propsFilenameHint !== undefined &&
      propsFilenameHint !== null
    ) {
      propsOnChange(suggestedEvent.eventId, suggestedEvent);
    }
  }, [propsFilenameHint, suggestedEvent, propsValue, propsOnChange]);

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-haspopup="listbox"
              // APG Combobox: aria-controls always references the listbox
              // by id. When closed, the listbox is unmounted (Base UI
              // Portal) so the reference is dangling — modern SR
              // implementations still announce "has popup listbox"
              // correctly via aria-haspopup, and the controls reference
              // takes effect when the popup mounts on open.
              aria-controls={popoverContentId}
              // Prefer an external Label association (WCAG 1.3.1 + 4.1.2)
              // when the parent provides one. Otherwise fall back to the
              // self-describing aria-label so the picker stays accessible
              // when used standalone.
              {...(props.triggerAriaLabelledBy !== undefined
                ? { 'aria-labelledby': props.triggerAriaLabelledBy }
                : { 'aria-label': t('triggerAriaLabel') })}
              className="min-h-11 w-full justify-between text-left font-normal"
            >
              {/* UX-R1.2 F-05 — show shimmer skeleton (not text) while
                  events are loading. shadcn/ui Skeleton aligned to text
                  size so CLS=0 when fetch resolves and the selected /
                  placeholder text takes over. aria-label on the trigger
                  carries the semantic for SR; visual loading state is
                  purely decorative shimmer per ux-standards.md § 2.1. */}
              {selected !== null ? (
                <span className="truncate">
                  {`${selected.name} — ${formatter.dateTime(new Date(selected.startDate), 'medium')}`}
                </span>
              ) : loading ? (
                <Skeleton aria-hidden="true" className="h-4 w-48" />
              ) : (
                <span className="truncate text-muted-foreground">
                  {t('placeholder')}
                </span>
              )}
              <ChevronsUpDown
                aria-hidden="true"
                className="ml-2 size-4 shrink-0 opacity-50"
              />
            </Button>
          }
        />
        <PopoverContent
          id={popoverContentId}
          className="w-(--anchor-width) min-w-[280px] p-0"
        >
          <Command>
            <CommandInput
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchAriaLabel')}
            />
            <CommandList>
              <CommandEmpty>
                {/* UX-R1.2 F-08 — surface an inline "+ Create new event"
                    CTA inside the empty state so an admin who searches
                    and finds nothing can act without leaving the
                    dropdown. Only renders when a parent supplied
                    `onCreateNew`; otherwise we fall back to the plain
                    empty-state copy. The button closes the popover
                    before invoking the create callback so focus follows
                    into the inline-create modal. */}
                <div className="flex flex-col items-center gap-2 py-3 text-center">
                  <span className="text-caption text-muted-foreground">
                    {error ?? t('emptyState')}
                  </span>
                  {props.onCreateNew !== undefined ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setOpen(false);
                        props.onCreateNew?.();
                      }}
                      className="min-h-9 gap-1.5"
                    >
                      <Plus aria-hidden="true" className="size-3.5" />
                      {t('createInlineCta')}
                    </Button>
                  ) : null}
                </div>
              </CommandEmpty>
              <CommandGroup>
                {events.map((event) => (
                  <CommandItem
                    key={event.eventId}
                    value={`${event.name} ${event.startDate}`}
                    onSelect={() => {
                      props.onChange(event.eventId, event);
                      setOpen(false);
                    }}
                    className="cursor-pointer"
                  >
                    <Check
                      aria-hidden="true"
                      className={cn(
                        'mr-2 size-4',
                        props.value === event.eventId
                          ? 'opacity-100'
                          : 'opacity-0',
                      )}
                    />
                    <div className="flex flex-col">
                      <span>{event.name}</span>
                      <span className="text-caption text-muted-foreground">
                        {formatter.dateTime(new Date(event.startDate), 'medium')}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <div className="flex flex-row gap-2">
        {props.onCreateNew !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onCreateNew}
            className="min-h-9"
          >
            <Plus aria-hidden="true" className="mr-1 size-4" />
            {t('createNewCta')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            // Cancel any in-flight load before starting a new one;
            // sharing the ref means unmount kills BOTH this fetch and
            // any prior one. setError(null) is handled inside loadEvents.
            loadCancelRef.current.cancelled = true;
            loadCancelRef.current = { cancelled: false };
            // Clear the fetched list ONLY — preserve locallyAddedEvents
            // (those represent events the user created via the inline
            // modal in this session; refresh shouldn't remove them).
            // T060 debug fix — see fetchedEvents/locally
            // AddedEvents split rationale above.
            setFetchedEvents([]);
            void loadEvents(loadCancelRef.current);
          }}
          className="min-h-9"
          aria-label={t('refreshAriaLabel')}
        >
          <RefreshCcw aria-hidden="true" className="size-4" />
        </Button>
      </div>

      {/*
        Surface fuzzy-match confidence so admins can decide whether to
        trust the auto-suggestion. Score displayed as integer percent.
        Region is ALWAYS mounted with `min-h-[1lh]` so NVDA/JAWS register
        the live region BEFORE content arrives — conditional-mount with
        text causes some SRs to swallow the announcement when the
        element appears already populated.
      */}
      <p
        className="text-caption text-muted-foreground min-h-[1lh]"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {suggestedEvent !== null && props.value === suggestedEvent.eventId
          ? t('filenameMatchHintWithScore', {
              eventName: suggestedEvent.name,
              score: Math.round(suggestionScore * 100),
            })
          : ''}
      </p>
    </div>
  );
}
