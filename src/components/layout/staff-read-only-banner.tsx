/**
 * The staff maintenance banner (board `State-maintenance`).
 *
 * While the emergency write freeze is on (`READ_ONLY_MODE`) every
 * state-changing request is refused by `src/proxy.ts` with a 503. Before this
 * banner a staff user learned that only by being refused; it now says so on
 * every staff page and links to `/admin/support` — the page the 503 bodies
 * name — for what it means and who to contact. That page itself shows no
 * banner: its own status says the same thing (`HideOnSupportPage`).
 *
 * ADVISORY, never a gate, like the portal's `ReadOnlyModeBanner`: the flag is
 * read per request, so a tab opened before the freeze shows no banner until it
 * reloads, and every form's own read-only handling stays the source of truth.
 * Server component reading the same `env.flags.readOnlyMode` the proxy reads.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Alert, buttonClass } from '@jirawatpyk/aura-react/server';
import { env } from '@/lib/env';
import { HideOnSupportPage } from './hide-on-support-page';

export async function StaffReadOnlyBanner(): Promise<React.ReactElement | null> {
  if (!env.flags.readOnlyMode) return null;
  return <HideOnSupportPage>{await MaintenanceBannerView()}</HideOnSupportPage>;
}

/** The banner itself, also drawn by the /test-fixtures/aura-admin preview (which cannot flip the flag). */
export async function MaintenanceBannerView(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.maintenanceBanner');

  return (
    <div className="px-[var(--page-padding-x)] pt-[var(--page-padding-y)]">
      <Alert
        tone="warning"
        role="status"
        title={t('title')}
        id="staff-read-only-banner"
        data-testid="staff-read-only-banner"
        action={
          <Link href="/admin/support" className={buttonClass({ variant: 'secondary', touchHeight: true })}>
            {t('help')}
          </Link>
        }
      >
        {t('body')}
      </Alert>
    </div>
  );
}
