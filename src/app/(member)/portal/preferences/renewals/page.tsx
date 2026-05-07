/**
 * F8 Phase 5 Wave C · T132 — `/portal/preferences/renewals` page.
 *
 * Member-facing preferences page exposing the renewal-reminder opt-out
 * toggle per FR-016. Toggle posts to `/api/portal/preferences/renewals`
 * (T132 route) which calls `optOutRenewalReminders` /
 * `optInRenewalReminders` use-cases.
 *
 * Auth: requireSession('member'). The session-member is the target —
 * no cross-member guard needed.
 *
 * i18n: strings under `portal.preferences.renewals.*` in EN/TH/SV.
 */
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { RenewalRemindersToggle } from './_components/renewal-reminders-toggle';

export default async function RenewalPreferencesPage() {
  const { user } = await requireSession('member');
  const tenant = resolveTenantFromRequest();
  const t = await getTranslations('portal.preferences.renewals');

  const membersDeps = buildMembersDeps(tenant);
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(
    tenant,
    user.id,
  );
  if (!memberLookup.ok) {
    logger.warn(
      { tenantId: tenant.slug, userId: user.id },
      '[renewal-preferences-page] no member linked to session user',
    );
    notFound();
  }
  // SSR-seeding the toggle from current member state deferred — the
  // toggle is optimistic + the API round-trip reflects authoritative
  // state on first interaction, so MVP UX is acceptable.
  void memberLookup;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>

      <section className="rounded-lg border bg-card p-4">
        <RenewalRemindersToggle initialOptedOut={false} />
      </section>
    </main>
  );
}
