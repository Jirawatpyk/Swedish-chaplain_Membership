import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { env } from '@/lib/env';
import { runInTenant } from '@/lib/db';
import { ChangePasswordForm } from '@/components/auth/change-password-form';
import { PreferredLocaleForm } from '@/components/portal/preferred-locale-form';
import { PortalSignOutButton } from '@/components/portal/portal-sign-out-button';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { DataExportPanel } from '@/components/data-export/data-export-panel';
import {
  buildDataExportLabels,
  buildDataExportRows,
} from '@/components/data-export/data-export-view-model';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import {
  getMemberPreferredLocale,
  f3DrizzleMemberRepo,
  type MemberId,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { makeRenewalsDeps } from '@/modules/renewals';
import { listMemberDataExports } from '@/modules/insights';
import { RenewalRemindersToggle } from '../preferences/renewals/_components/renewal-reminders-toggle';

/**
 * Member account hub (G2 / D2 redesign) at URL `/portal/account`.
 *
 * Sectioned IA: four anchored `<h2>` sections that the account-menu
 * deep-links into (`#account`, `#renewal-prefs`, `#data-privacy`,
 * `#appearance`). Consolidates what were previously separate pages
 * (`/portal/preferences/renewals`, `/portal/account/data-export`) into
 * one scroll-anchored hub:
 *
 *   - Account: email + inline ChangePasswordForm (DECISION C: keep
 *     inline) + "Forgot your password?" → /forgot-password +
 *     PreferredLocaleForm.
 *   - Renewal preferences (`#renewal-prefs`): RenewalRemindersToggle
 *     with an SSR-seeded `initialOptedOut`.
 *   - Data & privacy (`#data-privacy`, f9-gated): DataExportPanel
 *     seeded from `listMemberDataExports`.
 *   - Appearance: ThemeToggle + PortalSignOutButton.
 *
 * memberId is ALWAYS resolved from the session via
 * `findByLinkedUserId(tenant, user.id)` — never a URL param (RLS).
 * The SSR seed reads are best-effort: a repo hiccup logs + falls back
 * to safe defaults so the hub never 500s.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.account');
  return { title: t('title') };
}

export default async function MemberAccountPage() {
  const { user } = await requireSession('member');
  const tPage = await getTranslations('portal.account');
  const tLocale = await getTranslations('portal.preferredLocale');
  const tShell = await getTranslations('shell.roleBadge');
  const tExport = await getTranslations('dataExport');
  const locale = await getLocale();

  const tenant = resolveTenantFromRequest();
  const membersDeps = buildMembersDeps(tenant);

  // SSR-seed the hub from the session-resolved member. Each read is
  // best-effort: any failure logs + falls back so the page still
  // renders (PreferredLocaleForm re-fetches; the toggle defaults to
  // not-opted-out; the export panel shows the empty state).
  let initialLocale: 'en' | 'th' | 'sv' | null | undefined;
  let initialOptedOut = false;
  let memberId: MemberId | null = null;
  try {
    const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(
      tenant,
      user.id,
    );
    if (memberLookup.ok) {
      memberId = memberLookup.value.memberId;

      const localeResult = await getMemberPreferredLocale(
        { tenant, memberRepo: f3DrizzleMemberRepo },
        memberId,
      );
      if (localeResult.ok) {
        initialLocale = localeResult.value;
      } else {
        logger.warn(
          { err: localeResult.error, tenantId: tenant.slug, userId: user.id },
          'portal.account.preferred_locale_lookup_failed',
        );
      }

      // F3 Member entity does not expose the F8-owned
      // `renewal_reminders_opted_out` column, so the seed goes through
      // the F8 MemberRenewalFlagsRepo port (mirrors the legacy
      // /portal/preferences/renewals page).
      const renewalsDeps = makeRenewalsDeps(tenant.slug);
      initialOptedOut =
        (await runInTenant(tenant, (tx) =>
          renewalsDeps.memberRenewalFlagsRepo.readRenewalRemindersOptedOut(
            tx,
            tenant.slug,
            memberId!,
          ),
        )) ?? false;
    }
  } catch (err) {
    logger.warn(
      { err, tenantId: tenant.slug, userId: user.id },
      'portal.account.hub_seed_failed',
    );
  }

  const exportJobs =
    env.features.f9Dashboard && memberId
      ? await listMemberDataExports(tenant, memberId)
      : [];

  return (
    <FormContainer>
      <PageHeader
        title={tPage('title')}
        subtitle={tPage('subtitle')}
        badge={<Badge variant="outline">{tShell(user.role)}</Badge>}
      />

      <section
        id="account"
        aria-labelledby="account-heading"
        className="scroll-mt-24 space-y-4"
      >
        <h2 id="account-heading" className="text-lg font-semibold">
          {tPage('sections.account')}
        </h2>
        <Card>
          <CardContent className="space-y-4 pt-6">
            <p className="text-sm text-muted-foreground">{user.email}</p>
            <ChangePasswordForm />
            <Link
              href="/forgot-password"
              className="text-sm text-primary underline-offset-4 hover:underline"
            >
              {tPage('forgotPassword')}
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 pt-6">
            <p className="text-sm font-medium">{tLocale('title')}</p>
            <p className="text-sm text-muted-foreground">
              {tLocale('description')}
            </p>
            <PreferredLocaleForm initialValue={initialLocale} />
          </CardContent>
        </Card>
      </section>

      <section
        id="renewal-prefs"
        aria-labelledby="renewal-prefs-heading"
        className="scroll-mt-24 space-y-4"
      >
        <h2 id="renewal-prefs-heading" className="text-lg font-semibold">
          {tPage('sections.renewalPrefs')}
        </h2>
        <Card>
          <CardContent className="pt-6">
            <RenewalRemindersToggle initialOptedOut={initialOptedOut} />
          </CardContent>
        </Card>
      </section>

      {env.features.f9Dashboard ? (
        <section
          id="data-privacy"
          aria-labelledby="data-privacy-heading"
          className="scroll-mt-24 space-y-4"
        >
          <h2 id="data-privacy-heading" className="text-lg font-semibold">
            {tPage('sections.dataPrivacy')}
          </h2>
          <Card>
            <CardContent className="space-y-4 pt-6">
              <p className="max-w-prose text-sm text-muted-foreground">
                {tExport('description')}
              </p>
              <DataExportPanel
                rows={buildDataExportRows(exportJobs, tExport, locale)}
                labels={buildDataExportLabels(tExport)}
              />
            </CardContent>
          </Card>
        </section>
      ) : null}

      <section
        id="appearance"
        aria-labelledby="appearance-heading"
        className="scroll-mt-24 space-y-4"
      >
        <h2 id="appearance-heading" className="text-lg font-semibold">
          {tPage('sections.appearance')}
        </h2>
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
            <ThemeToggle />
            <PortalSignOutButton />
          </CardContent>
        </Card>
      </section>
    </FormContainer>
  );
}
