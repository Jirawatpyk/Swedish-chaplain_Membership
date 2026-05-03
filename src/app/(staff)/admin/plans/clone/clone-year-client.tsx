/**
 * Client shell for /admin/plans/clone — source/target pickers +
 * confirmation dialog + POST + toast.
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { CloneYearDialog } from '@/components/plans/clone-year-dialog';

export interface CloneYearClientProps {
  readonly defaultSourceYear: number;
  readonly defaultTargetYear: number;
  readonly defaultSourcePlanCount: number;
}

function freshIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function CloneYearClient({
  defaultSourceYear,
  defaultTargetYear,
  defaultSourcePlanCount,
}: CloneYearClientProps) {
  const router = useRouter();
  const t = useTranslations('admin.plans');
  const tClone = useTranslations('admin.plans.clone');

  const [sourceYear, setSourceYear] = useState(defaultSourceYear);
  const [targetYear, setTargetYear] = useState(defaultTargetYear);
  const [activateCloned, setActivateCloned] = useState(false);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleConfirm(): Promise<void> {
    setSubmitting(true);
    try {
      const res = await fetch('/api/plans/clone', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': freshIdempotencyKey(),
        },
        body: JSON.stringify({
          source_year: sourceYear,
          target_year: targetYear,
          activate_cloned: activateCloned,
        }),
      });
      const body = await res.json().catch(() => ({}));

      if (res.status === 201) {
        toast.success(
          t('toast.cloned', { count: body.cloned_count ?? 0, targetYear }),
        );
        setOpen(false);
        router.push(`/admin/plans?year=${targetYear}`);
        router.refresh();
        return;
      }
      const errorCode = body?.error?.code ?? 'generic';
      if (errorCode === 'target_year_populated') {
        toast.error(tClone('errors.targetYearPopulated', { year: targetYear }));
      } else if (errorCode === 'source_year_empty') {
        toast.error(tClone('errors.noPlans', { year: sourceYear }));
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
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {tClone('description', {
          count: defaultSourcePlanCount,
          sourceYear,
          targetYear,
        })}
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="source_year">{tClone('sourceLabel')}</Label>
          <Input
            id="source_year"
            type="number"
            min={2000}
            max={2100}
            value={sourceYear}
            onChange={(e) =>
              setSourceYear(Number.parseInt(e.target.value, 10) || defaultSourceYear)
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="target_year">{tClone('targetLabel')}</Label>
          <Input
            id="target_year"
            type="number"
            min={2000}
            max={2100}
            value={targetYear}
            onChange={(e) =>
              setTargetYear(Number.parseInt(e.target.value, 10) || defaultTargetYear)
            }
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="activate_cloned" className="flex-1">
          {tClone('activateClonedLabel')}
        </Label>
        <Switch
          id="activate_cloned"
          checked={activateCloned}
          onCheckedChange={setActivateCloned}
        />
      </div>
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={() => router.push('/admin/plans')}>
          {tClone('cancel')}
        </Button>
        <Button
          onClick={() => setOpen(true)}
          disabled={sourceYear === targetYear || submitting}
        >
          {tClone('submit', { count: defaultSourcePlanCount })}
        </Button>
      </div>

      <CloneYearDialog
        open={open}
        onOpenChange={setOpen}
        sourceYear={sourceYear}
        targetYear={targetYear}
        sourcePlanCount={defaultSourcePlanCount}
        submitting={submitting}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
