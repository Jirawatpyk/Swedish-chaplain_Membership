/**
 * T123 — Persistent banner shown when role==manager.
 *
 * Per FR-014 + Q12: manager has read access to the F7 admin queue +
 * detail surface but cannot approve/reject/cancel. Banner reinforces
 * this expectation upfront so the manager doesn't look for missing
 * action buttons.
 *
 * Server component (no client state); rendered conditionally by the
 * page based on `requireSession.user.role`.
 */
import { Alert } from '@jirawatpyk/aura-react/server';
import { getTranslations } from 'next-intl/server';

export async function ManagerReadonlyBanner(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.managerReadonlyBanner');
  // Spec 122 US12b — an AURA info Alert inside the named region. Each of the
  // sibling banners (SLA / Halt / ManagerReadonly) owns an h2 under the page
  // h1 (D-banner-2: HaltStateBanner can be absent, so no h3).
  return (
    <section aria-label={t('title')}>
      <Alert tone="info" role="none" icon="eye">
        <h2 className="aura-text-body font-semibold">{t('title')}</h2>
        <p>{t('body')}</p>
      </Alert>
    </section>
  );
}
