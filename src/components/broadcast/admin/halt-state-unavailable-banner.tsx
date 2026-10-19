/**
 * Review 2026-09-07 round 2 (UX M-2) — the "halt state could not be read"
 * notice on the admin review queue. Same anatomy as its sibling
 * `HaltStateBanner`, which occupies the same slot (`role="region"` +
 * `aria-label` + ShieldAlert + h2 + body): two red boxes of different shape
 * alternated in one place, and the bare `role="alert"` the notice used
 * before is not announced when it arrives with the page — a live region
 * has to exist before its content changes — so the heading is what a
 * screen-reader user navigates to.
 *
 * Synchronous (no `async`), so it renders in a server tree AND under
 * `NextIntlClientProvider` in jsdom; the page decides when to render it
 * (the F3 halt read threw — review H-1, `getMembersHaltedInTenant` fails
 * closed).
 */
import { Alert } from '@jirawatpyk/aura-react/server';
import { useTranslations } from 'next-intl';

export function HaltStateUnavailableBanner(): React.ReactElement {
  const t = useTranslations('admin.broadcasts.queue');
  // Spec 122 US12b — an AURA danger Alert inside the named region (a page-
  // load state, not a live announcement), keeping its h2.
  return (
    <section aria-label={t('haltStateUnavailableTitle')}>
      <Alert tone="danger" role="none" icon="shield-alert">
        {/* h2: PageHeader is the page h1; this shares h2 with the SLA / halt banners */}
        <h2 className="aura-text-body font-semibold">{t('haltStateUnavailableTitle')}</h2>
        <p>{t('haltStateUnavailable')}</p>
      </Alert>
    </section>
  );
}
