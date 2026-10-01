/**
 * F8 Phase 5 Wave C · T126 — loading skeleton for the renewal portal page.
 *
 * Rendered by Next.js while the page server component fetches the
 * cycle summary. Mirrors the page's Card layout to avoid layout shift
 * on hydration. Skeleton blocks follow `docs/ux-standards.md § 2.1`.
 *
 * Spec 122 US7c: the board's layout (two columns from `lg`: the plan and
 * benefit cards left, the confirm card right), AURA cards, shared blocks.
 *
 * S-8 polish (Phase 5 review backlog close): the entire skeleton tree
 * is wrapped in a `role="status" aria-live="polite"` region with a
 * visually-hidden "Loading…" announcement so screen-reader users hear
 * the loading state explicitly instead of silence (the shimmer cards
 * are otherwise invisible to assistive tech).
 *
 * Round 2 review-fix (I-8): the `getTranslations` call is wrapped in
 * try/catch with a hardcoded EN fallback. The release-branch CI gate
 * (`pnpm check:i18n`) blocks merges that drop the `announce` key from
 * any locale, so the fallback is defensive-only — but a Suspense
 * fallback that THROWS at render time degrades the entire renewal
 * page transition into a blank screen with no error boundary. Better
 * to ship the wrong-locale string ("Loading renewal details…" in EN
 * even on TH/SV portals) than nothing — the announcement is a
 * screen-reader-only string, never visible. Belt + braces.
 */
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { Card } from '@jirawatpyk/aura-react/server';
import { SkeletonBlock } from '@/components/shell/page-skeletons';

const FALLBACK_LOADING_ANNOUNCE = 'Loading renewal details…';

async function resolveLoadingAnnounce(): Promise<string> {
  try {
    const t = await getTranslations('portal.renewal.loading');
    return t('announce');
  } catch (e) {
    // Round 3 review-fix (R3-S2): bind + log. Missing-key path is the
    // documented expected case (CI gate `pnpm check:i18n` blocks merges
    // that drop the key on release branches), but a bare swallow would
    // also hide a real next-intl provider crash, runtime context
    // propagation bug, or polyfill regression. The console.warn lets
    // SRE / support correlate user reports with the underlying cause
    // instead of attributing every silent EN fallback to "missing
    // locale key" guesswork. Server component → console.warn lands in
    // the Vercel function log stream.
    console.warn('[renewal/loading] getTranslations failed — falling back to EN canonical', {
      err: e instanceof Error ? e.message : String(e),
    });
    return FALLBACK_LOADING_ANNOUNCE;
  }
}

export default async function RenewalPortalLoading() {
  const announce = await resolveLoadingAnnounce();
  return (
    <DetailContainer>
      {/* UX R5 / S2: skeleton uses plain `<div>` elements, not
          `<header>` + `<section>` landmarks. The real page renders
          its own landmarks; phantom-landmark announcements during
          load mislead screen-reader users about page structure
          (matching the cycle-detail loading.tsx K27 R2 N-3 fix).

          Staff-Review-2026-05-09 WRN-6 fix: skeleton tree mirrors the
          real page's 3-section layout (plan-summary card + benefit
          summary card + RenewalConfirmFlow card) to avoid CLS at
          hydration. Heights/widths estimated from the real components:
            - PageHeader: h1 (28px) + subtitle (16px) ≈ 60px
            - Plan summary card: 5 dl rows × (16px + 8px gap) ≈ 168px
            - Benefit summary card: 3 progress rows ≈ 192px (typical
              MVP set; F2/F4/F6/F7 quotas)
            - RenewalConfirmFlow card: select + helper + CTA button
              row ≈ 180px
          Real components are responsive — skeleton intentionally
          uses generous fixed heights so post-hydration content
          generally fits without pushing surrounding chrome. */}
      <div role="status" aria-live="polite" className="flex flex-col gap-[var(--aura-space-6)]">
        <span className="sr-only">{announce}</span>
        {/* PageHeader skeleton */}
        <div>
          <SkeletonBlock className="h-8 w-48" />
          <SkeletonBlock className="mt-2 h-4 w-72 max-w-full" />
        </div>
        {/* Staff-Review-2026-05-09 R2-W1: a slot for the first-renewal
            welcome, reserved unconditionally — a first renewer is the most
            sensitive to layout shift. */}
        <SkeletonBlock className="h-16 w-full" />
        <div className="grid grid-cols-1 gap-[var(--aura-space-6)] lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
          <div className="flex min-w-0 flex-col gap-[var(--aura-space-6)]">
            {/* Membership plan card: four label/value rows. */}
            <Card header={<SkeletonBlock className="h-6 w-40" />}>
              <div className="grid grid-cols-1 gap-x-[var(--aura-space-4)] gap-y-[var(--aura-space-3)] sm:grid-cols-[auto_1fr]">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="contents">
                    <SkeletonBlock className="h-4 w-24" />
                    <SkeletonBlock className="h-4 w-40" />
                  </div>
                ))}
              </div>
            </Card>
            {/* Benefit summary card: progress rows. */}
            <Card header={<SkeletonBlock className="h-6 w-40" />}>
              <div className="flex flex-col gap-[var(--aura-space-4)]">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex flex-col gap-[var(--aura-space-2)]">
                    <div className="flex items-baseline justify-between">
                      <SkeletonBlock className="h-4 w-32" />
                      <SkeletonBlock className="h-3 w-12" />
                    </div>
                    <SkeletonBlock className="h-2 w-full rounded-full" />
                  </div>
                ))}
              </div>
            </Card>
          </div>
          {/* Confirm card: stepper, select, price band (always rendered —
              C-6 — so the CTA below does not jump; enterprise-ux B1), CTA. */}
          <Card header={<SkeletonBlock className="h-6 w-24" />}>
            <div className="flex flex-col gap-[var(--aura-space-4)]">
              <div data-testid="renewal-skeleton-steps" className="flex items-center gap-[var(--aura-space-2)]">
                <SkeletonBlock className="size-6 rounded-full" />
                <SkeletonBlock className="h-4 w-28" />
                <SkeletonBlock className="h-px flex-1" />
                <SkeletonBlock className="size-6 rounded-full" />
                <SkeletonBlock className="h-4 w-20" />
              </div>
              <div className="flex flex-col gap-[var(--aura-space-2)]">
                <SkeletonBlock className="h-4 w-28" />
                <SkeletonBlock className="h-9 w-full" />
              </div>
              <div className="flex flex-col gap-[var(--aura-space-2)] rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] p-[var(--aura-space-3)]">
                <SkeletonBlock className="h-3 w-24" />
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <SkeletonBlock className="h-4 w-32" />
                    <SkeletonBlock className="h-4 w-24" />
                  </div>
                ))}
              </div>
              <SkeletonBlock data-testid="renewal-skeleton-cta" className="h-11 w-full" />
            </div>
          </Card>
        </div>
      </div>
    </DetailContainer>
  );
}
