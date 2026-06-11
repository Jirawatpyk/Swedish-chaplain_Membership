/**
 * Task 11 (054-event-fee-invoices) — event attendee picker.
 *
 * Given a selected `eventId`, fetches the event's registrations from the
 * F6 admin detail endpoint (`GET /api/admin/events/[eventId]`) and renders
 * a selectable list of attendees. Each row shows:
 *   - attendee name (+ company)
 *   - a match `Badge` (matched member / non-member / unmatched)
 *   - ticket price (THB) or "No fee"
 *   - payment status
 *
 * Pseudonymised (PII-erased) rows are rendered as a non-actionable
 * `aria-disabled` span whose accessible name folds in the "erased, not
 * billable" reason (so screen-reader, keyboard, and touch users get it —
 * a hover-only Tooltip would not). `createEventInvoiceDraft` rejects them
 * with `attendee_erased`, so we block selection up-front (FR —
 * retention-purged attendees are not billable).
 *
 * The selectable rows are plain toggle `<button aria-pressed>` elements in
 * a plain `<ul>` (NOT an ARIA listbox) — single-select-from-list, each
 * button Tab-navigable with native keyboard semantics. We deliberately do
 * NOT use `role="listbox"`/`role="option"` because that pattern mandates
 * arrow-key roving focus we don't implement.
 *
 * Empty states (ux-standards §): `none` (no registrations) and `allErased`
 * (every row pseudonymised). The "all already invoiced" state is NOT
 * detectable from this endpoint (the duplicate guard surfaces at submit as
 * a 409 dialog instead) — documented, not silently dropped.
 *
 * The fetch lives here (not the parent) so the parent can wrap THIS
 * component in a Suspense-like boundary with `EventAttendeePickerSkeleton`
 * while the network request resolves.
 */
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useMinDelay } from '@/hooks/use-min-delay';
import { cn } from '@/lib/utils';

/**
 * Minimal attendee shape the picker needs — a structural subset of the F6
 * `EventDetailRegistration` DTO so we don't import the events module Domain
 * brand into Presentation (the wire JSON is plain strings/numbers anyway).
 */
export type AttendeeRow = {
  readonly registrationId: string;
  readonly attendeeName: string;
  readonly attendeeCompany: string | null;
  readonly matchType:
    | 'member_contact'
    | 'member_domain'
    | 'member_fuzzy'
    | 'non_member'
    | 'unmatched';
  readonly matchedMemberId: string | null;
  readonly ticketPriceThb: number | null;
  readonly paymentStatus: string;
  readonly isPseudonymised: boolean;
  /**
   * 064 remediation B5 — server-truth tax-id PRESENCE for MATCHED members
   * (derived server-side from the F3 member's tax_id; only the boolean
   * crosses the wire, never the raw TIN):
   *   - `true` / `false` — matched member, presence resolved;
   *   - `null`           — non-member (the manual buyer tax-id field rules
   *                        there) OR a matched id the lookup couldn't
   *                        resolve (degraded enrichment);
   *   - absent           — an older API response shape; callers fall back
   *                        to the legacy "matched ⇒ has TIN" guess.
   */
  readonly buyerHasTin?: boolean | null;
};

/** A matched member is any attendee with a resolved `matchedMemberId`. */
export function isMatchedMember(row: AttendeeRow): boolean {
  return row.matchedMemberId !== null;
}

type MatchBadgeKind = 'matched' | 'nonMember' | 'unmatched';

function matchBadgeKind(row: AttendeeRow): MatchBadgeKind {
  if (row.matchedMemberId !== null) return 'matched';
  if (row.matchType === 'non_member') return 'nonMember';
  return 'unmatched';
}

