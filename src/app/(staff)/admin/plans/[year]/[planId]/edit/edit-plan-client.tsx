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
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { PlanEditForm } from '@/components/plans/plan-edit-form';
import type { PlanSchemaInput } from '@/modules/plans';

export interface EditPlanClientProps {
  readonly planId: string;
  readonly planYear: number;
  readonly initialValues: PlanSchemaInput;
  readonly currentYear: number;
  readonly currencyPrefix: string;
}

function freshIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Compute a sparse PATCH payload by diffing the draft against the
 * initial values. Only fields that changed are included in the body.
 * This keeps the audit log's diff honest (no phantom no-op writes).
 */
function computePatch(
  initial: PlanSchemaInput,
  draft: PlanSchemaInput,
): Partial<PlanSchemaInput> {
  const patch: Record<string, unknown> = {};
  const keys = Object.keys(draft) as Array<keyof PlanSchemaInput>;
  for (const key of keys) {
    // plan_id + plan_year are identity keys, never patched
    if (key === 'plan_id' || key === 'plan_year') continue;
    const before = initial[key];
    const after = draft[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      patch[key] = after;
    }
  }
  return patch as Partial<PlanSchemaInput>;
}

export function EditPlanClient({
  planId,
  planYear,
  initialValues,
  currentYear,
  currencyPrefix,
}: EditPlanClientProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const t = useTranslations('admin.plans');

  async function handleSubmit(draft: PlanSchemaInput): Promise<void> {
    const patch = computePatch(initialValues, draft);
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

      const errorCode = body?.error?.code ?? 'generic';
      if (errorCode === 'prior_year_locked_fields') {
        const fields = (body.error.details?.locked_fields ?? []).join(', ');
        toast.error(
          `Cannot edit locked fields on prior-year plan: ${fields}. Use the clone flow instead.`,
        );
      } else if (errorCode === 'not_found') {
        toast.error(t('errors.notFound'));
      } else {
        toast.error(t('errors.generic'));
      }
    } catch {
      toast.error(t('errors.network'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PlanEditForm
      initialValues={initialValues}
      currentYear={currentYear}
      currencyPrefix={currencyPrefix}
      submitting={submitting}
      onSubmit={handleSubmit}
      onCancel={() => router.push('/admin/plans')}
    />
  );
}
