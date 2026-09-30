'use client';

/**
 * The renewal pipeline's row actions and its empty-table copy.
 *
 * 122 US7a (T702): AURA `Button` + `DropdownMenu`. The pipeline is one AURA
 * `DataTable` that stacks into cards below 640px, so these render once per
 * row; in a phone card they are a full-width row at the end of the card, as
 * the `Admin-renewals-mobile` board draws it (a stand-in until AURA #118 in
 * `globals.css`, keyed on `data-pipeline-row-actions`).
 */
import { useRef, useTransition } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Button, DropdownMenu, IconButton, type MenuItem } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import {
  shouldOfferMarkPaid,
  shouldOfferRecordPaymentOnBill,
} from '../_lib/mark-paid-gate';
import type { CycleStatus } from '@/modules/renewals/client';

/**
 * The lifted "Record outreach" dialog target: `PipelineTable` holds it so the
 * dialog outlives the ⋯ menu closing.
 */
export interface OutreachTarget {
  readonly memberId: string;
  readonly companyName: string;
  readonly finalFocus: React.RefObject<HTMLElement | null>;
}

/** Same as {@link OutreachTarget}, for "Mark paid". */
export interface MarkPaidTarget {
  readonly cycleId: string;
  readonly companyName: string;
  readonly finalFocus: React.RefObject<HTMLElement | null>;
}

/**
 * The empty table's copy for AURA `DataTable`'s `empty` (title + optional
 * description). `overdue` / `later` get their own grammatical strings instead
 * of composing the lens label into the generic "renew in {month}" frame
 * (deferred fix-wave-2 #4); without a month lens the bucket copy points the
 * admin at the urgency tabs (J8-M30).
 */
export function usePipelineEmptyCopy(
  monthKind: 'overdue' | 'later' | 'month' | undefined,
  monthLabel: string | undefined,
): { readonly title: string; readonly description?: string } {
  const t = useTranslations('admin.renewals.table');
  if (monthKind === 'overdue') return { title: t('noRowsOverdue') };
  if (monthKind === 'later' && monthLabel !== undefined) {
    return { title: t('noRowsLater', { month: monthLabel }) };
  }
  if ((monthKind === 'month' || monthKind === undefined) && monthLabel !== undefined) {
    return { title: t('noRowsInMonth', { month: monthLabel }) };
  }
  return { title: t('noRows'), description: t('noRowsInBucket') };
}

// ---------------------------------------------------------------------------
// Wave I6+I7 · T108 — RowActions
// ---------------------------------------------------------------------------

/**
 * Row-level actions. Owns its own `useTransition` state so the
 * pipeline table's columns memo stays stable across renders. Item ②:
 * "Send reminder" is promoted out of the ⋯ menu to a one-click visible
 * button; the ⋯ menu keeps "Open" + "Mark contacted" (the latter now
 * opens the shared `OutreachDialog` via `onRecordOutreach`, lifted to
 * `PipelineTable` so the dialog survives this menu closing) + Task 5's
 * "Mark paid" (offered only when `shouldOfferMarkPaid(status,
 * linkedInvoiceId)` — mirrors the mark-paid-offline route's own guards so
 * this row never offers a control the API would reject). A payable row that
 * already has a live linked bill gets "Record payment on invoice" instead — a
 * link to that bill's F4 Record payment flow.
 *
 * Fix round 3 — `canMutate` additionally gates "Send reminder" and "Mark
 * paid" (both admin-only at the route) to `false` for a read-only manager.
 * "Open" and "Mark contacted" are unconditional — see `pipeline-table.tsx`'s
 * module docstring.
 */
