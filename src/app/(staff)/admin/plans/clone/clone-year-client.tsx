/**
 * Client shell for /admin/plans/clone — source/target pickers, a
 * read-only preview of the plans the clone will copy, confirmation
 * dialog + POST + toast.
 */
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { formatSatangThb } from '@/lib/format-thb';
import { isReadOnlyCode, problemCode } from '@/lib/http/read-only-refusal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { CloneYearDialog } from '@/components/plans/clone-year-dialog';
import { LocaleTextDisplay } from '@/components/plans/locale-text-display';
import type { LocaleText } from '@/modules/plans';

/** One row of the "plans to copy" preview (a subset of `PlanListItem`). */
export interface CloneSourcePlan {
  readonly plan_id: string;
  readonly plan_name: LocaleText;
  readonly annual_fee_minor_units: number;
  readonly is_active: boolean;
}

export interface CloneYearClientProps {
  readonly defaultSourceYear: number;
  readonly defaultTargetYear: number;
  /** Tenant currency for the preview's fees. */
  readonly currencyCode: string;
  /** Non-deleted plans of `defaultSourceYear`, as the clone will copy them. */
  readonly defaultSourcePlans: ReadonlyArray<CloneSourcePlan>;
}

function toSourcePlans(data: unknown): ReadonlyArray<CloneSourcePlan> {
  if (!Array.isArray(data)) return [];
  return data.map((p: CloneSourcePlan) => ({
    plan_id: p.plan_id,
    plan_name: p.plan_name,
    annual_fee_minor_units: p.annual_fee_minor_units,
    is_active: p.is_active,
  }));
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
  currencyCode,
  defaultSourcePlans,
}: CloneYearClientProps) {
  const router = useRouter();
  const locale = useLocale();
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
  // The preview list is the count's source of truth (count = its length),
  // so both refetch together. `previewFailed` separates a failed fetch from
  // one still loading, for the list's copy only — the count shows "…" for
  // either.
  const [sourcePlans, setSourcePlans] = useState<ReadonlyArray<CloneSourcePlan> | null>(
    defaultSourcePlans,
  );
  const [previewCurrency, setPreviewCurrency] = useState(currencyCode);
  const [previewFailed, setPreviewFailed] = useState(false);
  const sourcePlanCount = sourcePlans?.length ?? null;

  // Refetch the pre-flight count whenever the Source year changes (free-typed
  // number input). A hand-rolled debounce is deliberate here — NOT
  // useDebouncedValue: the effect must key on the IMMEDIATE sourceYear so an
  // up-then-back edit within the window still re-runs and restores the count.
  // A value-collapsing trailing debounce would no-op that net-zero change and
  // strand the count at null. `null` = not-yet-known (loading OR a failed
  // fetch); the count surfaces render "…" for it. The count is display ONLY —
  // the clone always uses the real Source year server-side — so a failed count
  // fetch must NOT block the Clone button (it doesn't; see the button below).
  useEffect(() => {
    setPreviewFailed(false);
    if (sourceYear === defaultSourceYear) {
      setSourcePlans(defaultSourcePlans);
      setPreviewCurrency(currencyCode);
      return;
    }
    if (sourceYear < 2000 || sourceYear > 2100) {
      // Out-of-range — including transient digits ("2"/"20"/"202") while the
      // admin is still typing a year — is UNKNOWN, not "0 plans". Show "…".
      setSourcePlans(null);
      return;
    }
    // onChange already blanked to null synchronously; keep it null here too
    // (defensive, and covers a programmatic sourceYear change).
    setSourcePlans(null);
    let cancelled = false;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/plans?year=${sourceYear}`, {
            credentials: 'same-origin',
          });
          if (!res.ok) throw new Error(`status ${res.status}`);
          const body = (await res.json()) as {
            data?: unknown;
            meta?: { currency_code?: string };
          };
          if (!cancelled) {
            setSourcePlans(toSourcePlans(body.data));
            if (body.meta?.currency_code) setPreviewCurrency(body.meta.currency_code);
          }
        } catch {
          // Leave the count UNKNOWN (null → "…") on a transient failure — do
          // NOT coerce to 0 (falsely "no plans"). Clone stays clickable.
          if (!cancelled) {
            setSourcePlans(null);
            setPreviewFailed(true);
          }
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [sourceYear, defaultSourceYear, defaultSourcePlans, currencyCode]);

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
      // (route guard) — `problemCode` normalizes both (PR-3 review B7); branch
      // FIRST so it isn't shadowed.
      const errorCode = problemCode(body) ?? 'generic';
      if (isReadOnlyCode(errorCode)) {
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

  // Single source of truth for the "…" loading/unknown placeholder shown when
  // the pre-flight count is not yet known.
  const countLabel = sourcePlanCount ?? '…';

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {tClone('description', {
          count: countLabel,
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
              const nextYear =
                Number.parseInt(e.target.value, 10) || defaultSourceYear;
              setSourceYear(nextYear);
              // Blank the count synchronously ONLY when the year actually
              // changes: batched with setSourceYear it avoids a frame painting
              // the NEW year beside the OLD count, while skipping a same-value
              // edit (e.g. clearing the field back to the current year) avoids
              // stranding it at "…" — a no-op setSourceYear would not re-run the
              // effect that restores the count.
              if (nextYear !== sourceYear) {
                setSourcePlans(null);
              }
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
      <section aria-labelledby="clone-preview-title" className="space-y-2">
        <h3 id="clone-preview-title" className="text-sm font-medium">
          {tClone('preview.title', { sourceYear })}
        </h3>
        {sourcePlans === null ? (
          <p className="text-muted-foreground text-sm" role="status">
            {previewFailed ? tClone('preview.failed') : tClone('preview.loading')}
          </p>
        ) : sourcePlans.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {tClone('preview.empty', { sourceYear })}
          </p>
        ) : (
          <ul
            aria-labelledby="clone-preview-title"
            className="divide-y rounded-md border text-sm"
          >
            {sourcePlans.map((p) => (
              <li
                key={p.plan_id}
                className="flex items-center justify-between gap-4 px-3 py-2"
              >
                <span className="min-w-0 truncate">
                  <LocaleTextDisplay value={p.plan_name} />
                  {p.is_active ? null : (
                    <span className="text-muted-foreground">
                      {' '}({tClone('preview.inactive')})
                    </span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatSatangThb(BigInt(p.annual_fee_minor_units), locale, previewCurrency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="activate_cloned" className="flex-1">
          {tClone('activateClonedLabel')}
        </Label>
        {/* Named in the SSR HTML so the switch is not anonymous to AT during
            the pre-hydration window — see invoice-settings-form for the full
            note on Base UI's late aria-labelledby. */}
        <Switch
          id="activate_cloned"
          aria-label={tClone('activateClonedLabel')}
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
          // NOT gated on the count: it is a display-only preview, and the clone
          // uses the real Source year server-side. A "…" (loading/failed) count
          // must never block an otherwise-valid clone.
          disabled={sourceYear === targetYear || submitting}
        >
          {tClone('submit', { count: countLabel })}
        </Button>
      </div>

      <CloneYearDialog
        open={open}
        onOpenChange={setOpen}
        sourceYear={sourceYear}
        targetYear={targetYear}
        sourcePlanCount={sourcePlanCount}
        submitting={submitting}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
