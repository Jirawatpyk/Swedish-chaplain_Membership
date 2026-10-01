/**
 * F8 Phase 5 Wave C · T126 — the first-renewal welcome (US3 AS1).
 *
 * Spec 122 US7c (board `Portal-renewal`): an AURA info alert with a title.
 * It stands alone (not a live region), so it is a named `note`. Strings live
 * under `portal.renewal.onboarding.*` in the EN/TH/SV message files.
 */
import { useTranslations } from 'next-intl';
import { Alert } from '@jirawatpyk/aura-react/server';

export function OnboardingBanner() {
  const t = useTranslations('portal.renewal.onboarding');
  return (
    <Alert tone="info" role="note" aria-label={t('heading')} title={t('heading')}>
      {t('body')}
    </Alert>
  );
}
