/**
 * T067 — /admin/members/[memberId] detail page (US2 deep-link).
 *
 * Server component — runs the `getMember` use case which emits
 * `member_cross_tenant_probe` on 404 per FR-022. Renders member metadata
 * + contacts grouped primary/secondary + FR-030 copy-to-clipboard
 * affordances on member_id / email / tax_id.
 *
 * Audit timeline lands in US6 (B.4+).
 */

import type { Metadata } from 'next';
import { cache } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations, getFormatter, getLocale } from 'next-intl/server';
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  HelpCircleIcon,
  MailWarningIcon,
  PackageOpenIcon,
  PencilIcon,
  UserPlusIcon,
} from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { headers } from 'next/headers';
import {
  getMember,
  archiveWindowStatus,
  formatMemberNumber,
  resolveMemberNumberPrefix,
} from '@/modules/members';
import type { MemberId, Contact } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
// Pass A · Section 3 — F7 marketing-suppression read (cross-context via the
// broadcasts public barrel; the Drizzle repo wraps queries in runInTenant).
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts';
// S1 — extracted resolver owns the parse + projection + degraded branching.
import { resolveContactSubscriptions } from './_lib/resolve-contact-subscriptions';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { CopyButton } from '@/components/members/copy-button';
import { DetailField } from '@/components/members/detail-field';
import { MemberNumberField } from '@/components/members/member-number-field';
import { CountryDisplay } from '@/components/members/country-display';
import { InvitePortalButton } from '@/components/members/invite-portal-button';
import { ResendBouncedInviteButton } from '@/components/members/resend-bounced-invite-button';
import { ArchivedBanner } from '@/components/members/archived-banner';
import { ArchiveMemberButton } from '@/components/members/archive-member-button';
import { ContactFormDialog } from '@/components/members/contact-form-dialog';
import { ContactActions } from '@/components/members/contact-actions';
import { SubscriptionBadge } from '@/components/members/subscription-badge';
import { Suspense } from 'react';
import { MemberInvoicesSection } from './_components/member-invoices-section';
import { MemberInvoicesSkeleton } from './_components/member-invoices-skeleton';
import { MemberDataExportSection } from './_components/member-data-export-section';
import { MemberDataExportSkeleton } from './_components/member-data-export-skeleton';
import {
  MemberRenewalHealthSection,
  MemberRenewalHealthSkeleton,
} from './_components/member-renewal-health-section';
import {
  MemberBenefitsPreviewSection,
  MemberBenefitsPreviewSkeleton,
} from './_components/member-benefits-preview-section';
import {
  TimelinePreviewSection,
  TimelinePreviewSkeleton,
} from './_components/timeline-preview-section';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  readonly params: Promise<{ memberId: string }>;
  readonly searchParams: Promise<
    Record<string, string | string[] | undefined>
  >;
}

/**
 * P5 round-10 ui-design-specialist — request-scoped cached LIGHT
 * member fetch for `generateMetadata` only. Returns just the
 * `companyName` (the only field the `<title>` template needs).
 *
 * Round-11 review fix — was previously using the full `getMember`
 * use-case with a synthetic `actorUserId: 'server-component'`. That
 * sentinel polluted the audit trail: a cross-tenant probe via
 * `/admin/members/<foreign-uuid>` would emit
 * `member_cross_tenant_probe` attributed to 'server-component' rather
 * than the real admin who clicked the URL. The page component below
 * runs the FULL `getMember` use-case (with `session.user.id`) so the
 * authoritative audit row is still written; this metadata-only path
 * skips audit entirely.
 *
 * Cost: 1 extra `findById` DB round-trip per page load (single-row
 * by PK — negligible). React.cache() still memoises the metadata
 * call so multiple `generateMetadata` retries within the same render
 * pass share the result.
 */
const cachedCompanyNameForTitle = cache(
  async (memberId: string): Promise<string | null> => {
    const h = await headers();
    const pseudoReq = new Request('http://localhost:3100', { headers: h });
    const tenant = resolveTenantFromRequest(pseudoReq as never);
    const deps = buildMembersDeps(tenant);
    const result = await deps.memberRepo.findById(
      tenant,
      memberId as MemberId,
    );
    if (result.ok) return result.value.companyName;
    // Round-12 final-review fix (Finding 1) — emit an ops-level trace
    // on the null-fallback so a future audit-log gap or middleware
    // misconfig that lets unauthenticated traffic reach generateMetadata
    // leaves a debugging breadcrumb. Intentionally NOT a full
    // `member_cross_tenant_probe` audit row (that's the page
    // component's job with the real actor); just an observability
    // signal for SRE.
    logger.debug(
      {
        event: 'metadata_company_name_lookup_failed',
        memberId,
        repoErr: result.error,
      },
      '[F3] cachedCompanyNameForTitle — repo returned err (metadata path falls back to generic title)',
    );
    return null;
  },
);

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { memberId } = await params;
  const tRoot = await getTranslations('admin.members');
  const tDetail = await getTranslations('admin.members.detail');
  // P5 round-10 — fetch the member through the request-scoped
  // `cachedGetMember` so the page component below dedupes the same
  // call (single DB round-trip per request). Falls back to the
  // generic directory title when the member can't be resolved
  // (invalid UUID / missing row / auth fail) so the metadata pipeline
  // never throws — the page component handles the not-found render.
  if (!UUID_RE.test(memberId)) return { title: tRoot('title') };
  const companyName = await cachedCompanyNameForTitle(memberId);
  if (!companyName) return { title: tRoot('title') };
  return {
    title: tDetail('title', { companyName }),
  };
}

