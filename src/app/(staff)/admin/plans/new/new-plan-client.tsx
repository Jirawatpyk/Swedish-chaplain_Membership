/**
 * Client shell for the /admin/plans/new wizard.
 *
 * Owns form submission, idempotency-key generation, toast feedback,
 * and post-save navigation. The pure wizard component stays in
 * `src/components/plans/plan-form-wizard.tsx`.
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { PlanFormWizard } from '@/components/plans/plan-form-wizard';
import type { PlanSchemaInput } from '@/modules/plans';

export interface NewPlanClientProps {
  readonly currentYear: number;
  readonly currencyPrefix: string;
}

function freshIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function NewPlanClient({ currentYear, currencyPrefix }: NewPlanClientProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const t = useTranslations('admin.plans');

  async function handleSubmit(draft: PlanSchemaInput): Promise<void> {
    setSubmitting(true);
    try {
      const res = await fetch('/api/plans', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': freshIdempotencyKey(),
        },
        body: JSON.stringify(draft),
      });
      const body = await res.json().catch(() => ({}));

      if (res.status === 201) {
        toast.success(t('toast.created', { planName: draft.plan_name.en }));
        router.push('/admin/plans');
        router.refresh();
        return;
      }
      const errorCode = body?.error?.code ?? 'generic';
      const message = errorCode in (t.raw('errors') as Record<string, string>)
        ? t(`errors.${errorCode}` as 'generic')
        : t('errors.generic');
      toast.error(message);
    } catch {
      toast.error(t('errors.network'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PlanFormWizard
      currentYear={currentYear}
      currencyPrefix={currencyPrefix}
      submitting={submitting}
      onSubmit={handleSubmit}
      onCancel={() => router.push('/admin/plans')}
    />
  );
}
