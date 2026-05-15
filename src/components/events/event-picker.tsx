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
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ReadonlyArray<EventPickerOption>>(
    props.events ?? [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // UX-I2 (Round 1) — single shared loader for both initial mount and
  // refresh button. Previously duplicated ~30 LOC of fetch+normalize.
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
          if (!signal.cancelled) setError(t('loadErrorDetail'));
          return;
        }
        const body = (await res.json()) as {
          events?: ReadonlyArray<{
            eventId?: string;
            name?: string;
            startDate?: string;
          }>;
        };
        const normalised = (body.events ?? [])
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
        if (!signal.cancelled) setEvents(normalised);
      } catch (e) {
        // S-1 (Round 1 — silent-failure-hunter): preserve console
        // diagnostic for dev so "why isn't my picker loading?" is
        // debuggable without breakpoints.
        // eslint-disable-next-line no-console
        console.error('[F6.1] event-picker fetch failed', e);
        if (!signal.cancelled) setError(t('loadErrorDetail'));
      } finally {
        if (!signal.cancelled) setLoading(false);
      }
    },
    [t],
  );

  // Fetch events list on mount (if not provided via props).
  useEffect(() => {
    if (props.events !== undefined) return;
    const signal = { cancelled: false };
    void loadEvents(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [props.events, loadEvents]);

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

  // Auto-apply suggestion ONCE per filename change when no event is
  // currently selected — admin can still pick a different one.
  useEffect(() => {
    if (
      suggestedEvent !== null &&
      props.value === null &&
      props.filenameHint !== undefined &&
      props.filenameHint !== null
    ) {
      props.onChange(suggestedEvent.eventId, suggestedEvent);
    }
    // We intentionally do NOT depend on `props.onChange` / `props.value`
    // — only on `filenameHint` + `suggestedEvent` so the auto-select
    // fires once per filename change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.filenameHint, suggestedEvent]);

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
              aria-label={t('triggerAriaLabel')}
              className="min-h-11 w-full justify-between text-left font-normal"
            >
              <span className="truncate">
                {selected !== null
                  ? `${selected.name} — ${formatter.dateTime(new Date(selected.startDate), { dateStyle: 'medium' })}`
                  : loading
                    ? t('loading')
                    : t('placeholder')}
              </span>
              <ChevronsUpDown
                aria-hidden="true"
                className="ml-2 size-4 shrink-0 opacity-50"
              />
            </Button>
          }
        />
        <PopoverContent
          className="w-(--anchor-width) min-w-[280px] p-0"
        >
          <Command>
            <CommandInput
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchAriaLabel')}
            />
            <CommandList>
              <CommandEmpty>
                {error ?? t('emptyState')}
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
                        {formatter.dateTime(new Date(event.startDate), { dateStyle: 'medium' })}
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
            // UX-I2 (Round 1) — reuse shared `loadEvents` instead of
            // duplicating fetch+normalise logic. Resets `error` to
            // null automatically and respects unmount via the same
            // cancelled-signal pattern.
            const signal = { cancelled: false };
            setEvents([]);
            void loadEvents(signal);
          }}
          className="min-h-9"
          aria-label={t('refreshAriaLabel')}
        >
          <RefreshCcw aria-hidden="true" className="size-4" />
        </Button>
      </div>

      {suggestedEvent !== null && props.value === suggestedEvent.eventId ? (
        <p
          className="text-caption text-muted-foreground"
          aria-live="polite"
        >
          {/* UX-I3 (Round 1) — surface confidence so admins can decide
              whether to trust the suggestion at-a-glance. Score is
              displayed as integer percent (e.g. "92% match"). */}
          {t('filenameMatchHintWithScore', {
            eventName: suggestedEvent.name,
            score: Math.round(suggestionScore * 100),
          })}
        </p>
      ) : null}
    </div>
  );
}
