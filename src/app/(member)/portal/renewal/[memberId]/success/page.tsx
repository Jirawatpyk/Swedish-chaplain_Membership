/**
 * F8 Phase 5 Wave C · T131 — `/portal/renewal/[memberId]/success` page.
 *
 * Landing page after F5 payment success redirects back. Shows the new
 * `expires_at` and links to download the receipt PDF.
 *
 * Auth: requireSession('member'). Cross-member guard — URL [memberId]
 * MUST match session-member's memberId.
 *
 * i18n: strings under `portal.renewal.success.*` in EN/TH/SV.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { makeRenewalsDeps } from '@/modules/renewals';

export default async function RenewalSuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ memberId: string }>;
  searchParams: Promise<{ invoice?: string }>;
}) {
  const { memberId: urlMemberId } = await params;
  const { invoice: invoiceId } = await searchParams;
  const { user } = await requireSession('member');
  const tenant = resolveTenantFromRequest();
  const t = await getTranslations('portal.renewal.success');

  const membersDeps = buildMembersDeps(tenant);
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(
    tenant,
    user.id,
  );
  if (!memberLookup.ok) {
    logger.warn(
      { tenantId: tenant.slug, userId: user.id },
      '[renewal-success-page] no member linked to session user',
    );
    notFound();
  }
  if (memberLookup.value.memberId !== urlMemberId) {
    notFound();
  }

  const renewalsDeps = makeRenewalsDeps(tenant.slug);
  const activeCycle = await renewalsDeps.cyclesRepo.findActiveForMember(
    tenant.slug,
    urlMemberId,
  );

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>

      <section
        aria-labelledby="renewal-details-heading"
        className="rounded-lg border bg-card p-4"
      >
        <h2
          id="renewal-details-heading"
          className="mb-3 text-lg font-medium"
        >
          {t('detailsHeading')}
        </h2>
        {activeCycle ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t('newExpiry')}</dt>
            <dd>
              <time dateTime={activeCycle.expiresAt}>
                {activeCycle.expiresAt.slice(0, 10)}
              </time>
            </dd>
            <dt className="text-muted-foreground">{t('cycleStatus')}</dt>
            <dd>{activeCycle.status}</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t('processing')}</p>
        )}
      </section>

      <div className="flex flex-wrap gap-3">
        {invoiceId && (
          <Link
            href={`/portal/invoices/${invoiceId}/pdf`}
            className="text-sm underline"
            data-testid="receipt-download-link"
          >
            {t('downloadReceipt')}
          </Link>
        )}
        <Link href="/portal" className="text-sm underline">
          {t('backToPortal')}
        </Link>
      </div>
    </main>
  );
}
