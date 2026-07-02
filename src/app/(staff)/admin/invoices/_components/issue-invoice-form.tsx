'use client';

/**
 * 088 US8 (UX-A) — issue-invoice dialog BODY.
 *
 * Extracted from `issue-invoice-dialog.tsx` (which is now the thin
 * trigger + open-state shell) so this form renders standalone inside an open
 * `<AlertDialog>`, mirroring the RefundDialog/RefundForm split — that avoids
 * the Base-UI-dialog jsdom transition hang and makes the form RTL-testable.
 *
 * Composes, top-to-bottom:
 *   - the pre-confirm summary (numbers the SR narrates as dialog content);
 *   - 088 US8 the `vat_treatment` control (FR-023): a standard/zero-rate
 *     radio group for a NON-membership sale, or an error-prevention caption
 *     for a membership sale (membership is always VAT 7%). Progressive-
 *     disclosure MFA-certificate fields (no. + date, FR-024) reveal only on
 *     zero-rate, announced via `aria-live`; a blank cert NUMBER blocks submit
 *     BEFORE any POST (fail-closed layer 1). A ≥ 5,000 THB advisory warns
 *     inline (non-blocking);
 *   - 088 FR-027 the review of the §86/4 particulars that will be pinned
 *     (reflecting the admin's LIVE vat/cert choices);
 *   - the immutable-snapshot acknowledgement gate (typed phrase) + footer.
 *
 * The cert SCAN upload (`zeroRateCertBlobKey`), the 422-retry-preserve of a
 * scanned blob, and the TTL sweep are UX-B (T061e / scan-tied T061f) — NOT in
 * this slice. UX-A ships a fully-functional zero-rate flow on cert NUMBER +
 * DATE alone (the NUMBER is the fail-closed gate, FR-024).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { InfoIcon, Loader2Icon, TriangleAlertIcon } from 'lucide-react';
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { computeIssueReviewModel } from '../_lib/issue-review';
import {
  buildIssueRequestBody,
  isZeroRateLowAmount,
  NO_CERT_ERRORS,
  validateZeroRateCert,
  type VatTreatmentChoice,
  type ZeroRateCertErrors,
  CERT_NO_MAX,
} from '../_lib/issue-vat-treatment';
import { routeIssueError } from './issue-error-routing';

export type IssueInvoiceFormProps = {
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
  /** 066 — informational note that a MEMBERSHIP buyer has no Tax ID. */
  readonly showNoTaxIdHint?: boolean;
  /**
   * `FEATURE_088_TAX_AT_PAYMENT` (server env). ON → the FR-027 review block +
   * the US8 `vat_treatment` control. OFF → legacy confirmation body only + an
   * EMPTY POST body (backward compatible).
   */
  readonly taxAtPayment: boolean;
  /** Membership subject → the branch-line review + WHT-note row apply; the
   *  `vat_treatment` control is replaced by the "always VAT 7%" caption. */
  readonly isMembership: boolean;
  /** Buyer `legal_entity_type` (drives the Head-Office/Branch preview). */
  readonly legalEntityType: string | null;
  /** Whether the tenant WHT note will print (US5). `undefined` → row hidden. */
  readonly whtNoteWillPrint?: boolean;
  /** FR-027 WARN(a) — bill will render with NO payment path. */
  readonly hasNoPaymentPath?: boolean;
  /** Bill-number stream prefix for the review copy (SC). */
  readonly billNumberPrefix?: string;
  /**
   * Draft subtotal in SATANG (plain number — a bigint cannot cross the RSC →
   * client-prop boundary). Drives the ≥ 5,000 THB zero-rate advisory. `null`
   * when unknown → the advisory stays dormant.
   */
  readonly subtotalSatang?: number | null;
  /** Close the enclosing dialog (wired by the wrapper to `setOpen(false)`). */
  readonly onClose: () => void;
};

