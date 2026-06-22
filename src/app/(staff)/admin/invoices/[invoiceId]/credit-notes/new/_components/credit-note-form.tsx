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
import { useMemo, useState, useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';

type Props = {
  readonly invoiceId: string;
  readonly documentNumber: string;
  readonly remainingSatang: string;
  readonly currencySymbol: string;
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
}: Props) {
  const t = useTranslations('admin.creditNotes.new');
  const locale = useLocale();
  const router = useRouter();
  const [amountThb, setAmountThb] = useState('');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [pending, startTransition] = useTransition();

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
  const canSubmit = amountValid && reasonValid && matches && !pending;

  const submit = useCallback(() => {
    if (!canSubmit || proposedSatang === null) return;
    startTransition(async () => {
      const res = await fetch('/api/credit-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceId,
          creditTotalSatang: proposedSatang.toString(),
          reason: reason.trim(),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        const code = body.error?.code;
        // §86/10 ruling (final-review HIGH 1) — a §105 ใบเสร็จรับเงิน
        // (receipt_separate) cannot be credited. Surface the actionable
        // guidance (refund / void) rather than a bare error code.
        const description =
          code === 'receipt_not_creditable'
            ? t('errors.receiptNotCreditable')
            : code
              ? t('errors.codeFallback', { code })
              : t('errors.unknown');
        toast.error(t('errors.failed'), { description });
        return;
      }
      // MEDIUM-5 — read the email-delivery signal so the admin gets a
      // non-blocking notice when the buyer has no email on file (the CN is
      // still fully issued; only the auto-email was skipped). `sent` /
      // `not_requested` / absent → plain success toast (nothing went wrong).
      const successBody = (await res.json().catch(() => ({}))) as {
        email_delivery?: string;
      };
      if (successBody.email_delivery === 'skipped_no_recipient') {
        toast.success(t('success'), {
          description: t('emailSkippedNoRecipient'),
        });
      } else {
        toast.success(t('success'));
      }
      // Destination page (`/admin/invoices/[id]`) is a server component
      // that fetches fresh on mount; `router.refresh()` here would
      // invalidate the abandoned form route, not the target. Drop it.
      router.push(`/admin/invoices/${invoiceId}`);
    });
  }, [canSubmit, proposedSatang, invoiceId, reason, t, router]);

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
