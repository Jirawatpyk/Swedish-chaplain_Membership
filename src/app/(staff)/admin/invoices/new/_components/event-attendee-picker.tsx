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

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckIcon, Users } from 'lucide-react';
import { Badge } from '@jirawatpyk/aura-react';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import { EmptyState } from '@/components/shell/empty-state';
import { ErrorState } from '@/components/shell/error-state';
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
   * 059 / PR-A Task 6c — server-truth VAT-REGISTRANT status for MATCHED
   * members, read from the recorded `members.is_vat_registered` flag (only the
   * boolean crosses the wire; the raw tax-id is never even read):
   *   - `true` / `false` — matched member, flag resolved;
   *   - `null`           — non-member (the manual buyer's tax-id field rules
   *                        there) OR a matched id the lookup couldn't resolve
   *                        (degraded enrichment);
   *   - absent           — an older API response shape.
   *
   * REPLACES the 064-remediation-B5 `buyerHasTin` field. Issuance decides the
   * event document class on the registrant flag, not on "is tax_id non-blank"
   * (a foreign member may store a passport there). While this asked the TIN
   * question, a TIN-bearing NON-registrant was offered bill_first and then
   * refused at issue with "this buyer has no tax ID" — while visibly having one.
   */
  readonly buyerIsVatRegistrant?: boolean | null;
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
  const t = useTranslations('admin.invoices.eventFeeForm.attendeePicker');
  // W1 — hide this skeleton block from the a11y tree locally (the shared
  // <Skeleton> primitive is NOT modified; 500+ call-sites are out of scope).
  // #82 (UX L8) — so say it is loading, for screen readers.
  return (
    <>
    <p role="status" className="sr-only">{t('loading')}</p>
    <div
      className="flex flex-col gap-2"
      data-testid="attendee-picker-skeleton"
      aria-hidden="true"
    >
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-[var(--aura-radius-md)] border border-[var(--aura-border-subtle)] p-3">
          <SkeletonBlock className="h-4 w-4 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <SkeletonBlock className="h-4 w-40" />
            <SkeletonBlock className="h-3 w-24" />
          </div>
          <SkeletonBlock className="h-5 w-20" />
          <SkeletonBlock className="h-4 w-16" />
        </div>
      ))}
    </div>
    </>
  );
}

function formatThb(thb: number): string {
  // N11 parity — pin 'en-US' so the thousands separator is deterministic
  // (the same convention the membership form's `formatSatangAmount` uses).
  return thb.toLocaleString('en-US');
}

