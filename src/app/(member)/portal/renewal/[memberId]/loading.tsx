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
      <div role="status" aria-live="polite">
        <span className="sr-only">{announce}</span>
        <header>
          <Skeleton className="h-7 w-40" />
          <Skeleton className="mt-2 h-4 w-72" />
        </header>
        <section className="rounded-lg border bg-card p-4">
          <Skeleton className="mb-3 h-6 w-32" />
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="contents">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-32" />
              </div>
            ))}
          </div>
        </section>
        <section className="rounded-lg border bg-card p-4">
          <Skeleton className="mb-3 h-6 w-40" />
          <Skeleton className="h-4 w-full" />
        </section>
        <Skeleton className="h-10 w-32" />
      </div>
    </DetailContainer>
  );
}
