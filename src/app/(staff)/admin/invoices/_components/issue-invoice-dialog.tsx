'use client';

/**
 * F4 UX flow refactor — Issue invoice as AlertDialog.
 *
 * Replaces the previous `/admin/invoices/[id]/issue` full-page route
 * with an in-context AlertDialog triggered from the invoice detail
 * page. Aligns with the project's destructive-action pattern:
 *   - F3 `archive-member-button` (AlertDialog + reason textarea)
 *   - F2 `clone-year-dialog` (AlertDialog + typed confirmation)
 *   - F1 `idle-warning-dialog` (AlertDialog + decision)
 *
 * Why AlertDialog (not Dialog):
 *   - Issue pins an IMMUTABLE tax snapshot — under the 088 flow a non-§87
 *     ใบแจ้งหนี้ (bill) number is allocated at issue and the §86/4 tax receipt
 *     (RC §87 number) is minted only at payment; under the legacy flow the §87
 *     sequential number is consumed at issue. Either way, correcting the
 *     document requires a void.
 *   - AlertDialog forces explicit acknowledgement (Cancel + Continue
 *     are prominent, ESC/overlay click maps to Cancel).
 *
 * 088 T017a / FR-027 — pre-issue review/confirm. When the tax-at-payment flag
 * is ON, the dialog body is a REVIEW that consolidates the consequential §86/4
 * fields (buyer + Head-Office/Branch line, VAT treatment — prominent at 0%,
 * cert no/date, totals, the SC bill-number stream, WHT-note presence) plus an
 * explicit acknowledgement that issue pins an immutable snapshot, and raises
 * two non-blocking WARNINGS (no payment path; unset legal_entity_type → no
 * §86/4 branch line). The typed-phrase gate IS the acknowledgement to proceed.
 *
 * a11y:
 *   - `AlertDialogTitle` is the accessible name.
 *   - `AlertDialogDescription` includes the immutable-snapshot acknowledgement.
 *   - Pre-confirm summary + review are inside the dialog body so SR users
 *     receive the numbers + warnings as part of the dialog content.
 */

