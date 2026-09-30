'use client';

/**
 * T095 — Bundle-change warning dialog (FR-010, SC-008).
 *
 * Fetches the live affected-member count from
 * GET /api/plans/[year]/[planId]/affected-members when opened, then
 * shows the old/new bundle corporate_plan_ids + the count. Admin must
 * confirm before the parent re-submits the PATCH with
 * `confirm_bundle_change: true`.
 *
 * Spec 122 US5b-2 (T578): AURA `Dialog` (no board — AURA defaults, content
 * and behaviour unchanged).
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Dialog } from '@jirawatpyk/aura-react';
import { SkeletonBlock } from '@/components/shell/page-skeletons';

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
      <span className="text-sm text-[var(--aura-fg-secondary)]">{t('noBundle')}</span>
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
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={t('title')}
      description={count !== null ? t('description', { affectedCount: count }) : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={loading}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {payload && (
          <div className="grid grid-cols-1 gap-4 rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-canvas)] p-3 text-sm sm:grid-cols-2">
            <div>
              <div className="text-xs text-[var(--aura-fg-secondary)]">{t('oldBundle')}</div>
              <div>{renderBundle(payload.oldBundleLabel, payload.oldBundleCorporatePlanId)}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--aura-fg-secondary)]">{t('newBundle')}</div>
              <div>{renderBundle(payload.newBundleLabel, payload.newBundleCorporatePlanId)}</div>
            </div>
          </div>
        )}

        <div className="text-sm" role="status" aria-live="polite">
          {/* I3 round-10 ui-design-specialist — a width-matched skeleton with
              the same visual mass as the final count line ("X members
              affected"), swapped for the real text with no CLS. SR users
              hear the polite live-region transition. */}
          {loading ? (
            <>
              <span className="sr-only">{t('loading')}</span>
              <SkeletonBlock aria-hidden="true" className="h-4 w-32" />
            </>
          ) : count !== null ? (
            <span className="font-medium">{t('affectedCount', { count })}</span>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
