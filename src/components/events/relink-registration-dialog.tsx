/**
 * F6 Phase 9 / US6 / T106 — relink registration dialog.
 *
 * Per-row admin action mounted in `AttendeeTable`. Two visual modes:
 *
 *   1. **Active mode** (default) — a Relink CTA opens a shadcn/Base UI
 *      Dialog containing a cmdk searchable member picker. On selection,
 *      POSTs to `/api/admin/events/{eventId}/registrations/{registrationId}/relink`
 *      and surfaces a toast on success / 409 (already pseudonymised by
 *      a concurrent retention sweep) / generic error. Closes after the
 *      POST resolves; `router.refresh()` re-renders the attendee table
 *      so the row's match-status badge updates without a full nav.
 *
 *   2. **Disallowed mode** — when the row has `isPseudonymised=true`
 *      (FR-014 round-2 R4), the CTA is replaced by an inline note with
 *      the canonical retention-purged copy. No Dialog is mounted; no
 *      data-testid="relink-button-…" exists in the DOM (the E2E spec
 *      asserts absence). The use-case + DB CHECK also defend the
 *      action server-side; the UI mode merely hides a button that
 *      would never succeed.
 *
 * Network behaviour:
 *   - Picker uses cmdk in `shouldFilter={false}` mode because results
 *     are server-filtered via `/api/admin/members/search?q=…&limit=10`.
 *   - Debounced via `useDeferredValue` (no extra dependency); aborts
 *     in-flight fetches when the query changes.
 *   - One outstanding POST at a time — `useTransition`'s pending flag
 *     disables CommandItems + guards the dialog from re-closing mid-
 *     flight (matches archive-event-button's CRIT-5 pattern).
 *
 * a11y:
 *   - Dialog title + description satisfy Base UI's labelled-by/described-by.
 *   - cmdk Input gets a Command `label` so SR users hear "Search members"
 *     even though the placeholder is visual.
 *   - sr-only role=status announces "Relinking …" + "Searching members …".
 *   - Loader2 animations carry `motion-reduce:animate-none` per
 *     `docs/ux-standards.md § Reduced motion`.
 */
'use client';

import {
  useState,
  useEffect,
  useTransition,
  useDeferredValue,
  useRef,
} from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Info, Link2, Loader2 } from 'lucide-react';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type {
  AttendeeEmail,
  EventId,
  RegistrationId,
} from '@/modules/events';
import type { MemberId } from '@/modules/members';

export interface RelinkRegistrationDialogProps {
  /** Branded for compile-time UUID safety across the prop boundary. */
  readonly registrationId: RegistrationId;
  readonly eventId: EventId;
  readonly attendeeName: string;
  /** Display-only; helps the admin disambiguate when several rows share a name. */
  readonly attendeeEmail: AttendeeEmail;
  /** Currently-matched member UUID (or null for non_member/unmatched rows). */
  readonly currentMatchedMemberId: MemberId | null;
  /**
   * FR-014 round-2 R4 — when true, the CTA is replaced by the
   * retention-purged disallowed message and no dialog is mounted.
   */
  readonly isPseudonymised: boolean;
}

// runtime-validated server response shapes. zod
// `.safeParse()` at the fetch boundary guarantees the dialog never
// trusts a malformed JSON body (proxy injection, mid-stream truncation,
// future server-schema drift). Mirrors the `AuditRowSchema` defensive
// pattern in tests/e2e/helpers/eventcreate-seed.ts.
const MemberSearchHitSchema = z.object({
  memberId: z.string().uuid(),
  companyName: z.string(),
  primaryContactName: z.string().nullable(),
});
// `items` is REQUIRED in the server response
// (members-search route always returns it, even empty). Marking
// optional masked future shape regressions where the server stops
// emitting `items` at all.
const SearchResponseSchema = z.object({
  items: z.array(MemberSearchHitSchema),
});
type MemberSearchHit = z.infer<typeof MemberSearchHitSchema>;

