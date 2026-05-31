/**
 * F8 Phase 5 Wave C · T126 — onboarding banner for first-time renewers
 * (US3 AS1).
 *
 * Server component (no client interactivity needed). Localised via
 * next-intl `getTranslations` — strings live under
 * `portal.renewal.onboarding.*` in EN/TH/SV message files.
 */
import { getTranslations } from 'next-intl/server';

export async function OnboardingBanner() {
  const t = await getTranslations('portal.renewal.onboarding');
  return (
    <div
      role="region"
      // I18 review-fix: aria-labelledby (not duplicate aria-label) so
      // screen readers don't announce the heading twice. Matches the
      // pattern in benefit-summary.tsx + plan-summary section.
      aria-labelledby="renewal-onboarding-heading"
      className="rounded-lg border border-info/30 bg-info-surface p-4 text-sm"
    >
      <h2 id="renewal-onboarding-heading" className="mb-1 font-medium">
        {t('heading')}
      </h2>
      <p className="text-muted-foreground">{t('body')}</p>
    </div>
  );
}
