/**
 * T058 — Invoice draft form (F4).
 *
 * Minimal first ship — admin enters member_id + plan_id + plan_year,
 * clicks Create, lands on the draft detail page. Future polish will
 * replace inputs with member + plan pickers.
 */
'use client';

import { useRouter } from 'next/navigation';
import { useTransition, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

export function CreateDraftForm() {
  const t = useTranslations('admin.invoices.form');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [memberId, setMemberId] = useState('');
  const [planId, setPlanId] = useState('');
  const [planYear, setPlanYear] = useState(new Date().getFullYear());

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const res = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member_id: memberId,
          plan_id: planId,
          plan_year: planYear,
          auto_email_on_issue: null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(t('errors.create_failed'), {
          description: String((body as { error?: { code?: string } })?.error?.code ?? res.status),
        });
        return;
      }
      const data = (await res.json()) as { invoice_id: string };
      toast.success(t('success.created'));
      router.push(`/admin/invoices/${data.invoice_id}`);
    });
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div>
        <Label htmlFor="memberId">{t('fields.memberId')}</Label>
        <Input
          id="memberId"
          required
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
          placeholder="uuid-of-member"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('fields.memberIdHelp')}</p>
      </div>
      <div>
        <Label htmlFor="planId">{t('fields.planId')}</Label>
        <Input
          id="planId"
          required
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
          placeholder="corporate-regular"
        />
      </div>
      <div>
        <Label htmlFor="planYear">{t('fields.planYear')}</Label>
        <Input
          id="planYear"
          type="number"
          required
          value={planYear}
          onChange={(e) => setPlanYear(Number(e.target.value))}
        />
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? t('submitting') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
