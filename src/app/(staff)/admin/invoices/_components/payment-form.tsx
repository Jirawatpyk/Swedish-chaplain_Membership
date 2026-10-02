/**
 * T066 — Payment form (F4 US2).
 */
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button, Select, TextField, Textarea } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { routeRecordPaymentError } from './record-payment-error-routing';

const METHODS = ['bank_transfer', 'cheque', 'cash', 'other'] as const;

export function PaymentForm({
  invoiceId,
  documentNumber,
  issueDate,
  todayIso,
  onSuccess,
  onCancel,
  onPendingChange,
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
  /**
   * Spec 122 US8 (T809) — tells the dialog wrapper a payment is in flight,
   * so it can refuse Escape and the scrim until the POST settles (an error
   * must land in a mounted form, and a stray tap must not drop what was typed).
   */
  onPendingChange?: (pending: boolean) => void;
}) {
  const t = useTranslations('admin.invoices.pay');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);
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
      className="flex flex-col gap-[var(--aura-space-4)]"
    >
      {/* 088 FR-028/FR-032 — inline, focused failure surface for the §87-mint
          mutation (never a transient toast). `tabIndex={-1}` + the focus effect
          move focus here so the admin cannot miss that the mint did not
          complete. `outline-none` because focus is programmatic (the visible
          state IS the alert). */}
      {formError && (
        <Alert
          ref={errorRef}
          tabIndex={-1}
          // A stale-write 409 is not the admin's error → info, not danger.
          tone={formError.kind === 'failure' ? 'danger' : 'info'}
          role="alert"
          className="outline-none"
          data-testid="record-payment-error"
          action={
            formError.kind === 'concurrent' ? (
              <Button type="button" variant="secondary" size="sm" touchHeight onClick={() => router.refresh()}>
                {t('errors.refreshAction')}
              </Button>
            ) : undefined
          }
        >
          {formError.kind === 'concurrent' ? t('errors.concurrent') : formError.message}
        </Alert>
      )}
      <Select
        id="method"
        label={t('fields.method')}
        value={paymentMethod}
        onChange={(e) => setPaymentMethod(e.target.value as (typeof METHODS)[number])}
        options={METHODS.map((m) => ({ value: m, label: t(`methods.${m}`) }))}
      />
      <TextField
        id="reference"
        label={t('fields.reference')}
        value={paymentReference}
        onChange={(e) => setPaymentReference(e.target.value)}
        placeholder={t('fields.referencePlaceholder')}
      />
      {/* The CE hint, replaced by the range error after a failed submit;
          AURA points the input's aria-describedby at whichever shows, and
          focus moves here on an invalid submit so it is read on arrival. */}
      <TextField
        ref={dateInputRef}
        id="date"
        type="date"
        label={t('fields.date')}
        value={paymentDate}
        onChange={(e) => setPaymentDate(e.target.value)}
        required
        {...(issueDate ? { min: issueDate } : {})}
        {...(todayIso ? { max: todayIso } : {})}
        hint={t('fields.dateHint')}
        error={dateErrorText ?? undefined}
      />
      <Textarea
        id="notes"
        label={t('fields.notes')}
        value={paymentNotes}
        onChange={(e) => setPaymentNotes(e.target.value)}
        rows={3}
      />
      <div className="flex flex-wrap justify-end gap-[var(--aura-space-2)] max-sm:[&>*]:flex-1">
        {onCancel && (
          <Button type="button" variant="secondary" touchHeight onClick={onCancel} disabled={pending}>
            {t('cancelDialog')}
          </Button>
        )}
        <Button type="submit" variant="primary" touchHeight loading={pending}>
          {pending ? t('submitting') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
