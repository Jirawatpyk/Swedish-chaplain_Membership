'use client';

/**
 * T080 — Issue Credit Note client form (F4 / US6).
 *
 * FR-040 — typed-phrase confirmation ("CREDIT" since the credit-note
 * document number is ONLY known post-commit). Same locale-case-insensitive
 * compare as `issue-invoice-dialog.tsx` / `archive-member-button`.
 *
 * UX:
 *  - Amount input in THB (decimal), converted to satang on submit.
 *  - Reason textarea (required, 1-500 char).
 *  - Remainder display: shows how much of the invoice total is still
 *    creditable (invoice.total − invoice.credited_total).
 *  - Typed-phrase confirmation before the Submit button enables.
 *  - Post-commit: toast + router.refresh() + navigate to invoice detail.
 */
import { useEffect, useMemo, useRef, useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2Icon, TriangleAlertIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { routeCreditNoteError } from './credit-note-error-routing';

/** F-2 (2026-07-08) — membership-effect intent, mirrors the use-case's enum. */
type MembershipEffect = 'keep' | 'cancel_membership';

type Props = {
  readonly invoiceId: string;
  readonly documentNumber: string;
  readonly remainingSatang: string;
  readonly currencySymbol: string;
  /**
   * F-2 (2026-07-08) — the membership-effect radio only ever shows for a
   * `'membership'` invoice whose credited amount fully credits it; an
   * `'event'` invoice never asks.
   */
  readonly invoiceSubject: 'membership' | 'event';
};

function formatSatang(satang: string): string {
  // SG-1 — clamp negatives to 0 defensively. Under normal state the
  // remainder is always ≥ 0 (DB CHECK `invoices_credited_total_in_range`
  // enforces it), but a stale-server-render race mid-rollup could
  // momentarily surface a negative value. Showing "0.00" reads
  // cleaner than "-0.-01" and matches the enforce policy's own
  // `remainingSatang < 0n ? 0n` clamp.
  const raw = BigInt(satang);
  const n = raw < 0n ? 0n : raw;
  const whole = n / 100n;
  const rem = n % 100n;
  return `${whole.toString()}.${rem.toString().padStart(2, '0')}`;
}

export function CreditNoteForm({
  invoiceId,
  documentNumber,
  remainingSatang,
  currencySymbol,
  invoiceSubject,
}: Props) {
  const t = useTranslations('admin.creditNotes.new');
  const locale = useLocale();
  const router = useRouter();
  const [amountThb, setAmountThb] = useState('');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  // F-2 (2026-07-08) — default 'keep' per the design doc; only read/sent when
  // `showMembershipEffect` is true (see below).
  const [membershipEffect, setMembershipEffect] = useState<MembershipEffect>('keep');
  const [pending, startTransition] = useTransition();

  // 088 T021a / FR-032 — issuing a credit note MINTS a §87 tax-document number
  // in-tx and moves the invoice to credited; it cannot be rolled back
  // client-side, so a failure MUST NOT be a transient toast: it is surfaced
  // INLINE via a focused role="alert" so the admin cannot miss it. A concurrent
  // 409 is shown as an inline "already credited/voided — refresh".
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

  const proposedSatang = useMemo(() => {
    if (!amountThb.trim()) return null;
    // THB decimal → satang. Enforce half-away-from-zero via toFixed(2).
    const n = Number(amountThb);
    if (!Number.isFinite(n) || n <= 0) return null;
    const [intPart, fracPartRaw = '00'] = n.toFixed(2).split('.');
    const fracPadded = (fracPartRaw + '00').slice(0, 2);
    return BigInt(intPart!) * 100n + BigInt(fracPadded);
  }, [amountThb]);

  const remainingBi = BigInt(remainingSatang);
  const exceedsRemainder =
    proposedSatang !== null && proposedSatang > remainingBi;

  const amountValid =
    proposedSatang !== null && proposedSatang > 0n && !exceedsRemainder;
  const reasonValid = reason.trim().length > 0 && reason.trim().length <= 500;
  // F-2 (2026-07-08) — a FULL credit is exactly the remainder (the
  // `exceedsRemainder` check above already blocks anything greater).
  // Mirrors the use-case's own `isFullCredit` derivation server-side.
  const isFullCredit = proposedSatang !== null && proposedSatang === remainingBi;
  const showMembershipEffect = invoiceSubject === 'membership' && isFullCredit;
  const canSubmit = amountValid && reasonValid && matches && !pending;

  const submit = useCallback(() => {
    if (!canSubmit || proposedSatang === null) return;
    setFormError(null);
    startTransition(async () => {
      const res = await fetch('/api/credit-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceId,
          creditTotalSatang: proposedSatang.toString(),
          reason: reason.trim(),
          // F-2 — only sent when the radio is actually shown; partial
          // credits and event invoices never touch membership, so the
          // field is omitted rather than sent-but-ignored.
          ...(showMembershipEffect ? { membershipEffect } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        const code = body.error?.code;
        // FR-032 — the credit-note mint is irreversible, so route the failure to
        // an INLINE focused role="alert" (the form stays put); a concurrent 409
        // (voided / fully-credited / remainder-shrank) shows the "already
        // credited/voided — refresh" prompt. The §86/10 receipt_not_creditable
        // guidance still resolves via routeCreditNoteError.
        const routing = routeCreditNoteError(code);
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
      // FR-032 — doc-specific success toast interpolating the freshly-minted
      // credit-note number (`document_number`, known only post-commit).
      // MEDIUM-5 — the email-delivery signal rides alongside: a
      // `skipped_no_recipient` value means the CN is still fully issued but the
      // buyer has no email on file, so the auto-email was skipped (non-blocking
      // description). F-2 — `membership_cancellation_failed` is the same kind
      // of non-blocking signal for a requested-but-failed F8 cascade. All
      // fields come from ONE parse of the success body.
      const successBody = (await res.json().catch(() => ({}))) as {
        document_number?: string | null;
        email_delivery?: string;
        membership_cancellation_failed?: boolean;
      };
      const cnNumber =
        typeof successBody.document_number === 'string' && successBody.document_number
          ? successBody.document_number
          : null;
      const title = cnNumber ? t('successWithNumber', { number: cnNumber }) : t('success');
      const noticeParts: string[] = [];
      if (successBody.email_delivery === 'skipped_no_recipient') {
        noticeParts.push(t('emailSkippedNoRecipient'));
      }
      if (successBody.membership_cancellation_failed === true) {
        noticeParts.push(t('membershipCancellationFailedNotice'));
      }
      if (noticeParts.length > 0) {
        toast.success(title, { description: noticeParts.join(' ') });
      } else {
        toast.success(title);
      }
      // Destination page (`/admin/invoices/[id]`) is a server component
      // that fetches fresh on mount; `router.refresh()` here would
      // invalidate the abandoned form route, not the target. Drop it.
      router.push(`/admin/invoices/${invoiceId}`);
    });
  }, [
    canSubmit,
    proposedSatang,
    invoiceId,
    reason,
    t,
    router,
    showMembershipEffect,
    membershipEffect,
  ]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      // method="post" — CWE-598; see tests/unit/components/pii-forms-post-method.test.tsx
      method="post"
      className="flex flex-col gap-6"
    >
      {/* 088 FR-032 — inline, focused failure surface for the irreversible §87
          credit-note mint (never a transient toast). `tabIndex={-1}` + the focus
          effect move focus here so the admin cannot miss it. A concurrent 409
          shows a "refresh" prompt; other failures show a destructive alert. */}
      {formError && (
        <Alert
          ref={errorRef}
          tabIndex={-1}
          variant={formError.kind === 'failure' ? 'destructive' : 'default'}
          className="outline-none"
          data-testid="credit-note-error"
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
      <div className="rounded-md border bg-muted/40 p-3 text-sm">
        <p className="text-muted-foreground">
          {t('againstInvoice')}{' '}
          <span className="font-mono font-medium text-foreground">
            {documentNumber}
          </span>
        </p>
        <p className="mt-1">
          {t('remainingLabel')}{' '}
          <span className="font-medium tabular-nums">
            {formatSatang(remainingSatang)} {currencySymbol}
          </span>
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="cn-amount">{t('amountLabel')}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="cn-amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={amountThb}
            onChange={(e) => setAmountThb(e.target.value)}
            required
            aria-describedby="cn-amount-help"
            aria-invalid={exceedsRemainder || (amountThb.length > 0 && !amountValid)}
          />
          <span className="text-sm text-muted-foreground">{currencySymbol}</span>
        </div>
        <p id="cn-amount-help" className="text-xs text-muted-foreground">
          {t('amountHelp')}
        </p>
        {exceedsRemainder && (
          <p role="alert" className="text-xs text-destructive">
            {t('exceedsRemainder', {
              remaining: `${formatSatang(remainingSatang)} ${currencySymbol}`,
            })}
          </p>
        )}
      </div>

      {/* F-2 (2026-07-08) — mandatory intent capture, shown ONLY for a full
          credit on a membership invoice (partial credits + event invoices
          never touch membership). Defaults to 'keep', so the field is
          NEVER actually "missing" a value — `required`/`aria-required` is
          deliberately OMITTED: Base UI's hidden native radio inputs carry
          no shared `name` attribute, so a `required` unchecked sibling
          blocks native HTML5 form submission entirely (a real cross-
          browser bug, not just a jsdom quirk — verified by an RTL
          submit-never-fires regression during development). Fieldset +
          legend alone give the group an accessible name (WCAG) — that is
          sufficient since a valid selection always exists. */}
      {showMembershipEffect && (
        <fieldset
          className="flex flex-col gap-2 rounded-md border p-3"
          data-testid="cn-membership-effect-fieldset"
        >
          <legend className="mb-1 text-sm font-medium">
            {t('membershipEffect.legend')}
          </legend>
          <RadioGroup
            value={membershipEffect}
            onValueChange={(v) =>
              setMembershipEffect(v === 'cancel_membership' ? 'cancel_membership' : 'keep')
            }
            className="gap-3"
          >
            <div className="flex items-start gap-2 rounded-md border p-3">
              <RadioGroupItem
                id="cn-membership-effect-keep"
                value="keep"
                className="mt-0.5"
                aria-labelledby="cn-membership-effect-keep-label"
              />
              <Label
                htmlFor="cn-membership-effect-keep"
                className="flex cursor-pointer flex-col gap-0.5"
              >
                <span id="cn-membership-effect-keep-label" className="font-medium">
                  {t('membershipEffect.keep.label')}
                </span>
              </Label>
            </div>
            <div className="flex items-start gap-2 rounded-md border p-3">
              <RadioGroupItem
                id="cn-membership-effect-cancel"
                value="cancel_membership"
                className="mt-0.5"
                aria-labelledby="cn-membership-effect-cancel-label"
              />
              <Label
                htmlFor="cn-membership-effect-cancel"
                className="flex cursor-pointer flex-col gap-0.5"
              >
                {/* Warning-styled — this option triggers an F8 cascade that
                    cancels the member's in-flight renewal cycles. */}
                <span
                  id="cn-membership-effect-cancel-label"
                  className="font-medium text-amber-900 dark:text-amber-200"
                >
                  {t('membershipEffect.cancelMembership.label')}
                </span>
              </Label>
            </div>
          </RadioGroup>
        </fieldset>
      )}

      <div className="grid gap-2">
        <Label htmlFor="cn-reason">{t('reasonLabel')}</Label>
        <Textarea
          id="cn-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={500}
          required
          aria-describedby="cn-reason-help"
          // W1-10 (a11y): surface validity to AT like the amount/confirm fields.
          aria-invalid={reason.length > 0 && !reasonValid}
        />
        <p id="cn-reason-help" className="text-xs text-muted-foreground">
          {t('reasonHelp')} ({reason.length}/500)
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="cn-confirm">
          {t('confirmCopy', { phrase: confirmPhrase })}
        </Label>
        <Input
          id="cn-confirm"
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
            typed.length > 0 && !matches ? 'cn-confirm-error' : undefined
          }
        />
        {typed.length > 0 && !matches && (
          <p id="cn-confirm-error" role="alert" className="text-xs text-destructive">
            {t('confirmMismatch', { phrase: confirmPhrase })}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!canSubmit} aria-busy={pending}>
          {pending && (
            <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          )}
          {pending ? t('submitting') : t('submit')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push(`/admin/invoices/${invoiceId}`)}
          disabled={pending}
        >
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}
