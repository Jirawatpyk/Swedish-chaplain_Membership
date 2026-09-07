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
import { ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

export function HaltStateUnavailableBanner(): React.ReactElement {
  const t = useTranslations('admin.broadcasts.queue');
  return (
    <div
      role="region"
      aria-label={t('haltStateUnavailableTitle')}
      className="rounded-md border border-destructive/40 bg-destructive-surface p-4"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
        <div>
          {/* h2: PageHeader is the page h1; this shares h2 with the SLA / halt banners */}
          <h2 className="text-sm font-semibold text-destructive">{t('haltStateUnavailableTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('haltStateUnavailable')}</p>
        </div>
      </div>
    </div>
  );
}
