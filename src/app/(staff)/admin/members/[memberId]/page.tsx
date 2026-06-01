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
import { getTranslations, getFormatter } from 'next-intl/server';
import {
  ArrowLeftIcon,
  HelpCircleIcon,
  MailWarningIcon,
  PencilIcon,
  ClockIcon,
  UserPlusIcon,
} from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { headers } from 'next/headers';
import { getMember, archiveWindowStatus } from '@/modules/members';
import type { MemberId, Contact } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { CopyButton } from '@/components/members/copy-button';
import { CountryDisplay } from '@/components/members/country-display';
import { InvitePortalButton } from '@/components/members/invite-portal-button';
import { ResendBouncedInviteButton } from '@/components/members/resend-bounced-invite-button';
import { ArchivedBanner } from '@/components/members/archived-banner';
import { ArchiveMemberButton } from '@/components/members/archive-member-button';
import { ContactFormDialog } from '@/components/members/contact-form-dialog';
import { ContactActions } from '@/components/members/contact-actions';
import { Suspense } from 'react';
import { MemberInvoicesSection } from './_components/member-invoices-section';
import { MemberInvoicesSkeleton } from './_components/member-invoices-skeleton';
import { MemberDataExportSection } from './_components/member-data-export-section';
import { MemberDataExportSkeleton } from './_components/member-data-export-skeleton';
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

