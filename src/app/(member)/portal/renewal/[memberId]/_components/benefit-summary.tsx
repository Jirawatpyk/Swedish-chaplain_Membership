/**
 * F8 Phase 5 Wave C · T127 — benefit-summary panel (server component).
 *
 * Renders the cycle's benefit-consumption summary on the renewal
 * portal page (T125). When the upstream readers (F6 events / F7 quota)
 * are not yet wired, `benefitsAvailable=false` triggers the neutral
 * fallback copy.
 *
 * Called from T125 page; pure presentation (no fetching here — the
 * page passes the resolved `summary.benefits` list).
 *
 * I19 review-fix (Phase 5 / US3 review backlog close): each metered
 * benefit (`quota !== null`) now renders a visual progress bar with
 * accessible-name + ARIA progress semantics. Per WCAG 1.4.1 the
 * percent-used signal is conveyed in BOTH text ("{percent}% used") AND
 * shape (filled/unfilled bar segments) — colour is not the only
 * channel. The bar uses `currentColor` against the muted track so it
 * stays legible in the high-contrast / forced-colours render.
 *
 * Unmetered benefits (`quota === null`) skip the bar and render the
 * "Unlimited" label instead — semantically correct (no progress to
 * show against an infinite cap).
 */
import { useTranslations } from 'next-intl';
import type { BenefitConsumptionEntry } from '@/modules/renewals';

export interface BenefitSummaryProps {
  readonly benefits: ReadonlyArray<BenefitConsumptionEntry>;
  readonly benefitsAvailable: boolean;
}

export function BenefitSummary({
  benefits,
  benefitsAvailable,
}: BenefitSummaryProps) {
  const t = useTranslations('portal.renewal.benefits');
  const hasContent = benefitsAvailable && benefits.length > 0;
  return (
    <section
      aria-labelledby="benefits-heading"
      className="rounded-lg border bg-card p-4"
    >
      <h2 id="benefits-heading" className="mb-3 text-lg font-medium">
        {t('heading')}
      </h2>
      {hasContent ? (
        // Round-3 UX M2 fix: reference the section heading from the
        // <ul> so SR users hear the list's purpose ("Membership
        // benefits, list, N items") instead of just "list, N items".
        // The list is inside the labelled <section>, but most SR engines
        // do not propagate the section's accessible name to nested
        // <ul> announcements (WCAG 1.3.1).
        //
        // R2-S7: use `aria-label={t('heading')}` instead of reusing
        // `aria-labelledby="benefits-heading"` (which would point to
        // the same id used by the parent <section>) — id-reuse can
        // produce SR redundancy ("Membership benefits, Membership
        // benefits list, N items"). aria-label gives the <ul> its
        // own accessible name without traversing the same node twice.
        <ul aria-label={t('heading')} className="space-y-3 text-sm">
          {benefits.map((b) => (
            <BenefitRow key={b.key} benefit={b} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
      )}
    </section>
  );
}

function BenefitRow({ benefit }: { benefit: BenefitConsumptionEntry }) {
  const t = useTranslations('portal.renewal.benefits');
  const { label, used, quota } = benefit;
  // Unmetered benefit (e.g. "members can attend any number of …"):
  // skip the bar — there's no meaningful progress to render.
  if (quota === null) {
    return (
      <li>
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">
            {t('usageUnmetered', { used })}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('unmeteredQuota')}
        </p>
      </li>
    );
  }
  // Metered: render the progress bar with text + visual.
  const safeQuota = Math.max(quota, 1);
  const pct = Math.min(100, Math.max(0, Math.round((used / safeQuota) * 100)));
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground" aria-hidden="true">
          {t('usageRatio', { used, quota })}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={quota}
        aria-valuenow={used}
        aria-label={t('ariaProgress', { label, used, quota })}
        className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        {/* UX R5 / S3: `motion-safe:` so future client-side updates
            to `pct` honour `prefers-reduced-motion`. Server-rendered
            today, but harmless to gate proactively. */}
        <div
          className="h-full bg-primary motion-safe:transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('percentUsed', { percent: pct })}
      </p>
    </li>
  );
}
