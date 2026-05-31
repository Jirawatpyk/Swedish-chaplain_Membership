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
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { runInTenant } from '@/lib/db';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { makeRenewalsDeps } from '@/modules/renewals';
import { RenewalRemindersToggle } from './_components/renewal-reminders-toggle';

export default async function RenewalPreferencesPage() {
  const { user } = await requireSession('member');
  const tenant = resolveTenantFromRequest();
  const t = await getTranslations('portal.preferences.renewals');

  const membersDeps = buildMembersDeps(tenant);
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(tenant, user.id);
  if (!memberLookup.ok) {
    logger.warn(
      { tenantId: tenant.slug, userId: user.id },
      '[renewal-preferences-page] no member linked to session user',
    );
    notFound();
  }
  // C7 review-fix (2026-05-07): SSR-seed `initialOptedOut` from the
  // member row's `renewal_reminders_opted_out` column so members
  // already opted out see the correct toggle state on revisit (was
  // hardcoded false). F3 Member entity does not expose this F8-owned
  // column, so the read goes through the F8
  // `MemberRenewalFlagsRepo.readRenewalRemindersOptedOut` port (added
  // alongside this fix).
  const renewalsDeps = makeRenewalsDeps(tenant.slug);
  const initialOptedOut =
    (await runInTenant(tenant, (tx) =>
      renewalsDeps.memberRenewalFlagsRepo.readRenewalRemindersOptedOut(
        tx,
        tenant.slug,
        memberLookup.value.memberId,
      ),
    )) ?? false;

  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <CardContent>
          <RenewalRemindersToggle initialOptedOut={initialOptedOut} />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