export function IssueInvoiceForm({
  invoiceId,
  summary,
  showNoTaxIdHint = false,
  taxAtPayment,
  isMembership,
  legalEntityType,
  whtNoteWillPrint,
  hasNoPaymentPath,
  billNumberPrefix = 'SC',
  subtotalSatang = null,
  onClose,
}: IssueInvoiceFormProps) {
  const t = useTranslations('admin.invoices.issue');
  const tForm = useTranslations('admin.invoices.issue.form');
  const tDetail = useTranslations('admin.invoices.detail');
  const locale = useLocale();
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const [pending, startTransition] = useTransition();

  // 088 T021a / FR-032 — issue failure surfaces INLINE via a focused
  // role="alert" (never a transient toast); a concurrent 409 shows an inline
  // "already issued — refresh" prompt.
  const [formError, setFormError] = useState<
    | { readonly kind: 'concurrent' }
    | { readonly kind: 'failure'; readonly message: string }
    | null
  >(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (formError) errorRef.current?.focus();
  }, [formError]);

  // 088 US8 (FR-023/024) — the `vat_treatment` control is offered ONLY under
  // the flag AND for a NON-membership sale (membership is always VAT 7%).
  const showVatTreatmentControl = taxAtPayment && !isMembership;
  const [vatTreatment, setVatTreatment] =
    useState<VatTreatmentChoice>('standard');
  const [certNo, setCertNo] = useState('');
  const [certDate, setCertDate] = useState('');
  const [certErrors, setCertErrors] = useState<ZeroRateCertErrors>(NO_CERT_ERRORS);
  const certNoRef = useRef<HTMLInputElement>(null);
  const certDateRef = useRef<HTMLInputElement>(null);

  // Membership can never be zero-rated, so the effective treatment is standard
  // unless the (non-membership) control is present AND set to zero-rate.
  const isZeroRated =
    showVatTreatmentControl && vatTreatment === 'zero_rated_80_1_5';
  const effectiveTreatment: VatTreatmentChoice = isZeroRated
    ? 'zero_rated_80_1_5'
    : 'standard';
  const lowAmountWarn = isZeroRateLowAmount(effectiveTreatment, subtotalSatang);

  const confirmPhrase = t('confirmPhrase');
  const matches =
    typed.trim().toLocaleUpperCase(locale) ===
    confirmPhrase.toLocaleUpperCase(locale);

  // FR-027 review model — branch-line preview + non-blocking warnings.
  const review = taxAtPayment
    ? computeIssueReviewModel({
        legalEntityType: isMembership ? legalEntityType : 'individual',
        ...(hasNoPaymentPath !== undefined ? { hasNoPaymentPath } : {}),
      })
    : null;

  // 088 T061f (reset arm) — flipping treatment AWAY from zero-rate clears the
  // cert fields so no stale certificate carries over (the 422-retry-preserve
  // of a scanned blob is UX-B).
  const handleVatTreatmentChange = useCallback((next: VatTreatmentChoice) => {
    setVatTreatment(next);
    if (next !== 'zero_rated_80_1_5') {
      setCertNo('');
      setCertDate('');
      setCertErrors(NO_CERT_ERRORS);
    }
  }, []);

  function confirm() {
    setFormError(null);
    // 088 T061b/T061g — fail-closed layer 1: block submit BEFORE any POST when
    // a zero-rated issue has a blank cert number (or a malformed date). Move
    // focus to the first invalid field. The server 422 + DB CHECK are layers
    // 2 + 3.
    const errors = validateZeroRateCert({
      vatTreatment: effectiveTreatment,
      certNo,
      certDate,
    });
    if (errors.certNo || errors.certDate) {
      setCertErrors(errors);
      (errors.certNo ? certNoRef : certDateRef).current?.focus();
      return;
    }
    setCertErrors(NO_CERT_ERRORS);

    const body = buildIssueRequestBody({
      taxAtPayment,
      vatTreatment: effectiveTreatment,
      certNo,
      certDate,
    });

    startTransition(async () => {
      const res = await fetch(
        `/api/invoices/${invoiceId}/issue`,
        body
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
          : { method: 'POST' },
      );
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const code = (errBody as { error?: { code?: string } })?.error?.code;
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
      const okBody = (await res.json().catch(() => ({}))) as {
        bill_document_number_raw?: string | null;
        document_number?: string | null;
      };
      const number =
        (typeof okBody.bill_document_number_raw === 'string' &&
          okBody.bill_document_number_raw) ||
        (typeof okBody.document_number === 'string' && okBody.document_number) ||
        null;
      toast.success(number ? t('successWithNumber', { number }) : t('success'));
      setTyped('');
      onClose();
      router.refresh();
    });
  }

  return (
    <>
      {/* Pre-confirm summary — inside dialog body so SR narrates these numbers
          as part of the dialog content. */}
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

      {/* 088 US8 (FR-023) — VAT-treatment control (non-membership) or the
          error-prevention caption (membership). Flag-gated. */}
      {taxAtPayment && showVatTreatmentControl && (
        <fieldset className="grid gap-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">
            {tForm('vatTreatment.label')}
          </legend>
          <p id="vat-treatment-help" className="text-xs text-muted-foreground">
            {tForm('vatTreatment.help')}
          </p>
          <div className="grid gap-1.5 pt-1">
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="radio"
                name="vat-treatment"
                value="standard"
                checked={vatTreatment === 'standard'}
                onChange={() => handleVatTreatmentChange('standard')}
                aria-describedby="vat-treatment-help"
                className="size-4 accent-primary outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              />
              <span>{tForm('vatTreatment.standard')}</span>
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="radio"
                name="vat-treatment"
                value="zero_rated_80_1_5"
                checked={vatTreatment === 'zero_rated_80_1_5'}
                onChange={() => handleVatTreatmentChange('zero_rated_80_1_5')}
                aria-describedby="vat-treatment-help"
                className="size-4 accent-primary outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              />
              <span>{tForm('vatTreatment.zeroRated')}</span>
            </label>
          </div>
        </fieldset>
      )}
      {taxAtPayment && isMembership && (
        <p
          className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground"
          data-testid="vat-treatment-membership-caption"
        >
          {tForm('vatTreatment.membershipCaption')}
        </p>
      )}

      {/* 088 T061c — aria-live announce of the progressive-disclosure reveal. */}
      <div role="status" aria-live="polite" className="sr-only">
        {isZeroRated ? tForm('cert.revealed') : ''}
      </div>

      {/* 088 US8 (FR-024) — MFA-certificate fields, revealed only on zero-rate. */}
      {isZeroRated && (
        <fieldset
          className="grid gap-3 rounded-md border p-3"
          data-testid="zero-rate-cert-fields"
        >
          <legend className="px-1 text-sm font-medium">
            {tForm('cert.legend')}
          </legend>
          <div className="grid gap-1.5">
            <Label htmlFor="zero-rate-cert-no">
              {tForm('cert.noLabel')}
              <span aria-hidden="true" className="ml-0.5 text-destructive">
                *
              </span>
            </Label>
            <Input
              id="zero-rate-cert-no"
              ref={certNoRef}
              value={certNo}
              onChange={(e) => setCertNo(e.target.value)}
              placeholder={tForm('cert.noPlaceholder')}
              // T061g — mobile keyboard hint for the free-text cert number.
              inputMode="text"
              enterKeyHint="next"
              autoComplete="off"
              maxLength={CERT_NO_MAX}
              aria-required="true"
              aria-invalid={certErrors.certNo ? true : undefined}
              aria-describedby={
                certErrors.certNo ? 'zero-rate-cert-no-error' : undefined
              }
            />
            {certErrors.certNo && (
              <p
                id="zero-rate-cert-no-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {tForm('cert.noRequired')}
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="zero-rate-cert-date">{tForm('cert.dateLabel')}</Label>
            <Input
              id="zero-rate-cert-date"
              ref={certDateRef}
              type="date"
              value={certDate}
              onChange={(e) => setCertDate(e.target.value)}
              aria-invalid={certErrors.certDate ? true : undefined}
              aria-describedby={
                certErrors.certDate ? 'zero-rate-cert-date-error' : undefined
              }
            />
            {certErrors.certDate && (
              <p
                id="zero-rate-cert-date-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {tForm('cert.dateFormat')}
              </p>
            )}
          </div>
          {/* 088 T061d — non-blocking ≥ 5,000 THB advisory (WARN, not a block). */}
          {lowAmountWarn && (
            <Alert
              role="status"
              className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
              data-testid="zero-rate-low-amount-warning"
            >
              <TriangleAlertIcon className="size-4" aria-hidden="true" />
              <AlertDescription className="text-amber-900 dark:text-amber-200">
                {tForm('lowAmountWarning')}
              </AlertDescription>
            </Alert>
          )}
        </fieldset>
      )}

      {/* 088 FR-027 — pre-issue review of the §86/4 particulars. */}
      {taxAtPayment && review && (
        <section
          aria-labelledby="issue-review-heading"
          className="grid gap-3 rounded-md border bg-muted/30 p-3 text-sm"
        >
          <h3
            id="issue-review-heading"
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            {t('review.heading')}
          </h3>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {isMembership && (
              <div>
                <dt className="text-muted-foreground">
                  {t('review.fields.branchLine')}
                </dt>
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
              <dt className="text-muted-foreground">
                {t('review.fields.vatTreatment')}
              </dt>
              <dd>
                {isZeroRated ? (
                  // Text-badge (not colour-only) so a 0% sale is never pinned
                  // by accident — WCAG 1.4.1.
                  <Badge variant="destructive" className="font-semibold">
                    {t('review.vatTreatmentValue.zeroRated')}
                  </Badge>
                ) : (
                  <span className="font-medium">
                    {t('review.vatTreatmentValue.standard')}
                  </span>
                )}
              </dd>
            </div>
            {isZeroRated && certNo.trim() !== '' && (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">
                  {t('review.fields.cert')}
                </dt>
                <dd className="font-medium">
                  {certNo.trim()}
                  {certDate.trim() !== '' ? ` · ${certDate.trim()}` : ''}
                </dd>
              </div>
            )}
            {isMembership && whtNoteWillPrint !== undefined && (
              <div>
                <dt className="text-muted-foreground">
                  {t('review.fields.whtNote')}
                </dt>
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
          mutation (never a transient toast). */}
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
        <AlertDialogCancel disabled={pending}>{t('cancel')}</AlertDialogCancel>
        <AlertDialogAction
          onClick={(e) => {
            e.preventDefault();
            confirm();
          }}
          disabled={!matches || pending}
          aria-busy={pending}
        >
          {pending && (
            <Loader2Icon
              className="size-4 motion-safe:animate-spin"
              aria-hidden="true"
            />
          )}
          {pending ? t('issuing') : t('issueButton')}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}
