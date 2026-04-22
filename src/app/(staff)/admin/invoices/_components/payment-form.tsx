/**
 * T066 — Payment form (F4 US2).
 */
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';

const METHODS = ['bank_transfer', 'cheque', 'cash', 'other'] as const;

export function PaymentForm({
  invoiceId,
  documentNumber,
  issueDate,
  onSuccess,
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
   * Optional callback fired after a successful submit. Used by the
   * RecordPaymentDialog wrapper to close the overlay before the
   * router refresh lands. When absent (legacy full-page callers) we
   * fall back to the previous navigate-and-refresh behaviour.
   */
  onSuccess?: () => void;
}) {
  const t = useTranslations('admin.invoices.pay');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [paymentMethod, setPaymentMethod] = useState<(typeof METHODS)[number]>('bank_transfer');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [todayIso, setTodayIso] = useState('');
  useEffect(() => {
    // Seed with today's date on the client only to avoid SSR/CSR
    // hydration mismatch from `new Date()`. The outer wrapper carries
    // `suppressHydrationWarning`; the setState-on-mount pattern is the
    // documented React 19 pattern for this case.
    const today = new Date().toISOString().slice(0, 10);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPaymentDate(today);
    setTodayIso(today);
  }, []);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
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
        toast.error(t('errors.failed'), {
          description: code ? t('errors.codeFallback', { code }) : t('errors.unknown'),
        });
        return;
      }
      toast.success(t('success'), {
        description: documentNumber ? t('successDetail', { number: documentNumber }) : undefined,
      });
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
      className="flex flex-col gap-[var(--page-section-gap)]"
    >
      <div suppressHydrationWarning>
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
          id="date"
          type="date"
          value={paymentDate}
          onChange={(e) => setPaymentDate(e.target.value)}
          required
          // Clamp [issueDate, today] — prevents typos like 2062-04-19
          // and ensures payment cannot pre-date the tax document
          // (§87 temporal consistency).
          {...(issueDate ? { min: issueDate } : {})}
          {...(todayIso ? { max: todayIso } : {})}
          aria-describedby="date-hint"
        />
        <p id="date-hint" className="mt-1 text-xs text-muted-foreground">
          {t('fields.dateHint')}
        </p>
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
      <div className="flex justify-end">
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending && (
            <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          )}
          {pending ? t('submitting') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
