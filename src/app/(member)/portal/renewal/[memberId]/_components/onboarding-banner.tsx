/**
 * F8 Phase 5 Wave C · T126 — the first-renewal welcome (US3 AS1).
 *
 * Spec 122 US7c (board `Portal-renewal`): an AURA info alert with a title.
 * It stands alone (not a live region), so it is a `note`; its visible title
 * is its text, so no `aria-label` repeats it (read twice — the I18 fix). Strings live
 * under `portal.renewal.onboarding.*` in the EN/TH/SV message files.
 */
import { useTranslations } from 'next-intl';
import { Alert } from '@jirawatpyk/aura-react/server';

export function OnboardingBanner() {
  const t = useTranslations('portal.renewal.onboarding');
  return (
    <Alert tone="info" role="note" title={t('heading')}>
      {t('body')}
    </Alert>
  );
}
