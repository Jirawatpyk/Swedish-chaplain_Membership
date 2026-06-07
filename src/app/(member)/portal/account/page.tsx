import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
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
 * Sectioned IA: five anchored, self-titled cards that the account-menu
 * deep-links into (`#account`, `#language`, `#renewal-prefs`,
 * `#data-privacy`, `#appearance`). Each card carries its own `<h2>`
 * title INSIDE its CardHeader (mirroring `benefit-usage-card.tsx`), so
 * there is no empty pt-6 top-space above the content. Consolidates what
 * were previously separate pages (`/portal/preferences/renewals`,
 * `/portal/account/data-export`) into one scroll-anchored hub:
 *
 *   - Account (`#account`): email + inline ChangePasswordForm (DECISION
 *     C: keep inline) + "Forgot your password?" → /forgot-password.
 *   - Preferred language (`#language`): PreferredLocaleForm with an
 *     SSR-seeded `initialValue` (the locale form's title moves into the
 *     card's CardHeader; its description stays in the body).
 *   - Renewal preferences (`#renewal-prefs`): RenewalRemindersToggle
 *     with an SSR-seeded `initialOptedOut`.
 *   - Data & privacy (`#data-privacy`, f9-gated): DataExportPanel
 *     seeded from `listMemberDataExports`.
 *   - Appearance (`#appearance`): ThemeToggle + PortalSignOutButton.
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
 * One self-titled hub card. Renders the scroll-anchored `<section>` + a
 * `<Card>` whose `<CardHeader>` carries a real `<h2>` title (NOT the shadcn
 * `CardTitle` <div>, so the heading lands in the SR heading tree — mirrors the
 * `benefit-usage-card.tsx` 056 fix #1) and a `<CardContent>` body. The title
 * lives INSIDE the card so there is no empty top-space above the content.
 *
 * Derives the h2 `id` from the section `id` (`${id}-heading`) and reuses it for
 * `aria-labelledby` so the heading↔section pairing can't drift across the five
 * cards. The CONDITIONAL wrapping (`{memberId ? ... : null}`, the f9 gate)
 * stays at the call site — this helper only renders the card chrome, never the
 * gate. `contentClassName` tunes the per-card body layout (spacing / flex).
 */
function HubCard({
  id,
  title,
  contentClassName,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly contentClassName?: string;
  readonly children: React.ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="scroll-mt-24"
    >
      <Card>
        <CardHeader>
          <h2
            id={headingId}
            className="font-heading text-base font-medium leading-snug"
          >
            {title}
          </h2>
        </CardHeader>
        <CardContent className={contentClassName}>{children}</CardContent>
      </Card>
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

      <HubCard
        id="account"
        title={tPage('sections.account')}
        contentClassName="space-y-4"
      >
        <p className="text-sm text-muted-foreground">{user.email}</p>
        <ChangePasswordForm />
        <Link
          href="/forgot-password"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          {tPage('forgotPassword')}
        </Link>
      </HubCard>

      {/*
        Preferred language: the locale form's `title` moves UP into the card's
        CardHeader h2 (don't duplicate it in the body); the `description` muted
        line stays in the body above the form. Always rendered (a member is not
        required to choose a notification language).
      */}
      <HubCard
        id="language"
        title={tLocale('title')}
        contentClassName="space-y-2"
      >
        <p className="text-sm text-muted-foreground">{tLocale('description')}</p>
        <PreferredLocaleForm initialValue={initialLocale} />
      </HubCard>

      {/*
        Renewal preferences + Data & privacy are MEMBER-SPECIFIC: their writes
        target the session-resolved member row. An authenticated user with NO
        linked member (e.g. a pending invitation) has memberId === null — the
        toggle's POST and the export request would 404. Mirror the legacy
        per-route notFound() at the section level: hide these when unlinked,
        but keep Account + Appearance (which work without a member).
      */}
      {memberId ? (
        <HubCard id="renewal-prefs" title={tPage('sections.renewalPrefs')}>
          <RenewalRemindersToggle initialOptedOut={initialOptedOut} />
        </HubCard>
      ) : null}

      {env.features.f9Dashboard && memberId ? (
        <HubCard
          id="data-privacy"
          title={tPage('sections.dataPrivacy')}
          contentClassName="space-y-4"
        >
          <p className="max-w-prose text-sm text-muted-foreground">
            {tExport('description')}
          </p>
          <DataExportPanel
            rows={buildDataExportRows(exportJobs, tExport, locale)}
            labels={buildDataExportLabels(tExport)}
          />
        </HubCard>
      ) : null}

      <HubCard
        id="appearance"
        title={tPage('sections.appearance')}
        contentClassName="flex flex-wrap items-center justify-between gap-3"
      >
        {/* icon-lg (36px) so the toggle height matches the 36px sign-out button. */}
        <ThemeToggle size="icon-lg" />
        <PortalSignOutButton />
      </HubCard>
    </FormContainer>
  );
}
