import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { ComposeForm } from '@/components/broadcast/compose-form';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  computeQuotaCounter,
  makeComputeQuotaDeps,
} from '@/modules/broadcasts';
import { buildMembersDeps } from '@/modules/members/members-deps';

/**
 * T079 — Compose page (server component).
 *
 * - Resolves the signed-in member via session + F3 lookup
 * - Computes initial quota snapshot for SSR-rendered <QuotaDisplay />
 * - Loads existing draft (if `?draftId=...`) for resume flow (deferred
 *   to a follow-up — MVP creates fresh drafts only)
 * - Passes everything to the client `<ComposeForm />`
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.broadcasts.compose');
  return { title: t('title') };
}

export default async function ComposeBroadcastPage(): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.compose');
  const session = await requireSession('member');

  const tenant = resolveTenantFromRequest();

  // Resolve linked member to seed the quota counter
  const membersDeps = buildMembersDeps(tenant);
  let initialQuota = null;
  try {
    const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(
      tenant,
      session.user.id,
    );
    if (memberLookup.ok) {
      const quotaResult = await computeQuotaCounter(
        makeComputeQuotaDeps(tenant.slug),
        { memberId: memberLookup.value.memberId },
      );
      if (quotaResult.ok) {
        initialQuota = {
          used: quotaResult.value.counter.used,
          reserved: quotaResult.value.counter.reserved,
          remaining: quotaResult.value.counter.remaining,
          cap: quotaResult.value.counter.cap,
          quotaYear: quotaResult.value.quotaYear,
        };
      }
    }
  } catch {
    // Fall through — client component will fetch /api/broadcasts/quota
    initialQuota = null;
  }

  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <ComposeForm initialQuota={initialQuota} />
    </FormContainer>
  );
}
