import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { env } from '@/lib/env';
import { runInTenant } from '@/lib/db';
import { buildDataExportRows } from '@/components/data-export/data-export-view-model';
// F114 FR-004 / R6 — the contact's OWN email language (Group A) lives here, in the view.
import { DetailContainer } from '@/components/layout';
import { renderPortalAccountView } from '@/components/portal/portal-account-view';
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

/**
 * Member account hub (G2 / D2 redesign) at URL `/portal/account`.
 *
 * Sectioned IA: four anchored, self-titled cards that the account-menu
 * deep-links into (`#account`, `#language`, `#renewal-prefs`,
 * `#data-privacy`). Each card carries its own `<h2>`
 * title INSIDE its CardHeader (mirroring `benefit-usage-card.tsx`), so
 * there is no empty pt-6 top-space above the content. Consolidates what
 * were previously separate pages (`/portal/preferences/renewals`,
 * `/portal/account/data-export`) into one scroll-anchored hub:
 *
 *   - Account (`#account`): email + inline ChangePasswordForm (DECISION
 *     C: keep inline) + "Forgot your password?" → /forgot-password +
 *     Sign out (023 option B: folded in here; the standalone theme/sign-out
 *     card was removed as the theme toggle duplicated the header + UserMenu).
 *   - Preferred language (`#language`): PreferredLocaleForm with an
 *     SSR-seeded `initialValue` (the locale form's title moves into the
 *     card's CardHeader; its description stays in the body).
 *   - Renewal preferences (`#renewal-prefs`): RenewalRemindersToggle
 *     with an SSR-seeded `initialOptedOut`.
 *   - Data & privacy (`#data-privacy`, f9-gated): DataExportPanel
 *     seeded from `listMemberDataExports`.
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
  // F114 — the caller's own contact language (Group A). `null` = no linked
  // contact (the form is then not rendered).
  let contactLanguage: 'en' | 'th' | 'sv' | null = null;
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

      // F114 — the caller's own contact row carries the email language.
      try {
        const contactsResult = await membersDeps.contactRepo.listByMember(tenant, linkedMemberId);
        if (contactsResult.ok) {
          const own = contactsResult.value.find((c) => String(c.linkedUserId) === user.id && !c.removedAt);
          contactLanguage = own?.preferredLanguage ?? null;
        } else {
          // the Result arm of the same fault the catch below logs (round 6,
          // silent-failure #7): without it "read failed" and "not linked"
          // both hid the language form with no trace
          logger.warn(
            { err: contactsResult.error.code, tenantId: tenant.slug, userIdHash: hashId(user.id) },
            'portal.account.contact_language_read_failed',
          );
        }
      } catch (err) {
        logger.warn(
          { errKind: errKind(err), tenantId: tenant.slug, userIdHash: hashId(user.id) },
          'portal.account.contact_language_read_failed',
        );
      }

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
  // NOT 500 the whole hub (the doc-comment promise). A read FAULT is its own
  // state (`role=status` "could not load your exports"), never the empty
  // state that says "you have not requested one" — the profile page's
  // `ownRequestReadFailed` rule (PR-3 polish, silent S-6).
  let exportJobs: Awaited<ReturnType<typeof listMemberDataExports>> = [];
  let exportsReadFailed = false;
  if (env.features.f9Dashboard && memberId) {
    try {
      // only the archives THIS person requested — a colleague's file is scoped
      // to the colleague (F114 FR-029; review round 1, C1)
      exportJobs = await listMemberDataExports(tenant, memberId, { requestedBy: user.id });
    } catch (err) {
      exportsReadFailed = true;
      logger.error(
        {
          errorId: 'M114.portal.account.exports_read_failed',
          // `err`, the house field name for an error kind (C6) — the four
          // older `errKind:` lines in this file predate F114 and are left as
          // they are; this is the only one PR-3 added.
          err: errKind(err),
          tenantId: tenant.slug,
          userIdHash: hashId(user.id),
        },
        'portal.account.data_export_list_failed',
      );
    }
  }

  return (
    // The board's 880px column, centred like the edit page's (header and cards together).
    <DetailContainer className="max-w-[calc(55rem+2*var(--page-padding-x))]">
      {await renderPortalAccountView({
    email: user.email,
    roleLabel: tShell(user.role),
    initialLocale,
    contactLanguage,
    hasMember: memberId !== null,
    initialOptedOut,
    showDataPrivacy: env.features.f9Dashboard && memberId !== null,
    exportsReadFailed,
    exportRows: buildDataExportRows(exportJobs, tExport, locale),
    privacyContactEmail: env.broadcasts.privacyContactEmail ?? null,
    privacyPolicyUrl: env.broadcasts.privacyPolicyUrl ?? null,
      })}
    </DetailContainer>
  );
}
