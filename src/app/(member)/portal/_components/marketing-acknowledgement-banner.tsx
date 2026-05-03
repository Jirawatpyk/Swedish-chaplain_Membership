/**
 * T091 — Marketing acknowledgement banner (Q15 / GDPR Art. 7).
 *
 * Server component rendered on every portal landing surface. Renders
 * if and only if:
 *   - session.role === 'member'
 *   - tenant has F7 enabled (env.features.f7Broadcasts)
 *   - member.broadcastsAcknowledgedAt IS NULL
 *   - member's plan has eblast_per_year > 0 (cheap heuristic via
 *     `getPlanForMember`)
 *
 * "Acknowledge" CTA POSTs to `/api/portal/broadcasts/acknowledge`
 * (deferred to a follow-up Wave; for now the button calls the F3
 * `markBroadcastsAcknowledged` use-case via a server action).
 *
 * "Remind me later" records nothing — the banner re-appears on the
 * next portal session.
 */
import { sql } from 'drizzle-orm';
import { getLocale, getTranslations } from 'next-intl/server';
import { runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { getCurrentSession } from '@/lib/auth-session';
import {
  computeQuotaCounter,
  makeComputeQuotaDeps,
} from '@/modules/broadcasts';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { AcknowledgementBannerClient } from './marketing-acknowledgement-banner-client';

interface BannerEligibility {
  readonly show: boolean;
  readonly memberId: string | null;
}

async function checkEligibility(): Promise<BannerEligibility> {
  if (!env.features.f7Broadcasts) {
    return { show: false, memberId: null };
  }
  const session = await getCurrentSession();
  if (!session || session.user.role !== 'member') {
    return { show: false, memberId: null };
  }
  const tenant = resolveTenantFromRequest();
  const membersDeps = buildMembersDeps(tenant);
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(
    tenant,
    session.user.id,
  );
  if (!memberLookup.ok) {
    return { show: false, memberId: null };
  }
  const memberId = memberLookup.value.memberId;

  // Direct SQL: F3 Member entity does not project the
  // `broadcasts_acknowledged_at` column (Q15 storage added by
  // migration 0071). A small read here keeps the banner self-contained
  // without bloating the F3 entity for a per-tenant flag.
  //
  // Round-4 CRIT-A: routed through `runInTenant` so RLS+FORCE on
  // `members` applies (Constitution Principle I two-layer isolation).
  const ackResult = (await runInTenant(tenant, async (tx) =>
    tx.execute(sql`
      SELECT broadcasts_acknowledged_at
        FROM members
       WHERE tenant_id = ${tenant.slug}
         AND member_id = ${memberId}
       LIMIT 1
    `),
  )) as unknown as Array<{ broadcasts_acknowledged_at: Date | null }>;
  const ack = ackResult[0]?.broadcasts_acknowledged_at ?? null;
  if (ack !== null) {
    return { show: false, memberId };
  }

  // Quota check (cap > 0 means plan includes E-Blast benefit)
  const quotaResult = await computeQuotaCounter(
    makeComputeQuotaDeps(tenant.slug),
    { memberId },
  );
  if (!quotaResult.ok || quotaResult.value.counter.cap === 0) {
    return { show: false, memberId };
  }

  return { show: true, memberId };
}

export async function MarketingAcknowledgementBanner(): Promise<React.ReactElement | null> {
  const eligibility = await checkEligibility();
  if (!eligibility.show) return null;

  const t = await getTranslations(
    'portal.broadcasts.banner.acknowledgement',
  );
  // Pass the server-resolved locale (next-intl `getLocale()`) as a
  // prop so the consent record reflects what the user actually saw —
  // not whatever `document.documentElement.lang` happens to be when
  // the click handler fires (GDPR Art. 7 demonstrable consent).
  const locale = await getLocale();
  const ackLocale: 'en' | 'th' | 'sv' =
    locale === 'th' || locale === 'sv' ? locale : 'en';
  // UX-5 — surface tenant Privacy Policy URL when configured. Prop
  // omitted when env is unset so the client gracefully renders no
  // link (vs a dead `<a href="">`).
  const privacyPolicyUrl = env.broadcasts.privacyPolicyUrl ?? null;
  return (
    <AcknowledgementBannerClient
      title={t('title')}
      body={t('body')}
      acknowledge={t('acknowledge')}
      remindLater={t('remindLater')}
      locale={ackLocale}
      privacyPolicyUrl={privacyPolicyUrl}
      privacyPolicyLinkLabel={t('privacyPolicyLink')}
    />
  );
}