export function EventAttendeePicker({
  rows,
  selectedRegistrationId,
  onSelect,
  labelId,
  describedById,
}: {
  readonly rows: readonly AttendeeRow[];
  readonly selectedRegistrationId: string | null;
  readonly onSelect: (row: AttendeeRow) => void;
  /** #82 — the "Showing N of M" line when the list is cut. */
  readonly describedById?: string | undefined;
  /**
   * S2 — id of the visible `<Label>` for this list. When provided the list
   * is `aria-labelledby` it; otherwise it falls back to a self-contained
   * `aria-label` (e.g. when rendered standalone in tests).
   */
  readonly labelId?: string | undefined;
}) {
  const t = useTranslations('admin.invoices.eventFeeForm.attendeePicker');

  if (rows.length === 0) {
    // PR Q — AURA's EmptyState (its dashed frame is the old hand-drawn one).
    return <EmptyState icon={Users} title={t('empty.none')} size="sm" />;
  }

  const allErased = rows.every((r) => r.isPseudonymised);
  if (allErased) {
    return <EmptyState icon={Users} title={t('empty.allErasedTitle')} description={t('empty.allErased')} size="sm" />;
  }

  // B3 — plain list of toggle buttons (NOT an ARIA listbox). Each enabled
  // row is a `<button aria-pressed>`; the AT-broken listbox/option pattern
  // (which mandates arrow-key roving focus we don't implement) is gone.
  return (
    <ul
      className="flex flex-col gap-2"
      {...(labelId ? { 'aria-labelledby': labelId } : { 'aria-label': t('label') })}
      {...(describedById ? { 'aria-describedby': describedById } : {})}
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
          'flex w-full items-center gap-3 rounded-[var(--aura-radius-md)] border border-[var(--aura-border-subtle)] p-3 text-left transition-colors',
          selected && 'border-[var(--aura-border-strong)] bg-[var(--aura-bg-selected)]',
          disabled
            ? 'cursor-not-allowed opacity-60'
            : 'hover:bg-[var(--aura-bg-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aura-focus-ring)]',
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
            {/* min-w-0 lets the name column shrink so the shrink-0 member badge
                stays inside a 320px viewport (WCAG 1.4.10; wider AURA Inter font). */}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{row.attendeeName}</span>
              {row.attendeeCompany && (
                <span className="text-xs text-[var(--aura-fg-secondary)]">{row.attendeeCompany}</span>
              )}
            </span>
            {/* A matched member in the accent tone; non-member and unmatched
                stay neutral (a category, not a status). */}
            <Badge tone={kind === 'matched' ? 'accent' : 'neutral'} variant={kind === 'matched' ? 'soft' : 'outline'}>
              {t(`matchBadge.${kind}`)}
            </Badge>
            <span className="hidden w-20 shrink-0 text-right text-sm tabular-nums sm:block">
              {priceLabel}
            </span>
            <span className="hidden w-16 shrink-0 text-right text-xs text-[var(--aura-fg-secondary)] sm:block">
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
          <li key={row.registrationId} data-registration-id={row.registrationId}>
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
 * event selection REMOUNTS the loader — `loaded` resets to `null` (loading)
 * via the initial-state, avoiding a synchronous `setState` inside the effect
 * (which would trigger a cascading re-render; ESLint react-hooks rule).
 */
/** The detail route's page ceiling. */
export const ATTENDEE_PAGE_SIZE = 200;
/**
 * #82 — how many attendees the picker loads at most (10 pages). A chamber
 * event is far below this; past it the list says it is cut.
 */
export const ATTENDEE_LOAD_CAP = 2000;

type DetailPage = {
  registrations?: readonly AttendeeRow[];
  pagination?: { totalCount?: number };
};

export function EventAttendeePickerLoader({
  eventId,
  selectedRegistrationId,
  autoSelectRegistrationId = null,
  onSelect,
  labelId,
}: {
  readonly eventId: string;
  readonly selectedRegistrationId: string | null;
  /**
   * #82 (UX M3) — a deep-linked registration: once the list loads it is
   * picked (so the buyer and amount fill in, not only the highlight) and
   * scrolled into view.
   */
  readonly autoSelectRegistrationId?: string | null;
  readonly onSelect: (row: AttendeeRow) => void;
  readonly labelId?: string | undefined;
}) {
  const t = useTranslations('admin.invoices.eventFeeForm.attendeePicker');
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'failed' }
    | { readonly kind: 'ok'; readonly rows: readonly AttendeeRow[]; readonly total: number }
  >({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // W2 — keep the skeleton visible ≥300ms so a fast fetch doesn't flash it
  // (ux-standards §2.3). `ready` is "the load settled".
  const showReal = useMinDelay(300, state.kind !== 'loading');
  const autoSelected = useRef(false);
  const cutId = `attendee-picker-cut-${eventId}`;

  useEffect(() => {
    let cancelled = false;
    const pageUrl = (page: number) =>
      `/api/admin/events/${encodeURIComponent(eventId)}?pageSize=${ATTENDEE_PAGE_SIZE}&page=${page}`;
    const fetchPage = async (page: number): Promise<DetailPage> => {
      const res = await fetch(pageUrl(page));
      if (!res.ok) throw new Error(`attendee page ${page} responded ${res.status}`);
      return (await res.json()) as DetailPage;
    };
    (async () => {
      let first: DetailPage;
      try {
        first = await fetchPage(1);
      } catch {
        // #82 (UX M1) — an inline error with Retry, never a skeleton that
        // stays forever.
        if (!cancelled) setState({ kind: 'failed' });
        return;
      }
      // #82 — the route pages at 200; read every page (up to the cap) so an
      // attendee past the first 200, or a deep-linked one, is listed. A page
      // that fails drops only its rows; the "Showing N of M" line says so.
      const firstRows = first.registrations ?? [];
      const total = first.pagination?.totalCount ?? firstRows.length;
      const pages = Math.min(Math.ceil(total / ATTENDEE_PAGE_SIZE), ATTENDEE_LOAD_CAP / ATTENDEE_PAGE_SIZE);
      const rest = await Promise.allSettled(
        Array.from({ length: Math.max(0, pages - 1) }, (_, i) => fetchPage(i + 2)),
      );
      const seen = new Set<string>();
      const rows = [firstRows, ...rest.map((p) => (p.status === 'fulfilled' ? (p.value.registrations ?? []) : []))]
        .flat()
        .filter((r) => (seen.has(r.registrationId) ? false : (seen.add(r.registrationId), true)));
      if (!cancelled) setState({ kind: 'ok', rows, total });
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, attempt]);

  // #82 (UX M3) — pick the deep-linked attendee once, and bring it into view.
  useEffect(() => {
    if (state.kind !== 'ok' || !showReal || autoSelected.current || autoSelectRegistrationId === null) return;
    autoSelected.current = true;
    const row = state.rows.find((r) => r.registrationId === autoSelectRegistrationId && !r.isPseudonymised);
    if (!row) return;
    onSelect(row);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    document
      .querySelector(`[data-registration-id="${CSS.escape(row.registrationId)}"]`)
      ?.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  }, [state, showReal, autoSelectRegistrationId, onSelect]);

  if (!showReal || state.kind === 'loading') return <EventAttendeePickerSkeleton />;
  if (state.kind === 'failed') {
    return (
      <ErrorState
        title={t('loadFailedTitle')}
        description={t('loadFailed')}
        onRetry={() => {
          setState({ kind: 'loading' });
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  const cut = state.total > state.rows.length;
  return (
    <div className="flex flex-col gap-[var(--aura-space-2)]">
      {cut ? (
        <p id={cutId} className="text-sm text-[var(--aura-fg-secondary)]" data-testid="attendee-picker-cut">
          {t('cut', { shown: state.rows.length, total: state.total })}
        </p>
      ) : null}
      <EventAttendeePicker
        rows={state.rows}
        selectedRegistrationId={selectedRegistrationId}
        onSelect={onSelect}
        labelId={labelId}
        describedById={cut ? cutId : undefined}
      />
    </div>
  );
}
