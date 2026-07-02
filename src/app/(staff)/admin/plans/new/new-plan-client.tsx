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
import { resolvePlanCreateErrorKey } from './error-key';

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
      // read-only-mode (503) comes back in TWO shapes: the prod proxy emits
      // a flat hyphenated string `error: "read-only-mode"`; the route guard
      // emits a nested underscored `error.code: "read_only_mode"`. Normalize
      // both, and branch FIRST so neither is shadowed by the generic fallback.
      const errorObj = body?.error;
      const errorCode =
        typeof errorObj === 'string' ? errorObj : (errorObj?.code ?? 'generic');
      if (errorCode === 'read_only_mode' || errorCode === 'read-only-mode') {
        toast.error(t('errors.readOnlyMode'));
      } else {
        // API error codes are snake_case; a couple differ from their i18n
        // key and would otherwise fall through to errors.generic. See
        // ./error-key (duplicate_plan → duplicateKey, idempotency_conflict →
        // idempotencyConflict).
        const messageKey = resolvePlanCreateErrorKey(errorCode);
        const message = messageKey in (t.raw('errors') as Record<string, string>)
          ? t(`errors.${messageKey}` as 'generic')
          : t('errors.generic');
        toast.error(message);
      }
    } catch (err) {
      // Surface client-side throws (network, AbortError, TypeError from
      // crypto.randomUUID undefined, JSON serialise) to browser DevTools
      // so they aren't swallowed under a generic "network" toast. Server-
      // side logging happens only on completed requests via pino.
      console.error('[plans/new] submit threw', err);
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
