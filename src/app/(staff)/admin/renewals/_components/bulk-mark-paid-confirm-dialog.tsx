'use client';

/**
 * 059-membership-suspension Task 11 — `BulkMarkPaidConfirmDialog`.
 *
 * The confirm step for `PipelineBulkActionBar`'s bulk "Mark paid" action.
 * Financial-integrity review (Decisions 3/4 — see the Task 11 brief)
 * supersedes the task brief's original single-fetch sketch:
 *
 *  - **Decision 3** — bulk mark-paid is restricted to PREVIEWABLE cycles
 *    only (a live linked invoice with `status='issued'`, non-void — exactly
 *    Task 9's `settlement-preview` `previewable` flag). A cycle with no bill
 *    yet (`upcoming`) would MINT a fresh §86/4 on mark-paid — that is never
 *    safe to fire blind in a batch, so those rows are shown as "not
 *    bulk-payable — settle individually" and EXCLUDED from the batch this
 *    dialog hands back to the caller. `selectPreviewableBatch` is the pure
 *    function that draws that line — unit-tested directly (no rendering)
 *    so Decision 3 is pinned without touching Base UI Dialog interaction.
 *    Review round 1 (SHOULD 3) tightened the line: a row can be
 *    `previewable: true` and STILL carry a null `amountThbMinor` (the API
 *    contract allows it even though Task 9 rows always populate one today)
 *    — `isBulkPayable` requires BOTH, so a row with no legible figure is
 *    never shown/settled without one. `selectNotBulkPayableBatch` is the
 *    complementary pure function (review round 1, SHOULD 4) — it hands the
 *    excluded rows (non-previewable + previewable-but-unpriced) back to the
 *    caller too, so `PipelineBulkActionBar` can keep them visible in the
 *    persistent results panel after the run, not just in this dialog.
 *  - **Decision 4** — ONE shared `payment_method` / `payment_reference` /
 *    `payment_date` applies to every row in the batch (models a single bank
 *    transfer covering many members at once). The copy says so explicitly.
 *
 * This component OWNS the settlement-preview fetch + the shared payment
 * fields + the previewable/non-previewable split. It does NOT execute the
 * mark-paid batch itself — `onConfirm(batch, body, notBulkPayable)` hands
 * the bulk-payable `{cycleId, companyName}` pairs + the shared body + the
 * excluded rows to the caller (`PipelineBulkActionBar`), which owns the
 * actual per-cycle fan-out, outcome bucketing, toasts, and the persistent
 * results panel (Decision 5). This split keeps the money-mutating fan-out
 * testable via fetch-mocking WITHOUT ever needing a click-through submit on
 * a live Base UI Dialog (the documented jsdom + React 19 `startTransition`
 * hang — see `mark-paid-offline-dialog.tsx`'s test docstring). This
 * component itself uses NO `useTransition`/`startTransition` (plain
 * `useState` submitting flag, same shape as `ConfirmationDialog`), so a
 * plain-click confirm test is expected to be safe — review round 1
 * (SHOULD 5) added exactly that: a real click-through `handleConfirm` test
 * pinning that only bulk-payable cycleIds ever reach `onConfirm`. The bar's
 * OWN test suite still mocks this component out for the fan-out/bucketing
 * tests, for consistency with the repo's established convention
 * (`bulk-action-bar-enrol-toast.test.tsx`).
 *
 * Reuses `isMarkPaidIncomplete` from the single-row mark-paid-offline
 * validation (same required-field gate — reference + date must be
 * non-empty) and the same three `payment_method` choices as
 * `MarkPaidOfflineDialog` — that is ALL that is shared with the single-row
 * dialog. The route is NOT shared: per the C1 fix (see the caller's module
 * docstring), the batch this dialog hands back settles via the F4
 * record-payment route (`POST /api/invoices/[invoiceId]/pay`), never the
 * mint-and-pay `POST …/mark-paid-offline` route — that route 409s on every
 * previewable row here (they all already have a live membership bill). The
 * fan-out itself happens in the caller, never in this component — no second
 * settlement path (Constitution Principle IV).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2Icon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isMarkPaidIncomplete } from '../[cycleId]/_components/cycle-admin-validation';

const PAYMENT_METHODS = ['bank_transfer', 'cash', 'cheque'] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * The record-payment request body shared across every row in the batch
 * (Decision 4 — one bank transfer covering many members). C1 fix: the batch
 * now settles the EXISTING issued invoice via F4 `POST /api/invoices/
 * [invoiceId]/pay`, so these field names mirror `recordPaymentSchema`
 * (camelCase) EXACTLY — the caller spreads this straight into the POST body
 * and the route pins `tenantId`/`actorUserId`/`requestId`/`invoiceId`/
 * `triggeredBy` on top.
 */
