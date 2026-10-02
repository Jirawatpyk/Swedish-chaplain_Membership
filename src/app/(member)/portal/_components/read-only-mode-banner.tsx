/**
 * Portal error states follow-up — the READ_ONLY_MODE banner.
 *
 * While the emergency write freeze is on (`READ_ONLY_MODE`, quickstart § 7.3)
 * every state-changing request is refused by `src/proxy.ts` with a 503. Before
 * this banner a member learned that only by submitting something (#388, #390
 * made each form say so). The banner says it on every portal page first.
 *
 * ADVISORY, never a gate: the flag is read per request, so a tab opened before
 * the freeze shows no banner until it reloads, and every form's own read-only
 * handling stays the source of truth. Forms are therefore left enabled.
 *
 * Server component reading the same `env.flags.readOnlyMode` the proxy reads —
 * no endpoint, no client fetch, no flash. Same outer wrapper as the E-Blast
 * acknowledgement banner, so its edges line up with the page content.
 */
import { getTranslations } from 'next-intl/server';
import { Alert } from '@jirawatpyk/aura-react/server';
import { env } from '@/lib/env';

export async function ReadOnlyModeBanner(): Promise<React.ReactElement | null> {
  if (!env.flags.readOnlyMode) return null;
  const t = await getTranslations('errors');

  return (
    <div className="mx-auto w-full max-w-(--aura-container-max) px-[var(--page-padding-x)] pt-[var(--page-padding-y)]">
      <Alert
        tone="warning"
        role="status"
        title={t('readOnlyMode')}
        data-testid="read-only-mode-banner"
      >
        {t('readOnlyModeBrowse')}
      </Alert>
    </div>
  );
}
