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
 *  - **Decision 4** — ONE shared `payment_method` / `payment_reference` /
 *    `payment_date` applies to every row in the batch (models a single bank
 *    transfer covering many members at once). The copy says so explicitly.
 *
 * This component OWNS the settlement-preview fetch + the shared payment
 * fields + the previewable/non-previewable split. It does NOT execute the
 * mark-paid batch itself — `onConfirm(batch, body)` hands the previewable
 * `{cycleId, companyName}` pairs + the shared body to the caller
 * (`PipelineBulkActionBar`), which owns the actual per-cycle fan-out,
 * outcome bucketing, toasts, and the persistent results panel (Decision 5).
 * This split keeps the money-mutating fan-out testable via fetch-mocking
 * WITHOUT ever needing a click-through submit on a live Base UI Dialog (the
 * documented jsdom + React 19 `startTransition` hang — see
 * `mark-paid-offline-dialog.tsx`'s test docstring). This component itself
 * uses NO `useTransition`/`startTransition` (plain `useState` submitting
 * flag, same shape as `ConfirmationDialog`), so a plain-click confirm test
 * is expected to be safe, but the bar's OWN test suite mocks this component
 * out anyway for consistency with the repo's established convention
 * (`bulk-action-bar-enrol-toast.test.tsx`).
 *
 * Reuses `isMarkPaidIncomplete` from the single-row mark-paid-offline
 * validation (same required-field gate — reference + date must be
 * non-empty) and the same three `payment_method` choices as
 * `MarkPaidOfflineDialog`, VERBATIM route (`POST …/mark-paid-offline`,
 * called by the caller, never here) — no second settlement path
 * (Constitution Principle IV).
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

export interface MarkPaidBatchBody {
  readonly payment_method: PaymentMethod;
  readonly payment_reference: string;
  readonly payment_date: string;
}

export interface BulkMarkPaidBatchEntry {
  readonly cycleId: string;
  readonly companyName: string;
}

/** Client-side mirror of `SettlementPreviewRow` (application-layer, branded
 * `CycleId`) — this dialog only ever sees the wire (snake_case) JSON, so it
 * keeps its own plain-string shape rather than fighting the brand cast. */
interface PreviewItem {
  readonly cycleId: string;
  readonly companyName: string;
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
      readonly totalThbMinor: number;
    };

export interface BulkMarkPaidConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The FULL current selection (previewable + non-previewable) — this
   *  dialog fetches the preview for all of them and shows both groups. */
  readonly cycleIds: readonly string[];
  /**
   * Caller-owned execution: receives ONLY the previewable batch (Decision
   * 3) + the shared payment body (Decision 4). The caller runs the actual
   * per-cycle fan-out and reports outcomes; this dialog always closes once
   * the returned promise settles (mirrors `MarkPaidOfflineDialog`'s
   * always-resolve-then-close shape, simplified — Decision 5's persistent
   * failure/skip visibility lives in the caller's results panel, not here).
   */
  readonly onConfirm: (
    batch: readonly BulkMarkPaidBatchEntry[],
    body: MarkPaidBatchBody,
  ) => Promise<void>;
  readonly finalFocus?: () => HTMLElement | null;
}

/** Decision 3 — the ONLY rows a bulk mark-paid batch may act on. Pure
 *  (no I/O, no rendering) so it is unit-testable without a Base UI Dialog. */
export function selectPreviewableBatch(
  items: readonly PreviewItem[],
): BulkMarkPaidBatchEntry[] {
  return items
    .filter((i) => i.previewable)
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
            amount_thb_minor: number | null;
            currency: string | null;
            previewable: boolean;
          }>;
          total_thb_minor?: number;
        } | null;
        if (
          !body ||
          !Array.isArray(body.items) ||
          typeof body.total_thb_minor !== 'number'
        ) {
          if (!cancelled) setPreview({ kind: 'error' });
          return;
        }
        if (cancelled) return;
        setPreview({
          kind: 'ready',
          items: body.items.map((r) => ({
            cycleId: r.cycle_id,
            companyName: r.company_name,
            amountThbMinor: r.amount_thb_minor,
            currency: r.currency,
            previewable: r.previewable,
          })),
          totalThbMinor: body.total_thb_minor,
        });
      } catch {
        if (!cancelled) setPreview({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, cycleIds]);

  const previewableItems = useMemo(
    () => (preview.kind === 'ready' ? preview.items.filter((i) => i.previewable) : []),
    [preview],
  );
  const nonPreviewableItems = useMemo(
    () => (preview.kind === 'ready' ? preview.items.filter((i) => !i.previewable) : []),
    [preview],
  );

  const trimmedReference = paymentReference.trim();
  const incomplete = isMarkPaidIncomplete(paymentReference, paymentDate);
  const confirmDisabled =
    submitting || preview.kind !== 'ready' || previewableItems.length === 0 || incomplete;

  const handleConfirm = async (): Promise<void> => {
    if (confirmDisabled || preview.kind !== 'ready') return;
    const batch = selectPreviewableBatch(preview.items);
    setSubmitting(true);
    try {
      await onConfirm(batch, {
        payment_method: paymentMethod,
        payment_reference: trimmedReference,
        payment_date: paymentDate,
      });
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
                  {formatThbMinor(preview.totalThbMinor, locale, 'THB')}
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