export interface MarkPaidBatchBody {
  readonly paymentMethod: PaymentMethod;
  readonly paymentReference: string;
  readonly paymentDate: string;
}

/** A row shown in the dialog / results panel (display identity only). */
export interface BulkMarkPaidBatchEntry {
  readonly cycleId: string;
  readonly companyName: string;
}

/**
 * A bulk-payable row: previewable, priced, AND carrying its issued invoice's
 * id — the caller POSTs `/api/invoices/{invoiceId}/pay` per entry (C1 fix:
 * record payment against the EXISTING issued invoice, never mint-and-pay).
 */
export interface BulkMarkPaidPayableEntry extends BulkMarkPaidBatchEntry {
  readonly invoiceId: string;
}

/** Client-side mirror of `SettlementPreviewRow` (application-layer, branded
 * `CycleId`) — this dialog only ever sees the wire (snake_case) JSON, so it
 * keeps its own plain-string shape rather than fighting the brand cast. */
interface PreviewItem {
  readonly cycleId: string;
  readonly companyName: string;
  readonly invoiceId: string | null;
  readonly amountThbMinor: number | null;
  readonly currency: string | null;
  readonly previewable: boolean;
}

type PreviewState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | {
      readonly kind: 'ready';
      readonly items: readonly PreviewItem[];
    };

export interface BulkMarkPaidConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The FULL current selection (previewable + non-previewable) — this
   *  dialog fetches the preview for all of them and shows both groups. */
  readonly cycleIds: readonly string[];
  /**
   * Caller-owned execution: receives the bulk-payable batch (Decision 3,
   * tightened by review round 1 SHOULD 3 — previewable AND a legible
   * amount) + the shared payment body (Decision 4) + the excluded
   * not-bulk-payable rows (review round 1 SHOULD 4 — so the caller can
   * keep them visible after the run, not just in this dialog). The caller
   * runs the actual per-cycle fan-out and reports outcomes; this dialog
   * always closes once the returned promise settles (mirrors
   * `MarkPaidOfflineDialog`'s always-resolve-then-close shape, simplified —
   * Decision 5's persistent failure/skip visibility lives in the caller's
   * results panel, not here).
   */
  readonly onConfirm: (
    batch: readonly BulkMarkPaidPayableEntry[],
    body: MarkPaidBatchBody,
    notBulkPayable: readonly BulkMarkPaidBatchEntry[],
  ) => Promise<void>;
  readonly finalFocus?: () => HTMLElement | null;
}

/**
 * Decision 3 (tightened by review round 1, SHOULD 3; C1 fix adds the
 * invoiceId gate; code-review fix adds the currency gate) — the ONLY rows a
 * bulk mark-paid batch may act on: `previewable` AND a legible THB amount AND
 * a linked issued `invoiceId` (the id the caller POSTs
 * `/api/invoices/{invoiceId}/pay` against) AND `currency === 'THB'`. A
 * previewable row is ALWAYS one whose linked invoice is `status='issued'`
 * (Task 9), so it always carries an `invoiceId` today — the null-guard is
 * defensive, but a batch row with no invoice id could not be settled at all,
 * so it must never be shown as payable.
 *
 * The currency gate mirrors `loadSettlementPreview`'s own
 * `previewable && currency === 'THB'` gate on `totalThbMinor`
 * (`load-settlement-preview.ts`) EXACTLY — before this fix, a previewable
 * non-THB row satisfied this guard (no currency check) but was excluded from
 * the server's total, so it could be POSTed into the settled batch while the
 * dialog showed a grand total that understated the money actually settled.
 * A non-THB row now falls to `selectNotBulkPayableBatch` and is shown under
 * "settle individually", same as an unpriced row.
 */