export function RowActions({
  cycleId,
  memberId,
  companyName,
  status,
  linkedInvoiceId,
  canMutate,
  onRecordOutreach,
  onMarkPaid,
}: {
  readonly cycleId: string;
  readonly memberId: string;
  readonly companyName: string;
  readonly status: CycleStatus;
  readonly linkedInvoiceId: string | null;
  readonly canMutate: boolean;
  readonly onRecordOutreach: (t: OutreachTarget) => void;
  readonly onMarkPaid: (t: MarkPaidTarget) => void;
}): React.JSX.Element {
  const tActions = useTranslations('admin.renewals.actions');
  const tToast = useTranslations('admin.renewals.sendReminderNow.toast');
  const locale = useLocale();
  const [isPending, startTransition] = useTransition();
  // This row's ⋯ trigger, handed to the lifted dialogs as `finalFocus` so
  // focus returns here on close rather than to the menu item that opened
  // them (gone with the menu), which would drop it to `<body>`.
  const rowMenuTriggerRef = useRef<HTMLButtonElement | null>(null);

  const handleSendReminder = (): void => {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/admin/renewals/${cycleId}/send-reminder-now`,
          { method: 'POST' },
        );
        if (res.status === 401 || res.status === 403) {
          toast.error(tToast('error.unauthorized'));
          return;
        }
        if (res.status === 429) {
          const retry = res.headers.get('Retry-After') ?? '60';
          toast.error(tToast('error.rateLimited', { seconds: retry }));
          return;
        }
        if (res.status === 409) {
          const body = (await res.json().catch(() => null)) as {
            error?: { existing_dispatched_at?: string };
          } | null;
          const dispatchedAt = body?.error?.existing_dispatched_at;
          const ago = dispatchedAt ? formatRelativeAgo(dispatchedAt, locale) : '';
          toast.warning(tToast('skipped.alreadySent', { ago }));
          return;
        }
        if (!res.ok) {
          toast.error(tToast('error.network'));
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          outcome?: { kind: string; reason?: string };
        } | null;
        const outcome = body?.outcome;
        if (!outcome) {
          toast.error(tToast('error.generic'));
          return;
        }
        switch (outcome.kind) {
          case 'sent':
          case 'task_created':
            toast.success(tToast('sent.title'), {
              description: tToast('sent.description', { company: companyName }),
            });
            break;
          case 'skipped':
            toast.info(toastLabelForSkipReason(outcome.reason ?? 'generic', tToast));
            break;
          case 'failed_transient':
            toast.warning(tToast('failedTransient'));
            break;
          case 'failed_permanent':
            toast.error(tToast('failedPermanent'));
            break;
          default:
            toast.error(tToast('error.generic'));
        }
      } catch (e) {
        // K1-E5: previously `catch {}` swallowed every non-network
        // error (TypeError, SyntaxError, AbortController, locale
        // formatter, i18n missing-key) and collapsed all causes to
        // "network error" — admins saw "network error" while their
        // network was fine and a real bug was invisible. Capture +
        // log + use the generic toast so client-side bugs are at
        // least visible in browser console.

        console.error(
          '[F8] send-reminder-now: client handler failed',
          e,
        );
        toast.error(tToast('error.generic'));
      }
    });
  };

  // The ⋯ menu. "Open" and "Mark contacted" for everyone ("Mark contacted" is
  // FR-033 + FR-052a's one manager mutation); "Mark paid" or "Record payment
  // on invoice" for an admin only — both routes 403 a manager. Links go
  // through AuraProvider's router link (soft navigation, new-tab still works).
  const openOutreach = (): void =>
    onRecordOutreach({ memberId, companyName, finalFocus: rowMenuTriggerRef });
  // Opens the SAME mark-paid-offline dialog/route the cycle detail page uses
  // (Principle IV, no second settlement path).
  const openMarkPaid = (): void =>
    onMarkPaid({ cycleId, companyName, finalFocus: rowMenuTriggerRef });
  const items: MenuItem[] = [
    { label: tActions('open'), href: `/admin/renewals/${cycleId}` },
    { label: tActions('markContacted'), onSelect: openOutreach },
    ...(canMutate && shouldOfferMarkPaid(status, linkedInvoiceId)
      ? [{ label: tActions('markPaid'), onSelect: openMarkPaid }]
      : []),
    // A payable row with a live linked bill: mark-paid would be refused
    // (`membership_bill_already_exists`), so link to that bill's F4 Record
    // payment flow instead.
    ...(canMutate && shouldOfferRecordPaymentOnBill(status, linkedInvoiceId)
      ? [
          {
            label: tActions('recordPaymentOnInvoice'),
            href: `/admin/invoices/${encodeURIComponent(linkedInvoiceId)}`,
          },
        ]
      : []),
  ];
  const menuLabel = tActions('rowMenu', { company: companyName });

  // In a phone card the actions take the full row: `in-[.aura-table--stacked]`
  // reads AURA's stacked class — a stand-in until AURA #118 (a card slot for a
  // full-width action row).
  return (
    <div
      data-pipeline-row-actions=""
      className="flex items-center justify-end gap-[var(--aura-space-1)] in-[.aura-table--stacked]:w-full"
    >
      {/* "Send reminder" is a one-click visible button (item ②), admin only:
          the route 403s a manager, so it is absent rather than disabled
          (FR-052a). Small in the grid row; 44px tall on a phone. AURA app
          content: in a phone card it takes the row's width beside the ⋯. */}
      {canMutate ? (
        <Button
          variant="secondary"
          size="sm"
          touchHeight
          loading={isPending}
          onClick={handleSendReminder}
          aria-label={tActions('sendReminderAriaLabel', { company: companyName })}
          // Full-width beside the ⋯ in a phone card: stand-in until AURA #118.
          className="in-[.aura-table--stacked]:flex-1"
        >
          {tActions('sendReminder')}
        </Button>
      ) : null}
      {/* The trigger keeps a ref so a dialog opened from the menu returns
          focus here when it closes (the menu item it came from is gone). */}
      <DropdownMenu
        label={menuLabel}
        items={items}
        trigger={
          <IconButton ref={rowMenuTriggerRef} icon="ellipsis" label={menuLabel} size="sm" />
        }
      />
    </div>
  );
}

function formatRelativeAgo(iso: string, locale: string): string {
  const rtfLocale = mapToRtfLocale(locale);
  let target: number;
  try {
    target = new Date(iso).getTime();
    if (!Number.isFinite(target)) return iso;
  } catch {
    return iso;
  }
  const deltaMs = target - Date.now();
  const absSec = Math.abs(deltaMs) / 1000;
  const rtf = new Intl.RelativeTimeFormat(rtfLocale, { numeric: 'auto' });
  if (absSec < 60) return rtf.format(Math.round(deltaMs / 1000), 'second');
  if (absSec < 3600) return rtf.format(Math.round(deltaMs / 60_000), 'minute');
  if (absSec < 86_400) return rtf.format(Math.round(deltaMs / 3_600_000), 'hour');
  return rtf.format(Math.round(deltaMs / 86_400_000), 'day');
}

function mapToRtfLocale(locale: string): string {
  // next-intl 'en' / 'th' / 'sv' map directly to BCP-47 tags.
  return locale === 'th' ? 'th-TH' : locale === 'sv' ? 'sv-SE' : 'en-US';
}

function toastLabelForSkipReason(
  reason: string,
  t: ReturnType<typeof useTranslations<'admin.renewals.sendReminderNow.toast'>>,
): string {
  switch (reason) {
    case 'member_archived':
      return t('skipped.memberArchived');
    case 'member_opted_out':
      return t('skipped.memberOptedOut');
    case 'email_unverified':
      return t('skipped.emailUnverified');
    case 'outreach_in_progress':
      return t('skipped.outreachInProgress');
    case 'no_primary_contact':
      return t('skipped.noPrimaryContact');
    default:
      return t('skipped.generic', { reason });
  }
}
