/**
 * Client shell for /admin/plans/[year]/[planId]/edit.
 *
 * Owns form submission, idempotency-key generation, toast feedback,
 * and post-save navigation. The pure edit form lives in
 * `src/components/plans/plan-edit-form.tsx`.
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { useTranslations } from 'next-intl';
import { isReadOnlyCode, problemCode } from '@/lib/http/read-only-refusal';
import { PlanEditForm } from '@/components/plans/plan-edit-form';
import type { CurrentYearPlanStatus } from '@/components/plans/prior-year-lock-banner';
import { computePlanPatch } from '@/components/plans/plan-patch';
import { lockedFieldLabels } from '@/components/plans/locked-field-labels';
import type { PlanSchemaInput } from '@/modules/plans';

export interface EditPlanClientProps {
  readonly planId: string;
  readonly planYear: number;
  readonly initialValues: PlanSchemaInput;
  readonly currentYear: number;
  readonly currencyUnit: string;
  readonly currentYearStatus: CurrentYearPlanStatus;
  readonly vatRatePercent: number | null;
}

function freshIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function EditPlanClient({
  planId,
  planYear,
  initialValues,
  currentYear,
  currencyUnit,
  currentYearStatus,
  vatRatePercent,
}: EditPlanClientProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const t = useTranslations('admin.plans');
  const tLabels = useTranslations('admin.plans.create.labels');

  async function handleSubmit(draft: PlanSchemaInput): Promise<void> {
    const patch = computePlanPatch(initialValues, draft);
    if (Object.keys(patch).length === 0) {
      toast.info(t('edit.toast.noChanges'));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/plans/${planYear}/${planId}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': freshIdempotencyKey(),
        },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));

      if (res.status === 200) {
        toast.success(t('toast.updated', { planName: draft.plan_name.en }));
        router.push('/admin/plans');
        router.refresh();
        return;
      }

      // read-only-mode 503 arrives as a flat string (proxy) OR nested code
      // (route guard) — `problemCode` normalizes both (PR-3 review B7); branch
      // FIRST so it isn't shadowed.
      const errorObj = body?.error;
      const errorCode = problemCode(body) ?? 'generic';
      if (isReadOnlyCode(errorCode)) {
        toast.error(t('errors.readOnlyMode'));
      } else if (errorCode === 'prior_year_locked_fields') {
        const fields = lockedFieldLabels(errorObj?.details?.locked_fields, tLabels).join(', ');
        toast.error(t('errors.priorYearLocked', { fields }));
      } else if (errorCode === 'not_found') {
        toast.error(t('errors.notFound'));
      } else {
        toast.error(t('errors.generic'));
      }
    } catch (err) {
      // Surface client-side throws (network, AbortError, TypeError) to
      // browser DevTools so they aren't swallowed under a generic
      // "network" toast.
      console.error('[plans/edit] submit threw', err);
      toast.error(t('errors.network'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PlanEditForm
      initialValues={initialValues}
      currentYear={currentYear}
      currencyUnit={currencyUnit}
      currentYearStatus={currentYearStatus}
      vatRatePercent={vatRatePercent}
      submitting={submitting}
      onSubmit={handleSubmit}
      onCancel={() => router.push('/admin/plans')}
    />
  );
}