export function EventAttendeePickerSkeleton() {
  return (
    // W1 — hide this skeleton block from the a11y tree locally (the shared
    // <Skeleton> primitive is NOT modified; 500+ call-sites are out of scope).
    <div
      className="flex flex-col gap-2"
      data-testid="attendee-picker-skeleton"
      aria-hidden="true"
    >
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-md border p-3">
          <Skeleton className="h-4 w-4 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

function formatThb(thb: number): string {
  // N11 parity — pin 'en-US' so the thousands separator is deterministic
  // (the same convention the membership form's `formatSatang` uses).
  return thb.toLocaleString('en-US');
}

export function EventAttendeePicker({
  rows,
  selectedRegistrationId,
  onSelect,
  labelId,
}: {
  readonly rows: readonly AttendeeRow[];
  readonly selectedRegistrationId: string | null;
  readonly onSelect: (row: AttendeeRow) => void;
  /**
   * S2 — id of the visible `<Label>` for this list. When provided the list
   * is `aria-labelledby` it; otherwise it falls back to a self-contained
   * `aria-label` (e.g. when rendered standalone in tests).
   */
  readonly labelId?: string | undefined;
}) {
  const t = useTranslations('admin.invoices.eventFeeForm.attendeePicker');

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        {t('empty.none')}
      </p>
    );
  }

  const allErased = rows.every((r) => r.isPseudonymised);
  if (allErased) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        {t('empty.allErased')}
      </p>
    );
  }

  // B3 — plain list of toggle buttons (NOT an ARIA listbox). Each enabled
  // row is a `<button aria-pressed>`; the AT-broken listbox/option pattern
  // (which mandates arrow-key roving focus we don't implement) is gone.
  return (
    <ul
      className="flex flex-col gap-2"
      {...(labelId ? { 'aria-labelledby': labelId } : { 'aria-label': t('label') })}
    >
      {rows.map((row) => {
        const kind = matchBadgeKind(row);
        const selected = row.registrationId === selectedRegistrationId;
        const disabled = row.isPseudonymised;
        const priceLabel =
          row.ticketPriceThb === null || row.ticketPriceThb <= 0
            ? t('noPrice')
            : t('price', { amount: formatThb(row.ticketPriceThb) });
        const paymentLabel = row.paymentStatus || t('noPaymentStatus');

        const rowClassName = cn(
          'flex w-full items-center gap-3 rounded-md border p-3 text-left transition-colors',
          selected && 'border-primary bg-primary/5',
          disabled
            ? 'cursor-not-allowed opacity-60'
            : 'hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
        );

        // The full row content (name + company + badge + price + payment).
        // Price/payment columns hide on mobile (B2 — reflow ≥320px) but stay
        // in the accessible name for SR users via `rowAria`.
        const content = (
          <>
            <CheckIcon
              className={cn('size-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')}
              aria-hidden="true"
            />
            <span className="flex flex-1 flex-col">
              <span className="text-sm font-medium">{row.attendeeName}</span>
              {row.attendeeCompany && (
                <span className="text-xs text-muted-foreground">{row.attendeeCompany}</span>
              )}
            </span>
            <Badge variant={kind === 'matched' ? 'secondary' : 'outline'}>
              {t(`matchBadge.${kind}`)}
            </Badge>
            <span className="hidden w-20 shrink-0 text-right text-sm tabular-nums sm:block">
              {priceLabel}
            </span>
            <span className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground sm:block">
              {paymentLabel}
            </span>
          </>
        );

        // The base accessible name folds in name + match + price + payment;
        // for an erased row we additionally fold in the "not billable" reason
        // so SR/keyboard/touch users get it (B1).
        const baseAria = t('rowAria', {
          name: row.attendeeName,
          match: t(`matchBadge.${kind}`),
          price: priceLabel,
          payment: paymentLabel,
        });

        return (
          <li key={row.registrationId}>
            {disabled ? (
              // B1 — a `<button aria-disabled>` (NOT native `disabled`, so it
              // stays in the tab order + a11y tree). `aria-disabled` is valid
              // on button (unlike role="img"); the click is a hard no-op. The
              // erased reason lives in the accessible name AND an sr-only node
              // for sighted keyboard users. Mirrors the archived-banner
              // aria-disabled + reason-in-aria-label pattern.
              <button
                type="button"
                aria-disabled="true"
                aria-label={`${baseAria}. ${t('erasedTooltip')}`}
                onClick={(e) => e.preventDefault()}
                className={rowClassName}
                data-erased="true"
              >
                {content}
                <span className="sr-only">{t('erasedTooltip')}</span>
              </button>
            ) : (
              <button
                type="button"
                aria-pressed={selected}
                aria-label={baseAria}
                onClick={() => onSelect(row)}
                className={rowClassName}
              >
                {content}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Fetches the event's registrations and drives the picker. Owns its own
 * loading state so the parent renders `<EventAttendeePickerSkeleton>` while
 * the request is in flight. Returns the full `AttendeeRow` to the parent on
 * select so the parent can pre-fill the amount + branch the buyer section.
 *
 * The parent MUST key this component by `eventId` (`key={eventId}`) so a new
 * event selection REMOUNTS the loader — `rows` resets to `null` (loading)
 * via the initial-state, avoiding a synchronous `setState` inside the effect
 * (which would trigger a cascading re-render; ESLint react-hooks rule).
 */
export function EventAttendeePickerLoader({
  eventId,
  selectedRegistrationId,
  onSelect,
  onError,
  labelId,
}: {
  readonly eventId: string;
  readonly selectedRegistrationId: string | null;
  readonly onSelect: (row: AttendeeRow) => void;
  readonly onError: () => void;
  readonly labelId?: string | undefined;
}) {
  const [rows, setRows] = useState<readonly AttendeeRow[] | null>(null);
  // W2 — keep the skeleton visible ≥300ms so a fast fetch doesn't flash it
  // (ux-standards §2.3). `ready` is "rows have loaded".
  const showReal = useMinDelay(300, rows !== null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // pageSize 200 = the F6 detail-endpoint ceiling; SweCham events are
        // well under this. Pagination of the picker itself is a follow-up.
        const res = await fetch(
          `/api/admin/events/${encodeURIComponent(eventId)}?pageSize=200`,
        );
        if (!res.ok) {
          if (!cancelled) onError();
          return;
        }
        const body = (await res.json()) as {
          registrations?: readonly AttendeeRow[];
        };
        if (!cancelled) setRows(body.registrations ?? []);
      } catch {
        if (!cancelled) onError();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, onError]);

  if (rows === null || !showReal) return <EventAttendeePickerSkeleton />;
  return (
    <EventAttendeePicker
      rows={rows}
      selectedRegistrationId={selectedRegistrationId}
      onSelect={onSelect}
      labelId={labelId}
    />
  );
}
