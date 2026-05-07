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
import { getFormatter, getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
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
  const tStatus = await getTranslations('portal.renewal.success.cycleStatusValue');
  // I16 review-fix: use next-intl formatter for locale-aware date
  // display (TH applies Buddhist Era; SV/EN use Gregorian) instead of
  // raw `.slice(0, 10)` ISO truncation.
  const formatter = await getFormatter();

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
    <DetailContainer>
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
                {formatter.dateTime(new Date(activeCycle.expiresAt), {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </time>
            </dd>
            <dt className="text-muted-foreground">{t('cycleStatus')}</dt>
            <dd>{tStatus(activeCycle.status)}</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t('processing')}</p>
        )}
      </section>

      {/* S-4 review-fix: primary nav action uses Button (≥36px hit
          area per WCAG 2.5.8) instead of plain underline link. Receipt
          download stays as a link — secondary action. */}
      <div className="flex flex-wrap items-center gap-3">
        {invoiceId && (
          <Link
            href={`/portal/invoices/${invoiceId}/pdf`}
            className="text-sm underline"
            data-testid="receipt-download-link"
          >
            {t('downloadReceipt')}
          </Link>
        )}
        <Link
          href="/portal"
          // S-4 review-fix: button-shaped link for primary nav so the
          // hit area meets WCAG 2.5.8 (≥36px). Base UI Button doesn't
          // support `asChild`, so we mirror the `outline` variant
          // styling on a Link directly.
          className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:border-input dark:bg-input/30 dark:hover:bg-input/50"
        >
          {t('backToPortal')}
        </Link>
      </div>
    </DetailContainer>
  );
}