function isBulkPayable(item: PreviewItem): item is PreviewItem & {
  readonly invoiceId: string;
  readonly amountThbMinor: number;
  readonly currency: string;
} {
  return (
    item.previewable &&
    item.amountThbMinor !== null &&
    item.invoiceId !== null &&
    item.currency === 'THB'
  );
}

/** Pure (no I/O, no rendering) so it is unit-testable without a Base UI Dialog. */
export function selectPreviewableBatch(
  items: readonly PreviewItem[],
): BulkMarkPaidPayableEntry[] {
  return items
    .filter(isBulkPayable)
    .map((i) => ({
      cycleId: i.cycleId,
      companyName: i.companyName,
      invoiceId: i.invoiceId,
    }));
}

/**
 * Review round 1 (SHOULD 4) — the complement of {@link selectPreviewableBatch}:
 * every row EXCLUDED from the batch (non-previewable `upcoming` cycles AND
 * previewable-but-unpriced rows), handed to the caller so it can keep them
 * visible in the persistent results panel under "settle individually" —
 * otherwise `onClear()` + `router.refresh()` drop them from view entirely
 * and the treasurer forgets the still-unbilled members.
 */
export function selectNotBulkPayableBatch(
  items: readonly PreviewItem[],
): BulkMarkPaidBatchEntry[] {
  return items
    .filter((i) => !isBulkPayable(i))
    .map((i) => ({ cycleId: i.cycleId, companyName: i.companyName }));
}

function formatThbMinor(minorUnits: number, locale: string, currency: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    // Holds the ฿ symbol in every locale — under `en` the default symbol
    // display renders "THB 1,070.00", which reads as a currency code, not
    // money. Same convention as `portal/renewal/.../_lib/format-thb.ts` and
    // `tier-upgrade-queue.tsx`.
    currencyDisplay: 'narrowSymbol',
  }).format(minorUnits / 100);
}

