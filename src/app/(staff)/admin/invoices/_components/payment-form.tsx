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

const METHODS = ['bank_transfer', 'cheque', 'cash', 'other'] as const;

export function PaymentForm({
  invoiceId,
  documentNumber,
}: {
  invoiceId: string;
  documentNumber: string | null;
}) {
  const t = useTranslations('admin.invoices.pay');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [paymentMethod, setPaymentMethod] = useState<(typeof METHODS)[number]>('bank_transfer');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  useEffect(() => {
    setPaymentDate(new Date().toISOString().slice(0, 10));
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
      router.push(`/admin/invoices/${invoiceId}`);
      router.refresh();
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
        />
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
        <Button type="submit" disabled={pending}>
          {pending ? t('submitting') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