/**
 * 056 fix #5 — resolve a free-text `legal_entity_type` (admin types it into
 * a free Input, so the value is NOT a fixed enum) to a localised label.
 * Normalises the stored value to a key (`lower_snake_case`) and looks it up
 * in `legalEntityTypes.*`; falls back to the raw stored value when no key
 * matches (mirrors the `t.has()` guard pattern in timeline-event-item.tsx —
 * a `t()` miss logs a noisy MISSING_MESSAGE, so guard with `.has` first).
 */
function resolveLegalEntityTypeLabel(
  raw: string | null,
  tTypes: Awaited<
    ReturnType<typeof getTranslations<'admin.members.detail.legalEntityTypes'>>
  >,
): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const key = trimmed.toLowerCase().replace(/[\s-]+/g, '_');
  return tTypes.has(key as 'company') ? tTypes(key as 'company') : trimmed;
}

/**
 * 056 fix #1 — section heading rendered as a real `<h2>` (not a CardTitle
 * `<div>`) so every content group is reachable via SR heading navigation
 * under the page `<h1>`. Carries the CardTitle font classes so the visual
 * is unchanged. The `id` is wired to the wrapping `<section aria-labelledby>`.
 */
function SectionHeading({
  id,
  children,
  className,
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2
      id={id}
      className={`font-heading text-base font-medium leading-snug ${className ?? ''}`}
    >
      {children}
    </h2>
  );
}

/**
 * 056 — small uppercase subgroup label inside the Company card (Organisation
 * / Membership). Renders as a `<p>` not a heading: these are visual grouping
 * dividers WITHIN the Company section, not standalone sections, so promoting
 * them to `<h3>` would add noise to the heading tree (the Company `<h2>`
 * already names the section).
 */
function SubGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * H1: StatusBadge now resolves the localised label via the existing
 * `admin.members.directory.filters.status.*` i18n keys rather than
 * rendering the raw enum value ("active" / "inactive" / "archived").
 *
 * This is a Server Component (no 'use client' on the parent page), so
 * `useTranslations` is replaced with the `t` function passed from the
 * page-level `getTranslations` call via prop. We accept a `tStatus`
 * parameter so we don't need a second `getTranslations` call.
 */
function StatusBadge({
  status,
  label,
}: {
  status: 'active' | 'inactive' | 'archived';
  label: string;
}) {
  return (
    <Badge
      variant={
        status === 'active'
          ? 'default'
          : status === 'inactive'
            ? 'secondary'
            : 'outline'
      }
    >
      {label}
    </Badge>
  );
}

type PendingInvitation = {
  /**
   * Migration 0017 narrowed chamber_app's `invitations` visibility to
   * just user_id / consumed_at / expires_at (the `id` column is the
   * raw 7-day token and is owner-role only). The UI therefore knows
   * only the expiry — sufficient for the inline "Expires in N days"
   * badge.
   */
  readonly expiresAt: Date;
  /**
   * Round-11 review fix — precomputed at the page-level (single
   * `Date.now()` call per request) instead of inside ContactBlock,
   * which the react-hooks/purity lint flagged as impure-during-render.
   * Server component still renders once per request so `Date.now()`
   * is conceptually pure here, but the precompute makes the rule
   * happy and centralises the "now" instant for any future
   * snapshot-style consistency requirement.
   */
  readonly daysUntilExpiry: number;
};

