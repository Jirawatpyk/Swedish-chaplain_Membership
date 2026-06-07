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
import { errKind, hashId, rootCause } from '@/lib/log-id';
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

/**
 * Inner chrome for one anchored hub section. Derives the h2 `id` from the
 * section `id` (`${id}-heading`) and reuses it for `aria-labelledby` so the
 * heading↔section pairing can't drift across the four sections. The
 * CONDITIONAL wrapping (`{memberId ? ... : null}`, the f9 gate) stays at the
 * call site — this helper only renders the section/heading/spacing chrome,
 * never the gate.
 */
function HubSection({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="scroll-mt-24 space-y-4"
    >
      <h2 id={headingId} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
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
      // Capture the branded id in a local so downstream seeds don't need a
      // non-null assertion on the outer `memberId` (which TS still widens to
      // `MemberId | null` inside the closure).
      const linkedMemberId = memberLookup.value.memberId;
      memberId = linkedMemberId;

      const localeResult = await getMemberPreferredLocale(
        { tenant, memberRepo: f3DrizzleMemberRepo },
        linkedMemberId,
      );
      if (localeResult.ok) {
        initialLocale = localeResult.value;
      } else {
        logger.warn(
          {
            errKind: errKind(rootCause(localeResult.error)),
            tenantId: tenant.slug,
            userIdHash: hashId(user.id),
          },
          'portal.account.preferred_locale_lookup_failed',
        );
      }

      // F3 Member entity does not expose the F8-owned
      // `renewal_reminders_opted_out` column, so the seed goes through
      // the F8 MemberRenewalFlagsRepo port (mirrors the legacy
      // /portal/preferences/renewals page).
      //
      // S-renewal-breadcrumb: this read gets its OWN try/catch with a
      // distinct log key. If it threw under the broad outer catch, the
      // generic `hub_seed_failed` would fire and `initialOptedOut` would
      // silently fall back to `false` — an opted-OUT member would then see
      // the toggle opted-IN with no independently observable signal. Scope
      // the failure here so a regression in the renewal-flags read is
      // alertable on its own log key; degrade to the safe default (false).
      try {
        const renewalsDeps = makeRenewalsDeps(tenant.slug);
        initialOptedOut =
          (await runInTenant(tenant, (tx) =>
            renewalsDeps.memberRenewalFlagsRepo.readRenewalRemindersOptedOut(
              tx,
              tenant.slug,
              linkedMemberId,
            ),
          )) ?? false;
      } catch (err) {
        logger.error(
          {
            errKind: errKind(err),
            tenantId: tenant.slug,
            userIdHash: hashId(user.id),
          },
          'portal.account.renewal_flags_read_failed',
        );
      }
    } else if (memberLookup.error.code !== 'repo.not_found') {
      // A genuine repo/RLS/infra fault (NOT the normal "no portal link"
      // case, which is `repo.not_found` and stays silent below). Log at
      // ERROR so it is alertable — a transient Neon/RLS fault silently drops
      // the Renewal + Data&privacy sections and otherwise looks identical to
      // an unlinked user. The page still degrades gracefully with safe
      // defaults (memberId stays null) — the never-500 contract holds.
      logger.error(
        {
          errKind: errKind(rootCause(memberLookup.error)),
          tenantId: tenant.slug,
          userIdHash: hashId(user.id),
        },
        'portal.account.member_lookup_failed',
      );
    }
  } catch (err) {
    logger.error(
      {
        errKind: errKind(err),
        tenantId: tenant.slug,
        userIdHash: hashId(user.id),
      },
      'portal.account.hub_seed_failed',
    );
  }

  // Best-effort, like the seeds above: a transient Neon/RLS error here must
  // NOT 500 the whole hub (the doc-comment promise). Fall back to [] + warn.
  let exportJobs: Awaited<ReturnType<typeof listMemberDataExports>> = [];
  if (env.features.f9Dashboard && memberId) {
    try {
      exportJobs = await listMemberDataExports(tenant, memberId);
    } catch (err) {
      logger.warn(
        {
          errKind: errKind(err),
          tenantId: tenant.slug,
          userIdHash: hashId(user.id),
        },
        'portal.account.data_export_list_failed',
      );
    }
  }

  return (
    <FormContainer>
      <PageHeader
        title={tPage('title')}
        subtitle={tPage('subtitle')}
        badge={<Badge variant="outline">{tShell(user.role)}</Badge>}
      />

      <HubSection id="account" title={tPage('sections.account')}>
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
      </HubSection>

      {/*
        Renewal preferences + Data & privacy are MEMBER-SPECIFIC: their writes
        target the session-resolved member row. An authenticated user with NO
        linked member (e.g. a pending invitation) has memberId === null — the
        toggle's POST and the export request would 404. Mirror the legacy
        per-route notFound() at the section level: hide these when unlinked,
        but keep Account + Appearance (which work without a member).
      */}
      {memberId ? (
        <HubSection id="renewal-prefs" title={tPage('sections.renewalPrefs')}>
          <Card>
            <CardContent className="pt-6">
              <RenewalRemindersToggle initialOptedOut={initialOptedOut} />
            </CardContent>
          </Card>
        </HubSection>
      ) : null}

      {env.features.f9Dashboard && memberId ? (
        <HubSection id="data-privacy" title={tPage('sections.dataPrivacy')}>
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
        </HubSection>
      ) : null}

      <HubSection id="appearance" title={tPage('sections.appearance')}>
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
            <ThemeToggle />
            <PortalSignOutButton />
          </CardContent>
        </Card>
      </HubSection>
    </FormContainer>
  );
}