// schema now matches the route's wire shape exactly:
//   - noop variant carries `registrationId` (route sends it; schema
//     previously dropped it via zod's default unknown-field strip).
//   - non-noop variant carries `quotaImpact` (route sends the full
//     credit-back/decrement summary).
// `passthrough` is added on each variant so future server-side fields
// don't trigger a parse failure during a deploy crossover window.
// M closure — tighten member-id fields to UUID
// validation matching `MemberSearchHitSchema.memberId` discipline.
// Server emits branded `MemberId` (UUID PK from members table); a
// future regression that leaks a non-UUID member-id (e.g., a slug,
// a name) would fail parse instead of silently flowing through.
const QuotaImpactSchema = z.object({
  creditedBackFor: z.string().uuid().nullable(),
  decrementedFor: z.string().uuid().nullable(),
  scopes: z.array(z.enum(['partnership', 'cultural'])),
});

const RelinkOkResponseSchema = z.union([
  z
    .object({
      noop: z.literal(true),
      registrationId: z.string(),
      matchedMemberId: z.string().nullable(),
    })
    .passthrough(),
  z
    .object({
      noop: z.literal(false),
      registrationId: z.string(),
      previousMatchedMemberId: z.string().nullable(),
      newMatchedMemberId: z.string(),
      previousMatchType: z.string(),
      newMatchType: z.string(),
      quotaImpact: QuotaImpactSchema,
    })
    .passthrough(),
]);