export function BulkMarkPaidConfirmDialog({
  open,
  onOpenChange,
  cycleIds,
  onConfirm,
  finalFocus,
}: BulkMarkPaidConfirmDialogProps) {
  const t = useTranslations('admin.renewals.bulk');
  const locale = useLocale();
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('bank_transfer');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const reset = (): void => {
    setPaymentReference('');
    setPaymentDate('');
    setPaymentMethod('bank_transfer');
  };

  // Fetch a FRESH preview every time the dialog opens — Task 9's read-only
  // endpoint (no money moves here). Re-runs whenever `cycleIds` changes too
  // (a different batch was selected between opens).
  useEffect(() => {
    if (!open || cycleIds.length === 0) {
      return;
    }
    let cancelled = false;
    setPreview({ kind: 'loading' });
    void (async () => {
      try {
        const query = cycleIds.map(encodeURIComponent).join(',');
        const res = await fetch(`/api/admin/renewals/settlement-preview?cycle_ids=${query}`);
        if (!res.ok) {
          if (!cancelled) setPreview({ kind: 'error' });
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          items?: ReadonlyArray<{
            cycle_id: string;
            company_name: string;
            invoice_id: string | null;
            amount_thb_minor: number | null;
            currency: string | null;
            previewable: boolean;
          }>;
          // `total_thb_minor` is still on the wire (the settlement-preview
          // route's own server-computed total — untouched by this fix) but
          // is intentionally NOT read here: the grand total this dialog
          // shows is now the CLIENT-SIDE sum over `previewableItems` (see
          // `clientTotalThbMinor` below), so it is always ≡ the batch this
          // dialog hands back to the caller, by construction — independent
          // of the server's separately-gated total.
        } | null;
        if (!body || !Array.isArray(body.items)) {
          if (!cancelled) setPreview({ kind: 'error' });
          return;
        }
        if (cancelled) return;
        setPreview({
          kind: 'ready',
          items: body.items.map((r) => ({
            cycleId: r.cycle_id,
            companyName: r.company_name,
            invoiceId: r.invoice_id,
            amountThbMinor: r.amount_thb_minor,
            currency: r.currency,
            previewable: r.previewable,
          })),
        });
      } catch {
        if (!cancelled) setPreview({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, cycleIds]);

  // Mirrors `isBulkPayable`/`selectPreviewableBatch` exactly — a row shown
  // here as priced-and-included must be the SAME set the batch acts on
  // (review round 1, SHOULD 3).
  const previewableItems = useMemo(
    () => (preview.kind === 'ready' ? preview.items.filter(isBulkPayable) : []),
    [preview],
  );
  const nonPreviewableItems = useMemo(
    () => (preview.kind === 'ready' ? preview.items.filter((i) => !isBulkPayable(i)) : []),
    [preview],
  );
  // Code-review fix — the grand total is the CLIENT-SIDE sum of the exact
  // rows shown/settled above (`previewableItems`, already narrowed by
  // `isBulkPayable` to a non-null `amountThbMinor`), NOT the server's
  // separately-gated `total_thb_minor`. This makes the displayed total ≡ the
  // settled batch by construction — it can never drift from what gets
  // POSTed, regardless of how the server's own gate is defined.
  const clientTotalThbMinor = useMemo(
    () => previewableItems.reduce((sum, item) => sum + item.amountThbMinor, 0),
    [previewableItems],
  );

  const trimmedReference = paymentReference.trim();
  const incomplete = isMarkPaidIncomplete(paymentReference, paymentDate);
  const confirmDisabled =
    submitting || preview.kind !== 'ready' || previewableItems.length === 0 || incomplete;

  const handleConfirm = async (): Promise<void> => {
    if (confirmDisabled || preview.kind !== 'ready') return;
    const batch = selectPreviewableBatch(preview.items);
    const notBulkPayable = selectNotBulkPayableBatch(preview.items);
    setSubmitting(true);
    try {
      await onConfirm(
        batch,
        {
          paymentMethod,
          paymentReference: trimmedReference,
          paymentDate,
        },
        notBulkPayable,
      );
    } finally {
      setSubmitting(false);
      onOpenChange(false);
      reset();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent initialFocus={cancelRef} finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{t('confirmMarkPaidTitle')}</DialogTitle>
          <DialogDescription>{t('confirmMarkPaidDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {preview.kind === 'loading' && (
            <p className="text-sm text-muted-foreground">{t('previewLoading')}</p>
          )}
          {preview.kind === 'error' && (
            <p role="alert" className="text-sm text-destructive">
              {t('previewError')}
            </p>
          )}
          {preview.kind === 'ready' && (
            <>
              <ul className="space-y-1 text-sm">
                {previewableItems.map((item) => (
                  <li key={item.cycleId} className="flex items-center justify-between gap-2">
                    <span>{item.companyName}</span>
                    <span className="tabular-nums">
                      {item.amountThbMinor !== null
                        ? formatThbMinor(item.amountThbMinor, locale, item.currency ?? 'THB')
                        : '—'}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between border-t pt-2 text-sm font-semibold">
                <span>{t('previewGrandTotalLabel')}</span>
                <span className="tabular-nums">
                  {formatThbMinor(clientTotalThbMinor, locale, 'THB')}
                </span>
              </div>
              {nonPreviewableItems.length > 0 && (
                <div className="space-y-1 border-t pt-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('previewNotBulkPayableHeading')}
                  </p>
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {nonPreviewableItems.map((item) => (
                      <li key={item.cycleId} className="flex items-center justify-between gap-2">
                        <span>{item.companyName}</span>
                        <span>{t('previewRowUnpriced')}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="bulk-mark-paid-method">{t('paymentMethodLabel')}</Label>
            <Select
              value={paymentMethod}
              onValueChange={(v) => setPaymentMethod(v as PaymentMethod)}
            >
              <SelectTrigger id="bulk-mark-paid-method" className="w-full">
                <TranslatedSelectValue translate={(v) => t(`paymentMethod.${v}`)} />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(`paymentMethod.${m}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-mark-paid-reference">{t('paymentReferenceLabel')}</Label>
            <Input
              id="bulk-mark-paid-reference"
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
              placeholder={t('paymentReferencePlaceholder')}
              maxLength={100}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-mark-paid-date">{t('paymentDateLabel')}</Label>
            <Input
              id="bulk-mark-paid-date"
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              required
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t('cancel')}
          </Button>
          <Button onClick={() => void handleConfirm()} disabled={confirmDisabled}>
            {submitting && (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            )}
            {t('confirmMarkPaidAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
