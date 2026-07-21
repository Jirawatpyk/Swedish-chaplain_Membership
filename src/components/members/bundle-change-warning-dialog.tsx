'use client';

/**
 * T095 — Bundle-change warning dialog (FR-010, SC-008).
 *
 * Fetches the live affected-member count from
 * GET /api/plans/[year]/[planId]/affected-members when opened, then
 * shows the old/new bundle corporate_plan_ids + the count. Admin must
 * confirm before the parent re-submits the PATCH with
 * `confirm_bundle_change: true`.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export type BundleChangePayload = {
  readonly oldBundleCorporatePlanId: string | null;
  readonly newBundleCorporatePlanId: string | null;
  /** The plan_id of the OLD partnership tier — we count members on THIS plan. */
  readonly oldPlanId: string;
  readonly oldPlanYear: number;
  /**
   * BP5 item 6 — resolved human display names for the bundle corporate plans.
   * `null`/absent → the dialog falls back to the raw font-mono id (the
   * pre-existing behaviour), so the caller can leave these off when the plan
   * can't be resolved (inactive / prior-year).
   */
  readonly oldBundleLabel?: string | null;
  readonly newBundleLabel?: string | null;
};

type Props = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly payload: BundleChangePayload | null;
  readonly onConfirm: () => void;
};

export function BundleChangeWarningDialog({
  open,
  onOpenChange,
  payload,
  onConfirm,
}: Props) {
  const t = useTranslations('admin.members.bundleChangeWarning');
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState<number | null>(null);

  // BP5 item 6 — render the resolved plan name when available; fall back to
  // the raw font-mono id (with a tooltip), and to the localised "None" when
  // there is no bundle at all (never a bare em-dash that reads as missing data).
  const renderBundle = (
    label: string | null | undefined,
    id: string | null,
  ) => {
    if (label) return <span className="text-sm font-medium">{label}</span>;
    if (id) {
      return (
        <span className="font-mono text-xs" title={id}>
          {id}
        </span>
      );
    }
    return (
      <span className="text-sm text-muted-foreground">{t('noBundle')}</span>
    );
  };

  /* eslint-disable react-hooks/set-state-in-effect --
   * Fetch the affected-member count when the dialog opens against a
   * new payload. Legitimate data-fetching effect — the count depends
   * on the current payload AND the server's live state, not props
   * alone, so a pure-function / use-memo alternative doesn't apply. */
  useEffect(() => {
    if (!open || !payload) return;
    let cancelled = false;
    setLoading(true);
    fetch(
      `/api/plans/${payload.oldPlanYear}/${encodeURIComponent(payload.oldPlanId)}/affected-members`,
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((json) => {
        if (!cancelled) setCount(json.count);
      })
      .catch(() => {
        if (!cancelled) setCount(0);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, payload]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          {count !== null && (
            <DialogDescription>
              {t('description', { affectedCount: count })}
            </DialogDescription>
          )}
        </DialogHeader>

        {payload && (
          <div className="grid grid-cols-2 gap-4 rounded-md border bg-muted/30 p-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">
                {t('oldBundle')}
              </div>
              <div>
                {renderBundle(
                  payload.oldBundleLabel,
                  payload.oldBundleCorporatePlanId,
                )}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">
                {t('newBundle')}
              </div>
              <div>
                {renderBundle(
                  payload.newBundleLabel,
                  payload.newBundleCorporatePlanId,
                )}
              </div>
            </div>
          </div>
        )}

        <div
          className="text-sm"
          role="status"
          aria-live="polite"
        >
          {/* I3 round-10 ui-design-specialist — was a spinner + "Loading…"
              text which broke the skeleton-first convention used by
              every other admin surface. Now: a width-matched shimmer
              that has the same visual mass as the final count line
              ("X members affected"). When `loading` ends, the skeleton
              swaps to the real text with no CLS. SR users still hear
              the polite live-region transition. */}
          {loading ? (
            <>
              <span className="sr-only">{t('loading')}</span>
              <Skeleton aria-hidden="true" className="h-4 w-32" />
            </>
          ) : count !== null ? (
            <span className="font-medium">{t('affectedCount', { count })}</span>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={loading}
          >
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
