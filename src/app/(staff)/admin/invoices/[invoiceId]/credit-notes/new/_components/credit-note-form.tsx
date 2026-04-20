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
  const n = BigInt(satang);
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
        toast.error(t('errors.failed'), {
          description: code ? t('errors.codeFallback', { code }) : t('errors.unknown'),
        });
        return;
      }
      toast.success(t('success'));
      router.push(`/admin/invoices/${invoiceId}`);
      router.refresh();
    });
  }, [canSubmit, proposedSatang, invoiceId, reason, t, router]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
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
        <Button type="submit" disabled={!canSubmit}>
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