function ContactBlock({
  contact,
  memberId,
  pendingInvitation,
  subscribed,
  canWrite,
  locale,
  t,
}: {
  contact: Contact;
  memberId: string;
  pendingInvitation?: PendingInvitation | undefined;
  /**
   * Pass A · Section 3 / S1 — F7 marketing-subscription tri-state. `true`
   * when the contact's email is NOT in `marketing_unsubscribes`; `false`
   * when they have unsubscribed from E-Blasts (PDPA/GDPR); `'unknown'` when
   * the suppression read was degraded (marketing-DB outage) so the badge
   * shows a neutral "Status unavailable" instead of a misleading default.
   * Always rendered as a text label so admins see reachability at a glance.
   */
  subscribed: boolean | 'unknown';
  /** S1-P1-10: false for the read-only manager — hides Invite/Promote/Remove. */
  canWrite: boolean;
  /**
   * FIX 5 (056 polish) — active locale passed from the page-level
   * `getLocale()` call so the pending-invitation badge title renders
   * BE year for th-TH users instead of raw ค.ศ. ISO date.
   */
  locale: string;
  t: Awaited<ReturnType<typeof getTranslations<'admin.members.detail'>>>;
}) {
  // "Invite to portal" is only shown when the contact has an email and
  // is not already linked to an F1 portal account (FR-012 / T056).
  const canInvite = Boolean(contact.email) && !contact.linkedUserId;
  // Round-11 review fix — `daysUntilExpiry` is precomputed at the page
  // level (single `Date.now()` per request) and passed in via the
  // `pendingInvitation` prop.
  const daysUntilExpiry = pendingInvitation?.daysUntilExpiry ?? null;
  // Rendered as a plain flat row (no border, no bg) inside the outer
  // Contacts Card. Multiple contacts are separated by <Separator />
  // elements in the parent CardContent — no nested cards, no visual
  // card-in-card anti-pattern.
  return (
    <div>
      <div className="mb-3 flex flex-row items-start justify-between gap-4">
        {/* Round-11 review fix — badges moved OUT of the <h3> so the
            heading text reads cleanly to screen readers (was producing
            "John Smith Primary Portal linked Expires in 5 days" as a
            single heading-tree node on VoiceOver). Heading + badge
            cluster live in adjacent flex containers, separated by
            `gap-2`. The badge cluster ships its own aria-label so SRs
            still hear the state info after the heading. */}
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">
            {`${contact.firstName} ${contact.lastName}`.trim()}
          </h3>
          <div
            className="flex flex-wrap items-center gap-2"
            aria-label={t('sections.contactStatusBadges')}
          >
            {contact.isPrimary && (
              <Badge variant="default">{t('sections.primary')}</Badge>
            )}
            {contact.linkedUserId && !pendingInvitation && (
              <Badge variant="secondary">{t('portal.linked')}</Badge>
            )}
            {/* C6 round-10 ui-design-specialist — inline pending-
                invitation badge replaces "Portal linked" when the
                user row exists but `consumed_at` is NULL. */}
            {pendingInvitation && daysUntilExpiry !== null && (
              <Badge
                variant="outline"
                className="gap-1 border-amber-600 text-amber-900 dark:border-amber-500 dark:text-amber-100"
                title={t('pendingInvitations.expiresAt', {
                  // FIX 5 — use the shared Buddhist-aware helper so th-TH
                  // users see พ.ศ. (BE) in the hover tooltip, not raw ค.ศ.
                  date: formatLocalisedDate(
                    pendingInvitation.expiresAt.toISOString(),
                    locale,
                    { dateStyle: 'medium' },
                  ),
                })}
              >
                <MailWarningIcon
                  aria-hidden="true"
                  className="size-3"
                />
                <span>
                  {t('pendingInvitations.expiresInDays', {
                    days: daysUntilExpiry,
                  })}
                </span>
              </Badge>
            )}
            {/* F3 spec § Edge Cases — "Invite bounced" warning badge.
                Shown when invite_bounced_at is set (the invitation email
                bounced and was never delivered). Sits alongside the
                pending-invitation badge or alone when the pending row
                has since expired. */}
            {contact.inviteBouncedAt && (
              <Badge
                variant="outline"
                className="gap-1 border-destructive text-destructive dark:border-red-400 dark:text-red-400"
                aria-label={t('inviteBounced.badgeAria')}
              >
                <MailWarningIcon
                  aria-hidden="true"
                  className="size-3"
                />
                <span>{t('inviteBounced.badge')}</span>
              </Badge>
            )}
            {/* Pass A · Section 3 — E-Blast subscription status. Only shown
                for contacts that HAVE an email (no email = no E-Blast
                target, so the badge would be meaningless). */}
            {contact.email && <SubscriptionBadge subscribed={subscribed} />}
          </div>
        </div>
        {/* S1-P1-10: write affordances hidden for the read-only manager. */}
        {canWrite && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canInvite && (
              <InvitePortalButton memberId={memberId} contactId={contact.contactId} />
            )}
            {/* F3 spec § Edge Cases — "Re-send invite" button. Shown when the
                invitation bounced AND the contact still has a linked (pending)
                user. The button calls the resend-invite route, which re-issues
                the invitation email (owner role) then clears the bounce flag. */}
            {contact.inviteBouncedAt && contact.linkedUserId && (
              <ResendBouncedInviteButton memberId={memberId} contactId={contact.contactId} />
            )}
            <ContactActions
              memberId={memberId}
              isPrimary={contact.isPrimary}
              contact={{
                contactId: contact.contactId,
                firstName: contact.firstName,
                lastName: contact.lastName,
                // `contact.email` is a non-null branded Email on the domain
                // aggregate; pass it straight through (the dialog widens it to
                // a plain string for the RHF form value).
                email: contact.email,
                phone: contact.phone ?? null,
                roleTitle: contact.roleTitle ?? null,
                preferredLanguage: contact.preferredLanguage,
              }}
            />
          </div>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
        <DetailField
          label={t('fields.email')}
          value={contact.email}
          extra={
            <CopyButton value={contact.email} label={t('copy.copyEmail')} />
          }
        />
        <DetailField label={t('fields.phone')} value={contact.phone} />
        <DetailField label={t('fields.roleTitle')} value={contact.roleTitle} />
        <DetailField
          label={t('fields.preferredLanguage')}
          value={contact.preferredLanguage.toUpperCase()}
        />
      </dl>
    </div>
  );
}

