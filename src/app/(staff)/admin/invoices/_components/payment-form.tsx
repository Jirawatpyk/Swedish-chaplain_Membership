/**
 * T066 — Payment form (F4 US2).
 */
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { InlineAlert, InlineAlertDescription } from '@/components/ui/inline-alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2Icon, TriangleAlertIcon } from 'lucide-react';
import { routeRecordPaymentError } from './record-payment-error-routing';

const METHODS = ['bank_transfer', 'cheque', 'cash', 'other'] as const;

export function PaymentForm({
  invoiceId,
  documentNumber,
  issueDate,
  todayIso,
  onSuccess,
  onCancel,
}: {
  invoiceId: string;
  documentNumber: string | null;
  /**
   * The invoice's `issue_date` (YYYY-MM-DD) — used as the lower bound
   * for the payment-date picker. Payments cannot pre-date the
   * issuance of the tax document (§87 temporal consistency).
   */
  issueDate: string | null;
  /**
   * "Today" as a YYYY-MM-DD date in the TENANT timezone (Asia/Bangkok),
   * computed server-side via `bangkokLocalDate(...)` — the SAME helper
   * that stamps `issue_date`. Used as both the default payment date and
   * the upper bound of the date picker.
   *
   * MUST NOT be derived on the client from `new Date()`: that yields the
   * UTC date, which lags the Bangkok date by one during 17:00–23:59 UTC
   * (= 00:00–06:59 Asia/Bangkok). When it lags, an invoice issued that
   * Bangkok-day has `issue_date` (Bangkok) > `max` (UTC) → `min > max`
   * → the native date input has no satisfiable value and the form
   * silently refuses to submit (manual payment recording impossible for
   * ~7h/day). Threading the server's Bangkok-local today keeps
   * `min ≤ max` for same-day-issued invoices.
   */
  todayIso: string;
  /**
   * Optional callback fired after a successful submit. Used by the
   * RecordPaymentDialog wrapper to close the overlay before the
   * router refresh lands. When absent (legacy full-page callers) we
   * fall back to the previous navigate-and-refresh behaviour.
   */
  onSuccess?: () => void;
  /**
   * F5R1-UX5 — optional cancel callback for the RecordPaymentDialog
   * overlay. When provided, renders a Cancel button next to Submit
   * (financial-action heuristic: every form modifying money state
   * should offer an explicit Cancel affordance, not rely solely on
   * Esc / outside-click). Legacy full-page callers omit it.
   */
  onCancel?: () => void;
}) {
  const t = useTranslations('admin.invoices.pay');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [paymentMethod, setPaymentMethod] = useState<(typeof METHODS)[number]>('bank_transfer');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  // Default to the tenant-timezone "today" supplied by the server. No
  // client `new Date()` seeding — that produced the UTC-vs-Bangkok
  // off-by-one date-clamp bug (see the `todayIso` prop doc). The server
  // value is identical on SSR + CSR, so there is no hydration mismatch.
  const [paymentDate, setPaymentDate] = useState(todayIso);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const dateInputRef = useRef<HTMLInputElement>(null);

  // 088 T018a / FR-028 + FR-032 — recording a payment MINTS the §87 `RC` tax
  // number in-tx and cannot be rolled back client-side, so a failure MUST NOT
  // be a transient toast: it is surfaced INLINE via a focused role="alert" so
  // the admin cannot miss that the mint did not complete. A concurrent 409 is
  // shown as an inline "already paid — refresh", not a red error.
  const [formError, setFormError] = useState<
    { readonly kind: 'concurrent' } | { readonly kind: 'failure'; readonly message: string } | null
  >(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (formError) errorRef.current?.focus();
  }, [formError]);

  // App-controlled validation of the payment date — mirrors the native
  // [issueDate, todayIso] clamp but surfaces an inline error + aria-invalid
  // instead of relying solely on the browser's transient native bubble
  // (which `noValidate` on the form suppresses). Shown only after a submit
  // attempt to avoid nagging while the admin is still typing.
  const dateInvalid =
    paymentDate === '' ||
    (issueDate !== null && paymentDate < issueDate) ||
    paymentDate > todayIso;
  const showDateError = submitAttempted && dateInvalid;
  const dateErrorText = showDateError
    ? t('errors.dateRange', { min: issueDate ?? todayIso, max: todayIso })
    : null;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitAttempted(true);
    setFormError(null);
    if (dateInvalid) {
      dateInputRef.current?.focus();
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/invoices/${invoiceId}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentMethod,
          paymentReference: paymentReference.trim() || undefined,
          paymentNotes: paymentNotes.trim() || undefined,
          paymentDate,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = (body as { error?: { code?: string } })?.error?.code;
        // FR-028/FR-032 — irreversible §87-mint failure → INLINE focused
        // role="alert" (never a transient toast); a concurrent 409 →
        // inline "already paid — refresh". The dialog stays open (no
        // optimistic close) so the admin sees the outcome in context.
        const routing = routeRecordPaymentError(code);
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
      // FR-032 — doc-specific success toast: under the 088 flow the payment
      // mints the §86/4 RC receipt number, so prefer "Tax receipt RC-… issued"
      // (read from the response); fall back to the legacy "paid" copy otherwise.
      const body = (await res.json().catch(() => ({}))) as {
        receipt_document_number_raw?: string | null;
        // Cluster 5 (Finding 1) — auto-email dispatch outcome.
        email_dispatch?: string;
      };
      const rc =
        typeof body.receipt_document_number_raw === 'string' && body.receipt_document_number_raw
          ? body.receipt_document_number_raw
          : null;
      // Cluster 5 (Finding 1) — the receipt was NOT emailed because the member
      // has no contact email on file. The payment still SUCCEEDED; append a
      // non-blocking warning line so the admin knows to deliver it manually.
      const noEmailWarning =
        body.email_dispatch === 'skipped_no_email' ? t('successNoEmailWarning') : null;
      if (rc) {
        toast.success(
          t('successReceipt', { number: rc }),
          noEmailWarning ? { description: noEmailWarning } : undefined,
        );
      } else {
        const detail = documentNumber ? t('successDetail', { number: documentNumber }) : null;
        const description = [detail, noEmailWarning].filter(Boolean).join(' ') || undefined;
        toast.success(t('success'), description ? { description } : undefined);
      }
      if (onSuccess) {
        // Dialog overlay wrapper — close first, then refresh so the
        // detail page rerender lands with the dialog already gone.
        onSuccess();
        router.refresh();
      } else {
        // Legacy full-page caller — preserve original behaviour.
        router.push(`/admin/invoices/${invoiceId}`);
        router.refresh();
      }
    });
  }

  return (
    <form
      onSubmit={submit}
      // method="post" — keep invoice/payment data out of the URL on a
      // pre-hydration native submit (CWE-598; see
      // tests/unit/components/pii-forms-post-method.test.tsx).
      method="post"
      // App-controlled validation (see `dateInvalid` / inline error below)
      // — `noValidate` suppresses the browser's native bubble so the
      // admin gets a single, consistent, screen-reader-friendly message.
      noValidate
      className="flex flex-col gap-[var(--page-section-gap)]"
    >
      {/* 088 FR-028/FR-032 — inline, focused failure surface for the §87-mint
          mutation (never a transient toast). `tabIndex={-1}` + the focus effect
          move focus here so the admin cannot miss that the mint did not
          complete. `outline-none` because focus is programmatic (the visible
          state IS the alert). */}
      {formError && (
        <InlineAlert
          ref={errorRef}
          tabIndex={-1}
          tone={formError.kind === 'failure' ? 'destructive' : 'neutral'}
          className="outline-none"
          data-testid="record-payment-error"
        >
          <TriangleAlertIcon className="size-4" aria-hidden="true" />
          {formError.kind === 'concurrent' ? (
            <InlineAlertDescription className="flex flex-col items-start gap-2">
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
            </InlineAlertDescription>
          ) : (
            <InlineAlertDescription>{formError.message}</InlineAlertDescription>
          )}
        </InlineAlert>
      )}
      <div>
        <Label htmlFor="method">{t('fields.method')}</Label>
        <Select
          value={paymentMethod}
          onValueChange={(v) => v && setPaymentMethod(v as (typeof METHODS)[number])}
        >
          <SelectTrigger id="method" className="w-full" aria-label={t('fields.method')}>
            <TranslatedSelectValue
              placeholder={t('fields.method')}
              translate={(v) => (v ? t(`methods.${v}`) : null)}
            />
          </SelectTrigger>
          <SelectContent>
            {METHODS.map((m) => (
              <SelectItem key={m} value={m}>
                {t(`methods.${m}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="reference">{t('fields.reference')}</Label>
        <Input
          id="reference"
          value={paymentReference}
          onChange={(e) => setPaymentReference(e.target.value)}
          placeholder={t('fields.referencePlaceholder')}
        />
      </div>
      <div>
        <Label htmlFor="date">{t('fields.date')}</Label>
        <Input
          ref={dateInputRef}
          id="date"
          type="date"
          value={paymentDate}
          onChange={(e) => setPaymentDate(e.target.value)}
          required
          // Clamp [issueDate, today] — prevents typos like 2062-04-19
          // and ensures payment cannot pre-date the tax document
          // (§87 temporal consistency). `min`/`max` still clamp the
          // native date-picker UI even with the form's `noValidate`.
          {...(issueDate ? { min: issueDate } : {})}
          {...(todayIso ? { max: todayIso } : {})}
          aria-invalid={showDateError || undefined}
          aria-describedby={showDateError ? 'date-error date-hint' : 'date-hint'}
        />
        <p id="date-hint" className="mt-1 text-xs text-muted-foreground">
          {t('fields.dateHint')}
        </p>
        {dateErrorText && (
          <p id="date-error" role="alert" className="mt-1 text-xs text-destructive">
            {dateErrorText}
          </p>
        )}
      </div>
      <div>
        <Label htmlFor="notes">{t('fields.notes')}</Label>
        <Textarea
          id="notes"
          value={paymentNotes}
          onChange={(e) => setPaymentNotes(e.target.value)}
          rows={3}
        />
      </div>
      <div className="flex justify-end gap-2">
        {onCancel && (
          // F5R2-UX-F2 — `cancel` key copy ("Back to invoice") was
          // written for the now-deleted full-page route. Inside a
          // dialog, `cancelDialog` ("Cancel" / "ยกเลิก" / "Avbryt")
          // is the standard dismiss copy. F5R2-UX-F3 — min-h-[44px]
          // satisfies WCAG 2.5.8 touch-target on mobile.
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px]"
            onClick={onCancel}
            disabled={pending}
          >
            {t('cancelDialog')}
          </Button>
        )}
        <Button
          type="submit"
          className="min-h-[44px]"
          disabled={pending}
          aria-busy={pending}
        >
          {pending && (
            <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          )}
          {pending ? t('submitting') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