function Field({
  label,
  value,
  fallback = '—',
  mono = false,
  extra,
}: {
  label: string;
  value: string | number | null | undefined;
  fallback?: string;
  mono?: boolean;
  extra?: React.ReactNode;
}) {
  const v = value === null || value === undefined || value === '' ? null : String(value);
  return (
    <div className="flex flex-col gap-1 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2 text-sm">
        {v !== null && (
          <span className={mono ? 'font-mono text-xs' : ''}>{v}</span>
        )}
        {v === null && extra === undefined && (
          <span className="text-muted-foreground">{fallback}</span>
        )}
        {/* `extra` always renders — it may be the sole content (e.g. a
            StatusBadge passed without a value). Previously gated on `v`
            which hid the badge when the value was null. */}
        {extra}
      </dd>
    </div>
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
  canWrite,
  t,
}: {
  contact: Contact;
  memberId: string;
  pendingInvitation?: PendingInvitation | undefined;
  /** S1-P1-10: false for the read-only manager — hides Invite/Promote/Remove. */
  canWrite: boolean;
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
                  date: pendingInvitation.expiresAt
                    .toISOString()
                    .slice(0, 10),
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
        <Field
          label={t('fields.email')}
          value={contact.email}
          extra={
            <CopyButton value={contact.email} label={t('copy.copyEmail')} />
          }
        />
        <Field label={t('fields.phone')} value={contact.phone} />
        <Field label={t('fields.roleTitle')} value={contact.roleTitle} />
        <Field
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
  // H1: status label for StatusBadge — reuse existing directory filter keys
  // rather than duplicating active/inactive/archived strings in a new namespace.
  const tDir = await getTranslations('admin.members.directory');
  // H2: locale-aware number formatter (respects active locale for digit grouping).
  const format = await getFormatter();

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

  // C6 round-10 ui-design-specialist — fetch pending portal
  // invitations and project as a Map<contactId, invitation> so each
  // ContactBlock can render its own inline badge. Failures downgrade
  // to an empty Map (no badges shown) — never blocks the page render.
  let pendingInvitationsByContactId = new Map<string, PendingInvitation>();
  try {
    const pendingRes = await deps.memberRepo.findPendingInvitationsForMember(
      tenant,
      member.memberId,
    );
    if (pendingRes.ok) {
      // Round-11 review fix — compute `daysUntilExpiry` once per
      // request rather than inside ContactBlock. Server component
      // renders once per HTTP request so `Date.now()` returns a
      // single stable value for the duration of this render pass —
      // the react-hooks/purity rule's general concern (re-render
      // instability) does not apply to RSC. Disable inline.
      // eslint-disable-next-line react-hooks/purity -- RSC: single render per request
      const nowMs = Date.now();
      const dayMs = 1000 * 60 * 60 * 24;
      pendingInvitationsByContactId = new Map(
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
    } else {
      logger.warn(
        { event: 'pending_invitations_repo_err', err: pendingRes.error, memberId },
        '[F3] pending-invitations repo returned err — falling back to empty map',
      );
    }
  } catch (e) {
    logger.error(
      {
        event: 'pending_invitations_threw',
        err: e instanceof Error ? e.message : String(e),
        memberId,
      },
      '[F3] pending-invitations fetch threw — falling back to empty map',
    );
  }

  // Resolve plan display name via PlanLookupPort (single-plan fetch,
  // no listPlans). Falls back to the slug if the plan row is missing
  // (defensive — shouldn't happen for an active member, but keeps the
  // page resilient to data drift).
  const planLookup = await deps.plans.getPlan(
    tenant,
    member.planId,
    member.planYear,
  );
  const planDisplayName = planLookup.ok
    ? planLookup.value.planNameEn
    : member.planId;

  const windowStatus =
    member.status === 'archived' && member.archivedAt
      ? archiveWindowStatus(member.archivedAt, new Date())
      : null;

  return (
    <DetailContainer>
      <PageHeader
        title={member.companyName}
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
              * back navigation at "Admin > Members > [Company]". Duplicating
              * it as an action-row button competed with Edit/Archive for
              * visual attention and diluted the primary-action hierarchy. */}
            <Link
              href={`/admin/members/${member.memberId}/timeline`}
              className={buttonVariants({ variant: 'outline' })}
            >
              <ClockIcon className="size-4" />
              {t('sections.audit')}
            </Link>
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
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('sections.company')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
              <Field
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
              <Field
                label={t('fields.status')}
                value={null}
                extra={
                  <StatusBadge
                    status={member.status}
                    label={tDir(`filters.status.${member.status}`)}
                  />
                }
              />
              <Field
                label={t('fields.country')}
                /* C4 round-10 ui-design-specialist — flag + localised name
                   instead of raw "TH" / "SE". `value=null` + the
                   CountryDisplay rendered in `extra` keeps the Field
                   primitive's label/value layout intact. */
                value={null}
                extra={<CountryDisplay code={member.country} />}
              />
              <Field
                label={t('fields.legalEntityType')}
                value={member.legalEntityType}
              />
              <Field
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
              <Field label={t('fields.website')} value={member.website} />
              <Field
                label={t('fields.foundedYear')}
                value={member.foundedYear}
              />
              <Field
                label={t('fields.turnoverThb')}
                value={
                  member.turnoverThb !== null
                    ? format.number(member.turnoverThb)
                    : null
                }
              />
              <Field
                label={t('fields.registrationDate')}
                value={member.registrationDate.toISOString().slice(0, 10)}
              />
              <Field
                label={t('fields.registrationFeePaid')}
                value={
                  member.registrationFeePaid
                    ? t('fields.registrationFeePaidYes')
                    : t('fields.registrationFeePaidNo')
                }
              />
              <Field
                label={t('fields.plan')}
                value={planDisplayName}
              />
              <Field label={t('fields.planYear')} value={member.planYear} />
              <Field
                label={t('fields.planId')}
                value={member.planId}
                mono
              />
              <Field
                label={t('fields.lastActivityAt')}
                // ISO string ensures server + client render the same text;
                // localised display belongs in a Client Component hydrated
                // after mount (deferred to US6 Timeline).
                value={
                  member.lastActivityAt
                    ? member.lastActivityAt.toISOString().replace('T', ' ').slice(0, 16)
                    : null
                }
              />
              {member.status === 'archived' && (
                <Field
                  label={t('fields.archivedAt')}
                  value={
                    member.archivedAt
                      ? member.archivedAt.toISOString().replace('T', ' ').slice(0, 16)
                      : null
                  }
                />
              )}
            </dl>
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

        {/* Single Contacts Card groups primary + secondary contacts
            under one CardTitle — matches the Company section pattern
            so every content group on the page has consistent card
            framing. Individual contacts render as bordered rows inside
            CardContent (ContactBlock), not as nested cards. */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <CardTitle className="text-base">{t('sections.contacts')}</CardTitle>
            {/* T097 — Emergency primary contact transfer helper. Clicking
                the icon opens a Popover (not a hover Tooltip — we need
                tap-discoverable on mobile) that explains the two-step
                procedure per spec Edge Cases: add the new person as a
                secondary contact, then promote them. */}
            <Popover>
              <PopoverTrigger
                aria-label={t('emergencyPrimary.ariaLabel')}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                canWrite={canWrite}
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
                      canWrite={canWrite}
                      t={t}
                    />
                  </div>
                ))}
              </>
            )}
          </CardContent>
        </Card>

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