import { useEffect, useRef, useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { InfoIcon, Loader2Icon, TriangleAlertIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { computeIssueReviewModel } from '../_lib/issue-review';
import { routeIssueError } from './issue-error-routing';

type Props = {
  readonly invoiceId: string;
  /** Pre-confirm summary data — rendered inside the dialog body. */
  readonly summary: {
    readonly memberName: string;
    readonly planDisplayName: string;
    readonly planYear: number;
    readonly subtotalText: string;
    readonly vatText: string;
    readonly vatPercent: string;
    readonly totalText: string;
  };
  /**
   * 066-membership-no-tin — show an informational note that this buyer has no
   * Tax ID. The invoice still issues as a valid §86/4 (name+address), but a
   * VAT-registered buyer cannot claim its input VAT without their TIN on the
   * document (ภาษีซื้อต้องห้าม). Non-blocking — the page computes this only for
   * a MEMBERSHIP draft whose buyer has no tax_id (events route to §105 as-paid
   * and are blocked separately, so the hint never shows for them).
   */
  readonly showNoTaxIdHint?: boolean;

  // --- 088 T017a / FR-027 pre-issue review ---------------------------------
  /**
   * `FEATURE_088_TAX_AT_PAYMENT` (server env). ON → the 088 bill→RC-at-payment
   * flow + the FR-027 review block + 088-flow copy. OFF → legacy §87-at-issue
   * copy + the original confirmation body (no review block).
   */
  readonly taxAtPayment: boolean;
  /**
   * Membership subject → the §86/4 branch-line review + WHT-note row apply
   * (both are membership-scoped). Event drafts skip them.
   */
  readonly isMembership: boolean;
  /**
   * Buyer `legal_entity_type` (F3 members, free-text). Drives the Head-Office/
   * Branch preview + the fail-closed NULL-entity WARNING. Meaningful only for a
   * membership draft (where the page loaded the member).
   */
  readonly legalEntityType: string | null;
  /**
   * Per-invoice VAT treatment pinned at issue (US8). Until the US8 issue-form
   * toggle lands this is `'standard'`; the review renders it prominently when
   * `'zero_rated_80_1_5'` so a 0% sale is never pinned by accident.
   */
  readonly vatTreatment?: 'standard' | 'zero_rated_80_1_5';
  /** MFA §80/1(5) certificate reference (US8) — shown only when zero-rated. */
  readonly zeroRateCert?: { readonly no: string; readonly date: string | null } | null;
  /**
   * Whether the tenant WHT note will print on this (membership) document (US5).
   * `undefined` while the US5 wht_note settings are unbuilt → the row is hidden.
   */
  readonly whtNoteWillPrint?: boolean;
  /**
   * FR-027 WARN(a) — the bill will render with NO payment path (online-pay OFF
   * AND the tenant bank block empty). Composed server-side from F5 online-pay +
   * the US5 bank block; `undefined` while the bank-block half is unbuilt → the
   * warning stays dormant (never a false positive).
   */
  readonly hasNoPaymentPath?: boolean;
  /** Bill-number stream prefix for the review copy (SC). */
  readonly billNumberPrefix?: string;
};

export function IssueInvoiceDialog({
  invoiceId,
  summary,
  showNoTaxIdHint = false,
  taxAtPayment,
  isMembership,
  legalEntityType,
  vatTreatment = 'standard',
  zeroRateCert = null,
  whtNoteWillPrint,
  hasNoPaymentPath,
  billNumberPrefix = 'SC',
}: Props) {
  const t = useTranslations('admin.invoices.issue');
  const tDetail = useTranslations('admin.invoices.detail');
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [pending, startTransition] = useTransition();

  // 088 T021a / FR-032 — issuing pins an immutable §86/4 snapshot, so a failure
  // is surfaced INLINE via a focused role="alert" (never a transient toast); a
  // concurrent 409 (already issued elsewhere) shows an inline "refresh" prompt.
  const [formError, setFormError] = useState<
    { readonly kind: 'concurrent' } | { readonly kind: 'failure'; readonly message: string } | null
  >(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (formError) errorRef.current?.focus();
  }, [formError]);

  const confirmPhrase = t('confirmPhrase');
  const matches =
    typed.trim().toLocaleUpperCase(locale) ===
    confirmPhrase.toLocaleUpperCase(locale);

  // FR-027 review model — branch-line preview + non-blocking warnings, computed
  // only under the 088 flow. The §86/4 branch line + WARN(b) are membership-
  // scoped (event buyers have no branch concept), so for an event draft we feed
  // `'individual'` — it suppresses the branch line + WARN(b) while leaving the
  // payment-path WARN(a) intact (that is not membership-specific). The branch
  // `<div>` itself is `isMembership`-gated below.
  const review = taxAtPayment
    ? computeIssueReviewModel({
        legalEntityType: isMembership ? legalEntityType : 'individual',
        ...(hasNoPaymentPath !== undefined ? { hasNoPaymentPath } : {}),
      })
    : null;
  const isZeroRated = vatTreatment === 'zero_rated_80_1_5';

  // Reset transient state whenever dialog closes — prevents a stale
  // typed value from leaking into a later re-open (same pattern as
  // F3 archive-member-button R006).
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      setTyped('');
      setFormError(null);
    }
    setOpen(next);
  }, []);

  function confirm() {
    setFormError(null);
    startTransition(async () => {
      const res = await fetch(`/api/invoices/${invoiceId}/issue`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = (body as { error?: { code?: string } })?.error?.code;
        // FR-032 — route the irreversible issue failure to an INLINE focused
        // role="alert" (the dialog stays open); a concurrent 409 shows the
        // "already issued — refresh" prompt. The dedicated no-TIN-event +
        // refunded-registration copies still resolve via routeIssueError.
        const routing = routeIssueError(code);
        if (routing.kind === 'concurrent') {
          setFormError({ kind: 'concurrent' });
        } else {
          const message =
            routing.messageKey === 'errors.codeFallback' && routing.codeArg
              ? t('errors.codeFallback', { code: routing.codeArg })
              : t(routing.messageKey as 'errors.unknown');
          setFormError({ kind: 'failure', message });
        }
        return;
      }
      // FR-032 — doc-specific success toast interpolating the allocated bill
      // number (non-§87 SC under the 088 flow; the legacy §87 document number
      // when the flag is off). Falls back to the plain copy if absent.
      const body = (await res.json().catch(() => ({}))) as {
        bill_document_number_raw?: string | null;
        document_number?: string | null;
      };
      const number =
        (typeof body.bill_document_number_raw === 'string' && body.bill_document_number_raw) ||
        (typeof body.document_number === 'string' && body.document_number) ||
        null;
      toast.success(number ? t('successWithNumber', { number }) : t('success'));
      setOpen(false);
      setTyped('');
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger className={buttonVariants({ variant: 'default' })}>
        {tDetail('actions.issue')}
      </AlertDialogTrigger>
      <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {taxAtPayment ? t('review.immutableSnapshotAck') : t('irreversibleWarning')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Pre-confirm summary — inside dialog body so SR narrates
            these numbers as part of the dialog content (not after
            closing). */}
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{tDetail('fields.memberId')}</dt>
            <dd className="font-medium">{summary.memberName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{tDetail('fields.plan')}</dt>
            <dd className="font-medium">
              {summary.planDisplayName}
              <span className="ml-1 text-xs text-muted-foreground">
                / {summary.planYear}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{tDetail('fields.subtotal')}</dt>
            <dd className="tabular-nums">{summary.subtotalText} THB</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              {tDetail('fields.vat')}
              {summary.vatPercent && (
                <span className="ml-1 text-xs">({summary.vatPercent})</span>
              )}
            </dt>
            <dd className="tabular-nums">{summary.vatText} THB</dd>
          </div>
          <div className="col-span-2 border-t pt-2">
            <dt className="text-muted-foreground">{tDetail('fields.total')}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {summary.totalText} THB
            </dd>
          </div>
        </dl>

        {/* 088 FR-027 — pre-issue review of the §86/4 particulars that will be
            pinned. Rendered only under the tax-at-payment flow. */}
        {taxAtPayment && review && (
          <section
            aria-labelledby="issue-review-heading"
            className="grid gap-3 rounded-md border bg-muted/30 p-3 text-sm"
          >
            <h3 id="issue-review-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('review.heading')}
            </h3>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {isMembership && (
                <div>
                  <dt className="text-muted-foreground">{t('review.fields.branchLine')}</dt>
                  <dd className="font-medium">
                    {review.branchLine.kind === 'head_office'
                      ? t('review.branchLine.headOffice')
                      : review.branchLine.reason === 'individual'
                        ? t('review.branchLine.noneIndividual')
                        : t('review.branchLine.noneUnset')}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-muted-foreground">{t('review.fields.vatTreatment')}</dt>
                <dd>
                  {isZeroRated ? (
                    // Prominent text-badge (not colour-only) so a 0% sale is
                    // never pinned by accident — WCAG 1.4.1.
                    <Badge variant="destructive" className="font-semibold">
                      {t('review.vatTreatmentValue.zeroRated')}
                    </Badge>
                  ) : (
                    <span className="font-medium">{t('review.vatTreatmentValue.standard')}</span>
                  )}
                </dd>
              </div>
              {isZeroRated && zeroRateCert && (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">{t('review.fields.cert')}</dt>
                  <dd className="font-medium">
                    {zeroRateCert.no}
                    {zeroRateCert.date ? ` · ${zeroRateCert.date}` : ''}
                  </dd>
                </div>
              )}
              {isMembership && whtNoteWillPrint !== undefined && (
                <div>
                  <dt className="text-muted-foreground">{t('review.fields.whtNote')}</dt>
                  <dd className="font-medium">
                    {whtNoteWillPrint
                      ? t('review.whtNoteValue.willPrint')
                      : t('review.whtNoteValue.none')}
                  </dd>
                </div>
              )}
            </dl>
            <p className="text-xs text-muted-foreground">
              {t('review.billStreamNote', { prefix: billNumberPrefix })}
            </p>

            {/* FR-027 non-blocking warnings (acknowledge-to-proceed via the
                typed-phrase gate below). */}
            {review.warnings.length > 0 && (
              <div className="grid gap-2">
                {review.warnings.includes('no_payment_path') && (
                  <Alert
                    role="status"
                    className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
                  >
                    <TriangleAlertIcon className="size-4" aria-hidden="true" />
                    <AlertDescription className="text-amber-900 dark:text-amber-200">
                      {t('review.warnings.noPaymentPath')}
                    </AlertDescription>
                  </Alert>
                )}
                {review.warnings.includes('no_branch_line_null_entity_type') && (
                  <Alert
                    role="status"
                    className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
                  >
                    <TriangleAlertIcon className="size-4" aria-hidden="true" />
                    <AlertDescription className="text-amber-900 dark:text-amber-200">
                      {t('review.warnings.nullEntityType')}
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}
          </section>
        )}

        {showNoTaxIdHint && (
          <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
            <InfoIcon className="size-4" aria-hidden="true" />
            <AlertDescription className="text-amber-900 dark:text-amber-200">
              {t('noTaxIdHint')}
            </AlertDescription>
          </Alert>
        )}

        {/* FR-032 — inline, focused failure surface for the irreversible issue
            mutation (never a transient toast). A concurrent 409 shows a
            "refresh" prompt; other failures show a destructive alert. */}
        {formError && (
          <Alert
            ref={errorRef}
            tabIndex={-1}
            variant={formError.kind === 'failure' ? 'destructive' : 'default'}
            className="outline-none"
            data-testid="issue-invoice-error"
          >
            <TriangleAlertIcon className="size-4" aria-hidden="true" />
            {formError.kind === 'concurrent' ? (
              <AlertDescription className="flex flex-col items-start gap-2">
                <span>{t('errors.concurrent')}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-[44px]"
                  onClick={() => router.refresh()}
                >
                  {t('errors.refreshAction')}
                </Button>
              </AlertDescription>
            ) : (
              <AlertDescription>{formError.message}</AlertDescription>
            )}
          </Alert>
        )}

        <div className="grid gap-2">
          <Label htmlFor="issue-confirm">
            {t('confirmCopy', { phrase: confirmPhrase })}
          </Label>
          <Input
            id="issue-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={confirmPhrase}
            autoComplete="off"
            // R7-S9 — prevent iOS from auto-correcting the typed
            // phrase (would silently mangle the exact-match check)
            // and give Android a "Done" keyboard action on commit.
            inputMode="text"
            enterKeyHint="done"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={typed.length > 0 && !matches}
            aria-describedby={
              typed.length > 0 && !matches ? 'issue-confirm-error' : undefined
            }
          />
          {typed.length > 0 && !matches && (
            <p
              id="issue-confirm-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {t('confirmMismatch', { phrase: confirmPhrase })}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              confirm();
            }}
            disabled={!matches || pending}
            aria-busy={pending}
          >
            {pending && (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            )}
            {pending ? t('issuing') : t('issueButton')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
