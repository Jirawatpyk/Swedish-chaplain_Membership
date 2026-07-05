/**
 * Client shell for /admin/plans/clone — source/target pickers +
 * confirmation dialog + POST + toast.
 */
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { CloneYearDialog } from '@/components/plans/clone-year-dialog';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

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

  // BUG-010: the server seeds the source-plan count for `defaultSourceYear`
  // only, but the Source year is editable — so picking a different Source
  // year left the description / button / confirm-dialog quoting the stale
  // current-year count while the description text already read the NEW year.
  // Refetch the count whenever the Source year changes (debounced, since it
  // is a free-typed number input) so every count-bearing surface stays
  // truthful. The actual clone always used the real Source year server-side;
  // only this pre-flight display was wrong.
  // `null` = the count for the CURRENT Source year is not known yet (loading or
  // a failed fetch). The count-bearing surfaces show a neutral "…" and the
  // Clone button is disabled while null, so we never quote a stale count (from
  // the previous year, during the debounce) or a falsely-zero count (on a
  // transient fetch error) — code-review follow-up to BUG-010.
  const [sourcePlanCount, setSourcePlanCount] = useState<number | null>(
    defaultSourcePlanCount,
  );

  // Debounce the free-typed Source year so a rapid edit fires ONE refetch
  // (shared trailing-edge hook). The count is blanked SYNCHRONOUSLY in the
  // year input's onChange, so the display shows "…" (never a stale prior-year
  // number) while this settles.
  const debouncedSourceYear = useDebouncedValue(sourceYear, 350);

  useEffect(() => {
    if (debouncedSourceYear === defaultSourceYear) {
      setSourcePlanCount(defaultSourcePlanCount);
      return;
    }
    if (debouncedSourceYear < 2000 || debouncedSourceYear > 2100) {
      setSourcePlanCount(0);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/plans?year=${debouncedSourceYear}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as { data?: unknown };
        if (!cancelled) {
          setSourcePlanCount(Array.isArray(body.data) ? body.data.length : 0);
        }
      } catch {
        // Leave the count UNKNOWN (null) on a transient failure — do NOT
        // coerce to 0, which would falsely read "no plans for that year".
        if (!cancelled) setSourcePlanCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedSourceYear, defaultSourceYear, defaultSourcePlanCount]);

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
      // read-only-mode 503 arrives as a flat string (proxy) OR nested code
      // (route guard) — normalize both; branch FIRST so it isn't shadowed.
      const errorObj = body?.error;
      const errorCode =
        typeof errorObj === 'string' ? errorObj : (errorObj?.code ?? 'generic');
      if (errorCode === 'read_only_mode' || errorCode === 'read-only-mode') {
        toast.error(t('errors.readOnlyMode'));
      } else if (errorCode === 'target_year_populated') {
        toast.error(tClone('errors.targetYearPopulated', { year: targetYear }));
      } else if (errorCode === 'source_year_empty') {
        toast.error(tClone('errors.noPlans', { year: sourceYear }));
      } else {
        toast.error(t('errors.generic'));
      }
    } catch (err) {
      // Surface client-side throws (network, AbortError, TypeError) to
      // browser DevTools so they aren't swallowed under a generic
      // "network" toast.
      console.error('[plans/clone] submit threw', err);
      toast.error(t('errors.network'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {tClone('description', {
          count: sourcePlanCount ?? '…',
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
            onChange={(e) => {
              setSourceYear(
                Number.parseInt(e.target.value, 10) || defaultSourceYear,
              );
              // Blank the count immediately so the display shows "…" (never a
              // stale prior-year number) until the debounced refetch settles.
              setSourcePlanCount(null);
            }}
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
          // Disabled while the count for the current Source year is unknown
          // (loading / failed): the confirm dialog must never open quoting a
          // stale or falsely-zero count (code-review follow-up to BUG-010).
          disabled={
            sourceYear === targetYear || submitting || sourcePlanCount === null
          }
        >
          {tClone('submit', { count: sourcePlanCount ?? '…' })}
        </Button>
      </div>

      <CloneYearDialog
        open={open}
        onOpenChange={setOpen}
        sourceYear={sourceYear}
        targetYear={targetYear}
        sourcePlanCount={sourcePlanCount ?? 0}
        submitting={submitting}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