const RelinkErrorResponseSchema = z
  .object({
    title: z.string().optional(),
    detail: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export function RelinkRegistrationDialog(props: RelinkRegistrationDialogProps) {
  const t = useTranslations('admin.events.detail.relink');
  const router = useRouter();
  // All hooks declared unconditionally so React's rules-of-hooks holds
  // across both the active and disallowed render branches.
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [results, setResults] = useState<ReadonlyArray<MemberSearchHit>>([]);
  const [searching, setSearching] = useState(false);
  // distinguishes "search returned 0 results" from
  // "search request failed" so the empty-state copy doesn't tell a
  // network-degraded admin that the member they're looking for doesn't
  // exist.
  const [searchError, setSearchError] = useState(false);
  const [pending, startTransition] = useTransition();
  // fetch sequence counter prevents the spinner from
  // racing across keystrokes. Each effect run increments + captures
  // the id; the `.finally()` only flips `searching=false` when its
  // captured id is still the most recent in-flight request.
  const fetchSeqRef = useRef(0);

  // Debounced server-side member search. Active only while the dialog
  // is open, a non-empty query is present, and the disallowed branch
  // is not in effect — so we don't fire useless requests when the
  // trigger is hidden OR when the user has cleared the input.
  //
  // The empty-query case is handled at the RENDER layer (via
  // `visibleResults` below); we don't synchronously setResults([])
  // here to keep the setState calls behind the cancellable fetch
  // boundary — the canonical React-19 external-state sync pattern.
  const trimmedQuery = deferredSearch.trim();
  /* eslint-disable react-hooks/set-state-in-effect --
   * Legitimate data-fetching effect (mirrors
   * `src/components/members/bundle-change-warning-dialog.tsx:51-77`
   * + `payment-form.tsx` precedent in this repo). The spinner state is
   * the canonical "pending data" signal that MUST flip true synchronously
   * when the query changes so the user gets immediate feedback before
   * the network round-trip resolves. Pure-function / use-memo
   * alternatives don't apply — results depend on live server state. */
  useEffect(() => {
    if (!open || props.isPseudonymised || trimmedQuery === '') {
      return;
    }
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
        if (!res.ok) {
          throw new Error(`member-search responded ${res.status}`);
        }
        const raw: unknown = await res.json();
        // runtime-validate the server response.
        const parsed = SearchResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(
            `member-search response shape invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
          );
        }
        return parsed.data;
      })
      .then((data) => {
        if (mySeq !== fetchSeqRef.current) return; // stale response
        // Hide the currently-matched member from the picker — admins
        // can't "relink to the same member" meaningfully, and the
        // use-case short-circuits with a noop anyway. Hiding it avoids
        // the surprise of an apparently-successful action that doesn't
        // change anything.
        const hits = (data.items ?? []).filter(
          (m) => m.memberId !== props.currentMatchedMemberId,
        );
        setResults(hits);
      })
      .catch((err: unknown) => {
        // AbortError is thrown when the query changes mid-flight —
        // expected, swallow silently.
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        if (mySeq !== fetchSeqRef.current) return; // stale failure
        // surface the failure as a distinct empty
        // state (`searchFailed` copy) so the admin can distinguish
        // "no member matches this query" from "the search backend is
        // unreachable". Also log to the browser console for E2E /
        // local-debug visibility.
        console.error('member-search fetch failed', err);
        setResults([]);
        setSearchError(true);
      })
      .finally(() => {
        if (mySeq !== fetchSeqRef.current) return; // stale finalize
        setSearching(false);
      });
    return () => {
      controller.abort();
    };
  }, [
    trimmedQuery,
    open,
    props.isPseudonymised,
    props.currentMatchedMemberId,
  ]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // reset stale spinner + error state when the
  // dialog opens fresh, so a previous session's transient failure
  // doesn't poison the next open.
  /* eslint-disable react-hooks/set-state-in-effect --
   * Cleanup-on-close effect; resets transient UI state synchronously
   * when the open prop transitions to false. Mirrors the
   * data-fetching exception precedent above (cascading-render hazard
   * is acceptable here because the effect only fires when the user
   * has dismissed the dialog — the next render won't trigger
   * additional work). */
  useEffect(() => {
    if (!open) {
      setSearch('');
      setResults([]);
      setSearching(false);
      setSearchError(false);
    }
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Visible results — empty when the user has cleared the input so
  // stale results from a previous query don't briefly flash.
  const visibleResults = trimmedQuery === '' ? [] : results;

  // Disallowed branch — render the inline retention-purged note INSTEAD
  // of the dialog. No data-testid="relink-button-…" so the absence
  // assertion in the E2E spec holds.
  //
  // M1 + Round-2 comments-M — short visible label + Info
  // icon + Tooltip with the full FR-014 sentence. Keeps the visible
  // cell width small (avoiding a 185-char inline message that
  // dominates the Actions column) while preserving the canonical
  // message inside the tooltip portal — assertion target is the
  // `data-testid='relink-disallowed-{rid}'` `aria-label`, which
  // carries the full sentence for SR users + the E2E `getByTestId`.
  //
  // M + Round-3 — no nested `TooltipProvider`:
  // rely on the hoisted single provider in
  // `attendee-table.tsx § "Round-11 review fix — single
  // TooltipProvider hoisted"` (anchor citation, not line number).
  // Nesting providers wouldn't break Radix but contradicted the
  // explicit hoist pattern.
  if (props.isPseudonymised) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              data-testid={`relink-disallowed-${props.registrationId}`}
              className="text-muted-foreground inline-flex items-center gap-1 text-xs"
              role="note"
              tabIndex={0}
              aria-label={t('disallowedPseudonymised')}
            />
          }
        >
          <Info aria-hidden="true" className="size-3 shrink-0" />
          <span>{t('disallowedShort')}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          {t('disallowedPseudonymised')}
        </TooltipContent>
      </Tooltip>
    );
  }

  function handleSelect(memberId: string, companyName: string): void {
    startTransition(async () => {
      // wrap fetch+JSON in try/catch so a network
      // failure (offline / DNS / TLS handshake fail) surfaces as a
      // toast.error instead of an unhandled rejection that closes the
      // dialog silently. The dialog stays OPEN on a thrown failure so
      // the user can retry; only success/409/404/500 paths close it.
      try {
        const res = await fetch(
          `/api/admin/events/${props.eventId}/registrations/${props.registrationId}/relink`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ newMatchedMemberId: memberId }),
          },
        );
        if (res.ok) {
          const raw: unknown = await res.json().catch(() => ({}));
          const parsed = RelinkOkResponseSchema.safeParse(raw);
          setOpen(false);
          if (parsed.success && parsed.data.noop) {
            toast.info(t('noopToast'), {
              description: t('noopToastDescription', { companyName }),
            });
          } else {
            toast.success(t('successToast', { companyName }));
          }
          router.refresh();
        } else if (res.status === 409) {
          const raw: unknown = await res.json().catch(() => ({}));
          const parsed = RelinkErrorResponseSchema.safeParse(raw);
          const reason = parsed.success ? parsed.data.reason : undefined;
          setOpen(false);
          // the server discriminates via `reason`. The
          // client picks the correct LOCALISED copy instead of echoing
          // the server's EN `body.detail` (which would break TH/SV).
          if (reason === 'pseudonymised_row_rejected') {
            toast.error(t('disallowedPseudonymised'));
          } else {
            toast.error(t('errorToastConflict'));
          }
          // Refresh so the row re-renders into the disallowed branch
          // if a concurrent retention sweep flipped the row, or so
          // archived-event UI updates.
          router.refresh();
        } else if (res.status === 404) {
          setOpen(false);
          toast.error(t('notFoundToast'));
          router.refresh();
        } else {
          // LOW closure — 5xx keeps the dialog OPEN so
          // the admin can retry without re-opening the picker and
          // re-typing the search. Matches the network-throw branch
          // semantics (err-H2): both "server down" and "network
          // down" present the same recovery path.
          toast.error(t('errorToast'));
        }
      } catch (err) {
        console.error('relink POST failed', err);
        // Keep dialog OPEN so the admin can retry. Round-3 deferred-
        // fix closure — use the network-specific toast so support can
        // distinguish "browser never reached the API" from "server
        // 500" (both keep the dialog open per err-H2 + err-LOW, but
        // the toast text helps triage the failure class).
        toast.error(t('errorToastNetwork'));
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Match archive-event-button's NEW-I1 guard — never let a re-
        // open / close happen while a POST is in flight. The cmdk
        // CommandItem also disables itself via `disabled={pending}`
        // so the only way to leave the dialog mid-flight is the
        // browser-native Escape key, which onOpenChange catches here.
        if (pending) return;
        setOpen(next);
      }}
    >
      {/* sr-only live region — announces the in-flight state for SR
          users. ARIA-busy on a disabled trigger button is brittle
          across screen readers (JAWS skips inert elements); a
          dedicated live region is the reliable cue. */}
      <span role="status" aria-live="polite" className="sr-only">
        {pending ? t('pendingAnnouncement') : ''}
      </span>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            type="button"
            data-testid={`relink-button-${props.registrationId}`}
            // email included so SR users can
            // disambiguate rows that share a name (admin view often
            // has multiple "John Smith" entries from different
            // companies).
            aria-label={t('triggerAriaLabel', {
              attendee: props.attendeeName,
              email: props.attendeeEmail,
            })}
          />
        }
      >
        <Link2 aria-hidden="true" data-icon="inline-start" />
        <span>{t('relinkCta')}</span>
      </DialogTrigger>
      <DialogContent className="p-0 sm:max-w-[var(--modal-max-width-lg)]">
        <DialogHeader className="p-[var(--card-padding)] pb-2">
          <DialogTitle>
            {t('dialogTitle', { attendee: props.attendeeName })}
          </DialogTitle>
          <DialogDescription>{t('dialogDescription')}</DialogDescription>
          <p className="text-xs text-muted-foreground" aria-hidden="true">
            {props.attendeeEmail}
          </p>
        </DialogHeader>
        <Command
          shouldFilter={false}
          label={t('searchSrLabel')}
          className="rounded-none border-t"
        >
          <CommandInput
            placeholder={t('searchPlaceholder')}
            value={search}
            onValueChange={setSearch}
            disabled={pending}
          />
          {/* Round-1 ux-H2 — hide the (empty) listbox from SR while
              the spinner role=status is announcing, so the user
              doesn't hear "Searching members…" followed by an empty
              listbox declaration. */}
          <CommandList
            aria-hidden={searching && visibleResults.length === 0}
          >
            {searching && (
              <div
                className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <Loader2
                  aria-hidden="true"
                  className="size-4 animate-spin motion-reduce:animate-none"
                />
                {t('searching')}
              </div>
            )}
            <CommandEmpty>
              {trimmedQuery === ''
                ? t('searchPrompt')
                : searching
                  ? null
                  : searchError
                    ? t('searchFailed')
                    : t('noResults')}
            </CommandEmpty>
            {visibleResults.map((m) => (
              <CommandItem
                key={m.memberId}
                value={m.memberId}
                onSelect={() => {
                  handleSelect(m.memberId, m.companyName);
                }}
                disabled={pending}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="font-medium">{m.companyName}</span>
                {m.primaryContactName && (
                  <span className="text-xs text-muted-foreground">
                    {m.primaryContactName}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
