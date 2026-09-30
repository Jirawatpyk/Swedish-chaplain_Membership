/**
 * Client shell for /admin/plans/clone — source/target pickers, a
 * read-only preview of the plans the clone will copy, confirmation
 * dialog + POST + toast.
 *
 * 122 US6 (T607): on AURA as the `Admin-plans-clone` board draws it — the
 * count sentence (the count in bold), the two years side by side, the
 * "Activate cloned plans immediately" switch with its description, the
 * plans to copy in two columns (one on a phone), then Cancel / "Clone {n}
 * plans", pinned to the bottom of a phone (Cancel a third).
 */
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/lib/toast';
import { useLocale, useTranslations } from 'next-intl';
import { formatSatangThb } from '@/lib/format-thb';
import { formatCalendarYear } from '@/lib/format-date-localised';
import { isReadOnlyCode, problemCode } from '@/lib/http/read-only-refusal';
import { ActionBar, Button, Switch, TextField } from '@jirawatpyk/aura-react';
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
          t('toast.cloned', {
            count: body.cloned_count ?? 0,
            targetYear: formatCalendarYear(targetYear, locale),
          }),
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
        toast.error(
          tClone('errors.targetYearPopulated', {
            year: formatCalendarYear(targetYear, locale),
          }),
        );
      } else if (errorCode === 'source_year_empty') {
        toast.error(
          tClone('errors.noPlans', { year: formatCalendarYear(sourceYear, locale) }),
        );
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
    <div className="space-y-[var(--aura-space-4)]">
      <p>
        {/* Visible years follow the locale (TH 2569); a half-typed value
            echoes back as typed. Inputs, the API body and URLs stay CE. */}
        {tClone.rich('description', {
          count: countLabel,
          sourceYear: formatCalendarYear(sourceYear, locale),
          targetYear: formatCalendarYear(targetYear, locale),
          b: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>
      <div className="grid grid-cols-2 gap-[var(--aura-space-4)]">
        <TextField
          id="source_year"
          label={tClone('sourceLabel')}
          type="number"
          min={2000}
          max={2100}
          required
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
        <TextField
          id="target_year"
          label={tClone('targetLabel')}
          type="number"
          min={2000}
          max={2100}
          required
          value={targetYear}
          onChange={(e) =>
            setTargetYear(Number.parseInt(e.target.value, 10) || defaultTargetYear)
          }
        />
      </div>
      <Switch
        id="activate_cloned"
        label={tClone('activateClonedLabel')}
        description={tClone('activateClonedHint')}
        checked={activateCloned}
        onChange={setActivateCloned}
      />
      <section aria-labelledby="clone-preview-title" className="space-y-[var(--aura-space-2)]">
        <h3 id="clone-preview-title" className="font-semibold">
          {sourceYear >= 2000 && sourceYear <= 2100
            ? tClone('preview.title', { sourceYear: formatCalendarYear(sourceYear, locale) })
            : tClone('preview.titleNoYear')}
        </h3>
        {sourcePlans === null ? (
          <p className="text-[var(--aura-fg-secondary)]" role="status">
            {previewFailed ? tClone('preview.failed') : tClone('preview.loading')}
          </p>
        ) : sourcePlans.length === 0 ? (
          <p className="text-[var(--aura-fg-secondary)]">
            {tClone('preview.empty', { sourceYear: formatCalendarYear(sourceYear, locale) })}
          </p>
        ) : (
          <ul aria-labelledby="clone-preview-title" className="aura-text-table-cell gap-x-[var(--aura-space-6)] md:columns-2">
            {sourcePlans.map((p) => (
              <li
                key={p.plan_id}
                className="flex break-inside-avoid items-center justify-between gap-[var(--aura-space-4)] border-t border-[var(--aura-border-default)] py-[var(--aura-space-2)]"
              >
                <span className="min-w-0 break-words">
                  <LocaleTextDisplay value={p.plan_name} />
                  {p.is_active ? null : (
                    <span className="text-[var(--aura-fg-secondary)]">
                      {' '}({tClone('preview.inactive')})
                    </span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums text-[var(--aura-fg-secondary)]">
                  {formatSatangThb(BigInt(p.annual_fee_minor_units), locale, previewCurrency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ActionBar className="chamber-viewport-actionbar plan-form-actions plan-form-actions--in-card">
        <Button type="button" variant="secondary" onClick={() => router.push('/admin/plans')}>
          {tClone('cancel')}
        </Button>
        <Button
          type="button"
          icon="copy"
          onClick={() => setOpen(true)}
          // NOT gated on the count: it is a display-only preview, and the clone
          // uses the real Source year server-side. A "…" (loading/failed) count
          // must never block an otherwise-valid clone.
          disabled={sourceYear === targetYear || submitting}
        >
          {tClone('submit', { count: countLabel })}
        </Button>
      </ActionBar>

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