export default async function MemberDetailPage({
  params,
  searchParams,
}: PageProps) {
  const sp = await searchParams;
  const invStatusRaw = typeof sp.invStatus === 'string' ? sp.invStatus : undefined;
  const invYearRaw = typeof sp.invYear === 'string' ? sp.invYear : undefined;
  const invQRaw = typeof sp.invQ === 'string' ? sp.invQ : undefined;
  const invStatus = invStatusRaw && invStatusRaw !== 'all' ? invStatusRaw : undefined;
  const invYear = (() => {
    if (!invYearRaw || invYearRaw === 'all') return undefined;
    const n = Number.parseInt(invYearRaw, 10);
    return Number.isFinite(n) && n >= 2020 && n <= 2100 ? n : undefined;
  })();
  const invQ = (() => {
    if (!invQRaw) return undefined;
    const trimmed = invQRaw.trim().slice(0, 64);
    return trimmed.length > 0 ? trimmed : undefined;
  })();
  const { memberId } = await params;
  if (!UUID_RE.test(memberId)) notFound();

  const session = await requireSession('staff');
  // S1-P1-10: the read-only `manager` role must not see member write
  // affordances (Edit/Archive/Add-Contact/Invite/Promote/Remove) — they
  // dead-end at the API (route RBAC rejects). Only `admin` may mutate members.
  const canWrite = session.user.role === 'admin';
  const h = await headers();
  // Pseudo-Request lets resolveTenantFromRequest honour the T115t
  // `x-tenant` header override used by throwaway-tenant E2E.
  const pseudoReq = new Request('http://localhost:3100', { headers: h });
  const tenant = resolveTenantFromRequest(pseudoReq as never);
  const requestId = requestIdFromHeaders(h);
  const deps = buildMembersDeps(tenant);

  // Round-11 review fix — call `getMember` use-case directly with the
  // REAL session user as the actor. The earlier React.cache()-shared
  // path attributed `member_cross_tenant_probe` audits to
  // `'server-component'` (a synthetic sentinel from
  // `generateMetadata`). `generateMetadata` now uses a separate light
  // `findById`-only path (`cachedCompanyNameForTitle`) that emits no
  // audit; the authoritative audit row is written here with the
  // correct admin actorUserId.
  const result = await getMember(
    memberId as MemberId,
    { actorUserId: session.user.id, requestId },
    deps,
  );
  const t = await getTranslations('admin.members.detail');
  // 056 fix #5 — free-text legal-entity-type → localised label map.
  const tLegalTypes = await getTranslations(
    'admin.members.detail.legalEntityTypes',
  );
  // H1: status label for StatusBadge — reuse existing directory filter keys
  // rather than duplicating active/inactive/archived strings in a new namespace.
  const tDir = await getTranslations('admin.members.directory');
  // H2: locale-aware number formatter (respects active locale for digit grouping).
  const format = await getFormatter();
  // 056 fix #2 — active locale for the shared Buddhist-aware date helper
  // (`formatLocalisedDate` maps th → th-TH-u-ca-buddhist). NO raw .toISOString()
  // in display; storage stays Gregorian ISO.
  const locale = await getLocale();

  if (!result.ok) {
    if (result.error.type === 'not_found') {
      return (
        <DetailContainer>
          <Card>
            <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
              <h2 className="text-h2 text-xl font-semibold">
                {t('notFound.title')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('notFound.description')}
              </p>
              <Link
                href="/admin/members"
                className={buttonVariants({ variant: 'outline' })}
              >
                <ArrowLeftIcon className="size-4" />
                {t('notFound.cta')}
              </Link>
            </CardContent>
          </Card>
        </DetailContainer>
      );
    }
    // Generic server error — log with full context for ops, throw a
    // sanitised message so the route-level error.tsx boundary and any
    // leaked stack trace don't expose internal detail to the client.
    logger.error(
      { requestId, err: result.error, memberId },
      'admin.members.detail.getMember_failed',
    );
    throw new Error('admin.members.detail: getMember failed');
  }

  const { member, contacts } = result.value;
  const primary = contacts.find((c) => c.isPrimary && c.removedAt === null);
  const secondary = contacts.filter(
    (c) => !c.isPrimary && c.removedAt === null,
  );

  // These reads are independent (all inputs are available after getMember)
  // and each hits Singapore — running them sequentially cost serial RTTs.
  // Promise.all collapses them to ~1 RTT. Each read keeps its own failure
  // mode: pending-invitations + unsubscribed downgrade to empty sets
  // (self-contained try/catch, never reject), getPlan/getPrefix fall back to
  // the slug / column DEFAULT respectively.
  const [
    pendingInvitationsByContactId,
    planLookup,
    memberPrefix,
    subscriptionResult,
  ] = await Promise.all([
      // C6 round-10 ui-design-specialist — fetch pending portal invitations
      // and project as a Map<contactId, invitation> so each ContactBlock can
      // render its own inline badge. Failures downgrade to an empty Map (no
      // badges shown) — never blocks the page render.
      (async (): Promise<Map<string, PendingInvitation>> => {
        try {
          const pendingRes =
            await deps.memberRepo.findPendingInvitationsForMember(
              tenant,
              member.memberId,
            );
          if (pendingRes.ok) {
            // Round-11 review fix — compute `daysUntilExpiry` once per
            // request rather than inside ContactBlock. Server component
            // renders once per HTTP request so `Date.now()` returns a single
            // stable value for the duration of this render pass — the
            // react-hooks/purity rule's general concern (re-render
            // instability) does not apply to RSC. Disable inline.
            // eslint-disable-next-line react-hooks/purity -- RSC: single render per request
            const nowMs = Date.now();
            const dayMs = 1000 * 60 * 60 * 24;
            return new Map(
              pendingRes.value.map((row) => [
                row.contactId,
                {
                  expiresAt: row.expiresAt,
                  daysUntilExpiry: Math.max(
                    0,
                    Math.ceil((row.expiresAt.getTime() - nowMs) / dayMs),
                  ),
                },
              ]),
            );
          }
          logger.warn(
            { event: 'pending_invitations_repo_err', err: pendingRes.error, memberId },
            '[F3] pending-invitations repo returned err — falling back to empty map',
          );
          return new Map<string, PendingInvitation>();
        } catch (e) {
          logger.error(
            {
              event: 'pending_invitations_threw',
              // errKind logs only the error class name — never e.message
              // (Postgres errors carry SQL params; Upstash errors carry keys).
              errKind: errKind(e),
              memberId,
            },
            '[F3] pending-invitations fetch threw — falling back to empty map',
          );
          return new Map<string, PendingInvitation>();
        }
      })(),
      // Resolve plan display name via PlanLookupPort (single-plan fetch, no
      // listPlans). Falls back to the slug if the plan row is missing
      // (defensive — shouldn't happen for an active member, but keeps the
      // page resilient to data drift).
      deps.plans.getPlan(tenant, member.planId, member.planYear),
      // 055-member-number — resolve the per-tenant prefix via the RLS-safe
      // shared helper (never raw db). Falls back to 'M' (the column DEFAULT
      // for tenants provisioned before the settings seed — no visible error).
      resolveMemberNumberPrefix(tenant, deps.memberSettings),
      // Pass A · Section 3 / S1 — F7 marketing-suppression status per contact.
      // Batch-look-up every non-removed contact email against
      // `marketing_unsubscribes` (RLS-safe: the repo wraps `lookupBatch` in
      // runInTenant). Returns a DISCRIMINATED result: on success a Set of
      // UNSUBSCRIBED contact ids; on a marketing-DB outage `{ degraded:
      // true }` so each badge renders a neutral "Status unavailable" state
      // instead of silently defaulting to "Subscribed" (UI-honesty fix — NOT
      // a compliance change: the dispatch boundary always re-resolves
      // suppression before any send). Resolver extracted to `_lib` so the
      // fail-open / fail-degraded branching is unit-testable without live
      // Neon.
      resolveContactSubscriptions({
        contacts,
        memberId,
        lookupBatch: (emailLowers) =>
          makeDrizzleMarketingUnsubscribesRepo(tenant.slug).lookupBatch(
            tenant.slug,
            emailLowers,
          ),
        logger,
        errKind,
      }),
    ]);

  // S1 — derive each contact's tri-state subscription from the discriminated
  // result. On a degraded read every contact resolves to 'unknown' (neutral
  // "Status unavailable" badge); otherwise `subscribed = !unsubscribed.has(id)`.
  const subscriptionFor = (contactId: string): boolean | 'unknown' =>
    subscriptionResult.degraded
      ? 'unknown'
      : !subscriptionResult.unsubscribed.has(contactId);

  const planDisplayName = planLookup.ok
    ? planLookup.value.planNameEn
    : member.planId;

  const memberNumberDisplay = formatMemberNumber(memberPrefix, member.memberNumber);

  const windowStatus =
    member.status === 'archived' && member.archivedAt
      ? archiveWindowStatus(member.archivedAt, new Date())
      : null;

  const legalEntityLabel = resolveLegalEntityTypeLabel(
    member.legalEntityType,
    tLegalTypes,
  );

  // Compute once so the JSX below can conditionally switch between a 2-col
  // grid (Renewal + Benefits side-by-side) and full-width Renewal alone.
  // Benefits only shows when the F9 flag is on AND the actor is admin/manager.
  const showBenefitsPreview =
    env.features.f9Dashboard &&
    (session.user.role === 'admin' || session.user.role === 'manager');

  return (
    <DetailContainer>
      <PageHeader
        title={member.companyName}
        /* 056 layout C — surface status + member number ABOVE the fold in the
           header badge slot (justified duplication of the values also shown in
           the Company grid). */
        badge={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              status={member.status}
              label={tDir(`filters.status.${member.status}`)}
            />
            <Badge variant="outline" className="font-mono">
              {memberNumberDisplay}
            </Badge>
          </div>
        }
        /* C2 round-10 ui-design-specialist — previous subtitle was the
           generic directory blurb ("Manage chamber members…") which made
           every member detail page look identical. Now: "{Plan} · Year
           {year}" — the two attributes admins actually want to see
           below the company name. Switches to "…  · Archived" when the
           member is archived. */
        subtitle={
          member.status === 'archived'
            ? t('subtitleArchived', {
                plan: planDisplayName,
                year: member.planYear,
              })
            : t('subtitle', {
                plan: planDisplayName,
                year: member.planYear,
              })
        }
        actions={
          <>
            {/* "Back to members" button removed per ux-standards.md § 11/19
              * — the global BreadcrumbNav (admin/layout.tsx) already exposes
              * back navigation. The "Recent activity" action was also removed
              * (056 layout C) — it duplicated the Timeline card's "View all";
              * the Timeline card stays. */}
            {/* Pass A · Section 2 — link to the (previously orphaned)
              * benefits page. F9-gated, mirroring the benefits feature flag.
              * Staff-only is implicit (whole route requires a staff session). */}
            {env.features.f9Dashboard && (
              <Link
                href={`/admin/members/${member.memberId}/benefits`}
                className={buttonVariants({ variant: 'outline' })}
              >
                <PackageOpenIcon className="size-4" />
                {t('sections.benefits')}
              </Link>
            )}
            {canWrite && member.status !== 'archived' && (
              <>
                {/* Destructive action sits LEFT of the primary — Fitts's
                    Law: rightmost button is easiest to click, so Edit
                    (primary + frequent) stays rightmost and Archive
                    (destructive) is one step further from the natural
                    click target. Matches GitHub/Stripe admin convention. */}
                <ArchiveMemberButton
                  memberId={member.memberId}
                  companyName={member.companyName}
                />
                <Link
                  href={`/admin/members/${member.memberId}/edit`}
                  className={buttonVariants()}
                >
                  <PencilIcon className="size-4" />
                  {t('editCta')}
                </Link>
              </>
            )}
          </>
        }
      />

      {member.status === 'archived' &&
          member.archivedAt &&
          windowStatus &&
          (windowStatus.state === 'within_window' ||
            windowStatus.state === 'window_expired') && (
            <ArchivedBanner
              memberId={member.memberId}
              archivedAtIso={member.archivedAt.toISOString()}
              windowStatus={windowStatus}
            />
          )}
        <section aria-labelledby="member-company-heading">
        <Card>
          <CardHeader>
            <SectionHeading id="member-company-heading">
              {t('sections.company')}
            </SectionHeading>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {/* 056 layout C — subgroup ORGANISATION (who the member is). */}
            <div className="flex flex-col gap-2">
              <SubGroupLabel>{t('sections.organisation')}</SubGroupLabel>
              <dl className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
                <DetailField
                  label={t('fields.country')}
                  /* C4 round-10 — flag + localised name instead of raw "TH". */
                  value={null}
                  extra={<CountryDisplay code={member.country} />}
                />
                <DetailField
                  label={t('fields.legalEntityType')}
                  value={legalEntityLabel}
                />
                <DetailField
                  label={t('fields.taxId')}
                  value={member.taxId}
                  mono
                  {...(member.taxId
                    ? {
                        extra: (
                          <CopyButton
                            value={member.taxId}
                            label={t('copy.copyTaxId')}
                          />
                        ),
                      }
                    : {})}
                />
                {/* 056 fix #4 — website as a real external link, not plain text.
                    value=null so the link (or the "—" fallback) is the sole
                    content; `extra` carries the anchor when a website exists. */}
                <DetailField
                  label={t('fields.website')}
                  value={null}
                  {...(member.website
                    ? {
                        extra: (
                          <a
                            href={member.website}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={t('fields.websiteExternal')}
                            className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          >
                            <span className="truncate">{member.website}</span>
                            <ExternalLinkIcon
                              aria-hidden="true"
                              className="size-3.5 shrink-0"
                            />
                          </a>
                        ),
                      }
                    : {})}
                />
                <DetailField
                  label={t('fields.foundedYear')}
                  value={member.foundedYear}
                />
                {/* 056 fix #3 — turnover as THB currency (grouping + symbol). */}
                <DetailField
                  label={t('fields.turnoverThb')}
                  value={
                    member.turnoverThb !== null
                      ? format.number(member.turnoverThb, {
                          style: 'currency',
                          currency: 'THB',
                        })
                      : null
                  }
                />
              </dl>
            </div>

            {/* 056 layout C — subgroup MEMBERSHIP (the chamber relationship). */}
            <div className="flex flex-col gap-2 border-t pt-4">
              <SubGroupLabel>{t('sections.membership')}</SubGroupLabel>
              <dl className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
                <DetailField label={t('fields.plan')} value={planDisplayName} />
                <DetailField
                  label={t('fields.planYear')}
                  value={member.planYear}
                />
                {/* 056 fix #2 — Buddhist-aware localised date (no raw .toISOString()). */}
                <DetailField
                  label={t('fields.registrationDate')}
                  value={formatLocalisedDate(
                    member.registrationDate.toISOString(),
                    locale,
                    { dateStyle: 'medium' },
                  )}
                />
                <DetailField
                  label={t('fields.registrationFeePaid')}
                  value={
                    member.registrationFeePaid
                      ? t('fields.registrationFeePaidYes')
                      : t('fields.registrationFeePaidNo')
                  }
                />
                <DetailField
                  label={t('fields.lastActivityAt')}
                  value={
                    member.lastActivityAt
                      ? formatLocalisedDate(
                          member.lastActivityAt.toISOString(),
                          locale,
                          {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          },
                        )
                      : null
                  }
                />
                {/* 056 fix #9 — only show archivedAt in the grid when the
                    ArchivedBanner is NOT rendered (banner already shows the
                    date). Banner renders for within_window / window_expired. */}
                {member.status === 'archived' &&
                  windowStatus === null &&
                  member.archivedAt && (
                    <DetailField
                      label={t('fields.archivedAt')}
                      value={formatLocalisedDate(
                        member.archivedAt.toISOString(),
                        locale,
                        { dateStyle: 'medium', timeStyle: 'short' },
                      )}
                    />
                  )}
              </dl>
            </div>

            {/* 056 layout C — Technical collapse: the raw UUIDs scan as noise
                in the grid, so tuck them behind a <details>. The member number
                (human-readable) stays in the header chip; the copy-to-clipboard
                UUID affordances (FR-030) move here. */}
            <details className="border-t pt-4">
              <summary className="cursor-pointer text-caption font-medium uppercase tracking-wide text-muted-foreground marker:text-muted-foreground">
                {t('sections.technical')}
              </summary>
              <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
                <MemberNumberField formatted={memberNumberDisplay} />
                <DetailField
                  label={t('fields.memberId')}
                  value={member.memberId}
                  mono
                  extra={
                    <CopyButton
                      value={member.memberId}
                      label={t('copy.copyMemberId')}
                    />
                  }
                />
                <DetailField
                  label={t('fields.planId')}
                  value={member.planId}
                  mono
                />
              </dl>
            </details>
            {(() => {
              const cityLine = [member.city, member.province, member.postalCode]
                .filter((p) => p && p.trim().length > 0)
                .join(' ');
              const addressLines = [
                member.addressLine1,
                member.addressLine2,
                cityLine,
              ].filter((l): l is string => Boolean(l && l.trim().length > 0));
              return addressLines.length > 0 ? (
                <dl className="mt-4 border-t pt-4">
                  <dt className="text-xs text-muted-foreground mb-1">
                    {t('fields.address')}
                  </dt>
                  <dd className="text-sm whitespace-pre-wrap">
                    {addressLines.join('\n')}
                  </dd>
                </dl>
              ) : null;
            })()}
            {member.description && (
              /* <dl> wrapper (not <div>) so the <dt>/<dd> have a list parent —
                 WCAG 2.1 AA 1.3.1 (a11y scan fix: axe `dlitem`). */
              <dl className="mt-4 border-t pt-4">
                <dt className="text-xs text-muted-foreground mb-1">
                  {t('fields.description')}
                </dt>
                <dd className="text-sm whitespace-pre-wrap">
                  {member.description}
                </dd>
              </dl>
            )}
            {member.notes && (
              <dl className="mt-4 border-t pt-4">
                <dt className="text-xs text-muted-foreground mb-1">
                  {t('fields.notes')}
                </dt>
                <dd className="text-sm whitespace-pre-wrap">{member.notes}</dd>
              </dl>
            )}
          </CardContent>
        </Card>
        </section>

        {/* Compact-summary 2-col row: Renewal & Health (left) + Benefits
            Preview (right) on lg+, reflowing to a single column below lg.
            `items-start` keeps the two cards top-aligned.
            When Benefits is NOT shown (F9 flag off or non-admin/manager),
            `showBenefitsPreview` is false and we omit the grid wrapper so
            Renewal & Health spans the full page width instead of being
            stranded at half-width with an empty right column. */}
        {showBenefitsPreview ? (
          <div className="grid grid-cols-1 items-stretch gap-[var(--page-section-gap)] lg:grid-cols-2">
            {/* Pass A · Section 1 — Renewal & Health (F8 cycle status +
                expiry + at-risk band, with the F9 engagement score MERGED
                in). Own Suspense boundary so the F8/F9 reads never block
                the company/contacts paint. */}
            <Suspense fallback={<MemberRenewalHealthSkeleton />}>
              <MemberRenewalHealthSection tenant={tenant} memberId={member.memberId} canRenew={canWrite} />
            </Suspense>

            {/* Pass A · Section 2 — inline benefits quota preview (E-Blast /
                cultural-ticket usage at a glance) with a "Full benefits →"
                link to the dedicated benefits page. F9-gated; admin/manager
                only (requireSession('staff') already excludes 'member').
                Own Suspense boundary so the benefit read never blocks paint. */}
            <Suspense fallback={<MemberBenefitsPreviewSkeleton />}>
              <MemberBenefitsPreviewSection
                tenant={tenant}
                memberId={member.memberId}
                actorUserId={session.user.id}
                actorRole={session.user.role}
              />
            </Suspense>
          </div>
        ) : (
          /* Benefits not available: Renewal & Health renders full-width. */
          <Suspense fallback={<MemberRenewalHealthSkeleton />}>
            <MemberRenewalHealthSection tenant={tenant} memberId={member.memberId} />
          </Suspense>
        )}

        {/* Contacts — full-width below the compact 2-col row. Single Card
            groups primary + secondary contacts under one heading, matching
            the Company section pattern. Individual contacts render as flat
            rows inside CardContent (ContactBlock), not as nested cards. */}
        <section aria-labelledby="member-contacts-heading">
          <Card>
            <CardHeader className="flex flex-row items-center gap-2">
              <SectionHeading id="member-contacts-heading">
                {t('sections.contacts')}
              </SectionHeading>
              {/* T097 — Emergency primary contact transfer helper. Clicking
                  the icon opens a Popover (not a hover Tooltip — we need
                  tap-discoverable on mobile) that explains the two-step
                  procedure per spec Edge Cases: add the new person as a
                  secondary contact, then promote them.
                  056 fix #8 — trigger raised to a 44×44 tap target (was 24×24)
                  per WCAG 2.5.8; the icon stays 16px. */}
              <Popover>
                <PopoverTrigger
                  aria-label={t('emergencyPrimary.ariaLabel')}
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <HelpCircleIcon className="size-4" aria-hidden="true" />
                </PopoverTrigger>
                <PopoverContent className="max-w-sm text-sm" sideOffset={4}>
                  <p className="font-medium">{t('emergencyPrimary.title')}</p>
                  <p className="mt-2 text-muted-foreground">
                    {t('emergencyPrimary.body')}
                  </p>
                </PopoverContent>
              </Popover>
              {canWrite && member.status !== 'archived' && (
                <ContactFormDialog
                  memberId={member.memberId}
                  mode="add"
                  trigger={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="ml-auto gap-2"
                    >
                      <UserPlusIcon className="size-4" aria-hidden="true" />
                      {t('contactActions.add')}
                    </Button>
                  }
                />
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              {primary ? (
                <ContactBlock
                  contact={primary}
                  memberId={member.memberId}
                  pendingInvitation={pendingInvitationsByContactId.get(
                    primary.contactId,
                  )}
                  subscribed={subscriptionFor(primary.contactId)}
                  canWrite={canWrite}
                  locale={locale}
                  t={t}
                />
              ) : null}

              {secondary.length > 0 && (
                <>
                  <Separator />
                  <h3 className="text-sm font-medium text-muted-foreground">
                    {t('sections.secondary')}
                  </h3>
                  {secondary.map((c, i) => (
                    <div key={c.contactId} className="flex flex-col gap-6">
                      {i > 0 ? <Separator /> : null}
                      <ContactBlock
                        contact={c}
                        memberId={member.memberId}
                        pendingInvitation={pendingInvitationsByContactId.get(
                          c.contactId,
                        )}
                        subscribed={subscriptionFor(c.contactId)}
                        canWrite={canWrite}
                        locale={locale}
                        t={t}
                      />
                    </div>
                  ))}
                </>
              )}

              {/* 056 fix #6 — empty state when there is no primary AND no
                  secondary contact (previously the card body rendered empty). */}
              {!primary && secondary.length === 0 && (
                <p className="py-2 text-sm text-muted-foreground">
                  {t('sections.contactsEmpty')}
                </p>
              )}
            </CardContent>
          </Card>
        </section>

        {/* US7 AS1 — Invoice history on member page. Wrapped in its
            own Suspense boundary so member metadata + contacts paint
            first and an invoice-fetch failure stays isolated to this
            section (parent page's `getMember` call is unaffected). */}
        {(session.user.role === 'admin' || session.user.role === 'manager') && (
          <Suspense fallback={<MemberInvoicesSkeleton />}>
            <MemberInvoicesSection
              tenant={tenant}
              memberId={member.memberId}
              role={session.user.role}
              statusFilter={invStatus}
              fiscalYearFilter={invYear}
              searchFilter={invQ}
            />
          </Suspense>
        )}

        {/* I7 round-10 ui-design-specialist — inline 3-event timeline
            preview. Saves a round-trip through /timeline for the
            common "what happened recently" check. Own Suspense
            boundary mirrors the invoices pattern: the audit-log query
            is independent of getMember + contacts and can't block the
            main paint. */}
        <Suspense fallback={<TimelinePreviewSkeleton />}>
          <TimelinePreviewSection
            memberId={member.memberId}
            actorUserId={session.user.id}
            actorRole={session.user.role as 'admin' | 'manager' | 'member'}
          />
        </Suspense>

        {/* F9 US6 (FR-031) — admin on-behalf GDPR data export. Admin-only
            (GDPR export is an admin/DPO action; the read-only manager is
            excluded, mirroring requestDataExport). F9-flag-gated. */}
        {env.features.f9Dashboard && session.user.role === 'admin' && (
          <Suspense fallback={<MemberDataExportSkeleton />}>
            <MemberDataExportSection tenant={tenant} memberId={member.memberId} />
          </Suspense>
        )}

    </DetailContainer>
  );
}
