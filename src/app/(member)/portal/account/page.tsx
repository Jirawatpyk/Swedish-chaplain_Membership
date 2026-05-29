import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { env } from '@/lib/env';
import { ChangePasswordForm } from '@/components/auth/change-password-form';
import { PreferredLocaleForm } from '@/components/portal/preferred-locale-form';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { getMemberPreferredLocale, f3DrizzleMemberRepo } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';

/**
 * Member account settings page (T154 mirror) at URL `/portal/account`.
 *
 * Same content as the staff version (`ChangePasswordForm`) with
 * member-portal chrome. Reuses the localised strings.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.account');
  return { title: t('title') };
}

export default async function MemberAccountPage() {
  const { user } = await requireSession('member');
  const tPage = await getTranslations('portal.account');
  const t = await getTranslations('auth.changePassword');
  const tLocale = await getTranslations('portal.preferredLocale');
  const tShell = await getTranslations('shell.roleBadge');
  const tExport = await getTranslations('dataExport');

  // SSR-seed PreferredLocaleForm to eliminate the client-side
  // GET-on-mount waterfall (was causing in-card Skeleton flash on
  // refresh). Best-effort: if member lookup or repo throws we leave
  // initialValue undefined and the form falls back to its own fetch.
  const tenant = resolveTenantFromRequest();
  const membersDeps = buildMembersDeps(tenant);
  let initialLocale: 'en' | 'th' | 'sv' | null | undefined;
  try {
    const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(
      tenant,
      user.id,
    );
    if (memberLookup.ok) {
      const localeResult = await getMemberPreferredLocale(
        { tenant, memberRepo: f3DrizzleMemberRepo },
        memberLookup.value.memberId,
      );
      if (localeResult.ok) {
        initialLocale = localeResult.value;
      } else {
        logger.warn(
          { err: localeResult.error, tenantId: tenant.slug, userId: user.id },
          'portal.account.preferred_locale_lookup_failed',
        );
      }
    }
  } catch (err) {
    logger.warn(
      { err, tenantId: tenant.slug, userId: user.id },
      'portal.account.preferred_locale_seed_failed',
    );
  }

  return (
    <FormContainer>
      <PageHeader
        title={tPage('title')}
        subtitle={tPage('subtitle')}
        badge={<Badge variant="outline">{tShell(user.role)}</Badge>}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>
            {t('description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tLocale('title')}</CardTitle>
          <CardDescription>{tLocale('description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <PreferredLocaleForm initialValue={initialLocale} />
        </CardContent>
      </Card>

      {env.features.f9Dashboard ? (
        <Card>
          <CardHeader>
            <CardTitle>{tExport('title')}</CardTitle>
            <CardDescription>{tExport('subtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/portal/account/data-export"
              className={buttonVariants({ variant: 'outline' })}
            >
              {tExport('open')}
            </Link>
          </CardContent>
        </Card>
      ) : null}
    </FormContainer>
  );
}
