/**
 * T058 — Issue-confirm dialog (F4 FR-040).
 *
 * Typed-phrase confirmation — the admin must type "ISSUE" before the
 * Issue button enables. When the document_number is known at
 * confirmation time (rare — seq is only allocated on commit) the
 * typed phrase would be the document number; for MVP we use "ISSUE".
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

const CONFIRM_PHRASE = 'ISSUE';

export function IssueConfirmDialog({ invoiceId }: { invoiceId: string }) {
  const t = useTranslations('admin.invoices.issue');
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const [pending, startTransition] = useTransition();
  const matches = typed.trim().toUpperCase() === CONFIRM_PHRASE;

  function issue() {
    startTransition(async () => {
      const res = await fetch(`/api/invoices/${invoiceId}/issue`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(t('errors.failed'), {
          description: String((body as { error?: { code?: string } })?.error?.code ?? res.status),
        });
        return;
      }
      toast.success(t('success'));
      router.push(`/admin/invoices/${invoiceId}`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">
        {t('confirmCopy', { phrase: CONFIRM_PHRASE })}
      </p>
      <div>
        <Label htmlFor="confirm">{t('typeToConfirm')}</Label>
        <Input
          id="confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={CONFIRM_PHRASE}
        />
      </div>
      <Button onClick={issue} disabled={!matches || pending}>
        {pending ? t('issuing') : t('issueButton')}
      </Button>
    </div>
  );
}
