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
      aria-label={t('heading')}
      className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm dark:border-blue-900 dark:bg-blue-950"
    >
      <h2 className="mb-1 font-medium">{t('heading')}</h2>
      <p className="text-muted-foreground">{t('body')}</p>
    </div>
  );
}
