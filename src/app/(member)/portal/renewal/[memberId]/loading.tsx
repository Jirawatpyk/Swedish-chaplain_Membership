/**
 * F8 Phase 5 Wave C · T126 — loading skeleton for the renewal portal page.
 *
 * Rendered by Next.js while the page server component fetches the
 * cycle summary. Mirrors the page's Card layout to avoid layout shift
 * on hydration. Shimmer follows `docs/ux-standards.md § 2.1`.
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
import { Skeleton } from '@/components/ui/skeleton';

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
    console.warn(
      '[renewal/loading] getTranslations failed — falling back to EN canonical',
      { err: e instanceof Error ? e.message : String(e) },
    );
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
      <div role="status" aria-live="polite" className="space-y-6">
        <span className="sr-only">{announce}</span>
        {/* PageHeader skeleton (mirrors WRN-7 PageHeader primitive) */}
        <div>
          <Skeleton className="h-7 w-40" />
          <Skeleton className="mt-2 h-4 w-72" />
        </div>
        {/* Staff-Review-2026-05-09 R2-W1 fix: reserve a slot for the
            <OnboardingBanner> which conditionally renders for first-
            time renewers in the real page (`page.tsx:153`). loading.tsx
            cannot read `summary.isFirstTimeRenewer` (use-case hasn't
            loaded yet) — the trade-off is ~50px wasted vertical for
            non-first-renewers vs ~50px CLS for first-renewers. We
            reserve unconditionally because the first-renewer experience
            is more sensitive to layout shift (banner content explains
            the 3-step flow, so any jump distracts from comprehension). */}
        <Skeleton className="h-12 w-full rounded-lg" />
        {/* Plan summary card */}
        <div className="rounded-lg border bg-card p-4">
          <Skeleton className="mb-3 h-6 w-32" />
          <div className="grid grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-x-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="contents">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-32" />
              </div>
            ))}
          </div>
        </div>
        {/* Benefit summary card — real BenefitSummary renders ~3
            progress rows (e-blast, events, member-search, etc.)
            with bar + label per row. */}
        <div className="rounded-lg border bg-card p-4">
          <Skeleton className="mb-3 h-6 w-40" />
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <div className="flex items-baseline justify-between">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-16" />
                </div>
                <Skeleton className="h-2 w-full rounded-full" />
              </div>
            ))}
          </div>
        </div>
        {/* RenewalConfirmFlow card — plan select + helper text +
            primary CTA + secondary cancel link. */}
        <div className="rounded-lg border bg-card p-4">
          <Skeleton className="mb-3 h-6 w-40" />
          <Skeleton className="h-4 w-full max-w-xs" />
          <Skeleton className="mt-3 h-9 w-full" />
          <Skeleton className="mt-3 h-3 w-3/4" />
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <Skeleton className="h-10 w-full sm:w-40" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
      </div>
    </DetailContainer>
  );
}
