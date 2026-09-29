/**
 * T067 — /admin/members/[memberId] detail page (US2 deep-link).
 *
 * Server component — runs the `getMember` use case which emits
 * `member_cross_tenant_probe` on 404 per FR-022, loads what the header,
 * the company card and the contacts need, and hands them to
 * `renderMemberDetailView` (spec 122 US5b-1), which the no-DB preview route
 * renders too. The sections that read their own data (strip, renewal,
 * benefits, invoices, timeline, change requests, data export) go in as
 * Suspense-wrapped slots.
 */

import type { Metadata } from 'next';
import { cache, Suspense } from 'react';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations, getLocale } from 'next-intl/server';
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { isInvitationExpired } from '@/lib/invitation-expiry';
import { safeExternalHref } from '@/lib/safe-url';
import {
  getMember,
  archiveWindowStatus,
  formatMemberNumber,
  resolveMemberNumberPrefix,
  getMemberErasureStatus,
  deriveMarketingState,
} from '@/modules/members';
import type { MemberId, Contact, MarketingState } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
// Pass A · Section 3 — F7 marketing-suppression read (cross-context via the
// broadcasts public barrel; the Drizzle repo wraps queries in runInTenant).
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts';
import {
  getMemberMoneyRecipientStatus,
  makeMemberMoneyRecipientStatusDeps,
} from '@/modules/invoicing';
import { resolveLegalEntityTypeLabel } from '@/components/members/resolve-legal-entity-type-label';
// S1 — extracted resolver owns the parse + projection + degraded branching.
import { resolveContactSubscriptions } from './_lib/resolve-contact-subscriptions';
// DV-11 — per-contact email-verification resolver.
import { resolveContactVerification } from './_lib/resolve-contact-verification';
import type { PendingInvitation } from './_components/contact-block';
import { renderMemberDetailView } from './_components/member-detail-view';
import { MemberNotFound } from './_components/member-not-found';
import type { SummaryPortalState } from './_components/member-summary-strip';
import {
  MemberSummaryStripSection,
  MemberSummaryStripSkeleton,
} from './_components/member-summary-strip-section';
import { MemberInvoicesSection } from './_components/member-invoices-section';
import { MemberInvoicesSkeleton } from './_components/member-invoices-skeleton';
import { MemberDataExportSection } from './_components/member-data-export-section';
import { MemberDataExportSkeleton } from './_components/member-data-export-skeleton';
// F114 US4 — the member's change-request history section (FR-026).
import {
  MemberChangeRequestsSection,
  MemberChangeRequestsSkeleton,
  MemberPendingChangeRequestAlert,
} from './_components/member-change-requests-section';
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
    const tenant = resolveTenantFromHeaders(h);
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

  const session = await requirePagePermission('members.read');
  // S1-P1-10: the read-only `manager` role must not see member write
  // affordances (Edit/Archive/Add-Contact/Invite/Promote/Remove) — they
  // dead-end at the API (route RBAC rejects). Only `admin` may mutate members.
  // 016 re-review D — evaluator-derived ('members.write'; OFF leg
  // legacyAdminOnly reproduces the admin-only affordances and admits a
  // promoted super_admin).
  const canWrite = canPerform(session.user.role, 'members.write');
  const h = await headers();
  // resolveTenantFromHeaders honours the T115t `x-tenant` header
  // override used by throwaway-tenant E2E.
  const tenant = resolveTenantFromHeaders(h);
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
  // 056 fix #5 — free-text legal-entity-type → localised label map.
  const tLegalTypes = await getTranslations(
    'admin.members.detail.legalEntityTypes',
  );
  // 056 fix #2 — active locale for the shared Buddhist-aware date helper
  // (`formatLocalisedDate` maps th → th-TH-u-ca-buddhist). NO raw .toISOString()
  // in display; storage stays Gregorian ISO.
  const locale = await getLocale();

  if (!result.ok) {
    if (result.error.type === 'not_found') {
      return <MemberNotFound />;
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
    verificationResult,
    erasureStatus,
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
            // renders once per HTTP request so this `new Date()` is a single
            // stable instant for the whole render pass; `nowMs` feeds the
            // day-count and `now` feeds the shared `isInvitationExpired` helper
            // so both use the same instant.
            const now = new Date();
            const nowMs = now.getTime();
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
                  // Cluster 3 — expired-unaccepted invite (drives the
                  // "Invitation expired" badge + re-invite affordance). Uses the
                  // shared `isInvitationExpired` helper so this page and the
                  // directory badge (`derivePortalState`) share ONE boundary.
                  expired: isInvitationExpired(row.expiresAt, now),
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
      // DV-11 — per-contact email-verification state for the visible-gate on the
      // "Re-send verification email" button. Injects the batched isVerifiedBatch
      // callable (one query for all live-contact userIds) so the resolver stays
      // unit-testable; best-effort (read error → empty pending → button hidden).
      // Skip the DB round-trip entirely for the read-only manager — the button
      // is admin-only so they'll see an empty pending set with zero wasted RTTs.
      canWrite
        ? resolveContactVerification({
            contacts,
            memberId,
            isVerifiedBatch: (ids) => deps.userEmails.isEmailVerifiedBatch(ids),
            logger,
            errKind,
          })
        : Promise.resolve({ pending: new Set<string>() }),
      // COMP-1 US3-A — narrow erasure-status read (erased_at + member_erased
      // completion proof). Drives the ErasedBanner and hides write affordances
      // once erased. Independent of the other reads — folds into the same RTT.
      getMemberErasureStatus(tenant, member.memberId),
    ]);

  // S1 — derive each contact's tri-state subscription from the discriminated
  // result. On a degraded read every contact resolves to 'unknown' (neutral
  // "Status unavailable" badge); otherwise `subscribed = !unsubscribed.has(id)`.
  const subscriptionFor = (contactId: string): boolean | 'unknown' =>
    subscriptionResult.degraded
      ? 'unknown'
      : !subscriptionResult.unsubscribed.has(contactId);
  // 108 PR-D (FR-031) — the displayed five-state marketing state per contact:
  // suppression (the person's own unsubscribe) > opt-out (staff / self) > on;
  // a degraded suppression read → 'unavailable' (FR-031a), never a guess.
  const marketingStateFor = (c: Contact): MarketingState => {
    const sub = subscriptionFor(c.contactId);
    return deriveMarketingState(c.marketing, sub === 'unknown' ? 'unknown' : !sub);
  };
  // FR-030 / FR-034 — the switch is for `contacts.marketing` holders only.
  const canMarketing = canPerform(session.user.role, 'contacts.marketing');

  const planDisplayName = planLookup.ok
    ? planLookup.value.planNameEn
    : member.planId;

  const memberNumberDisplay = formatMemberNumber(memberPrefix, member.memberNumber);

  // Only render the website as a clickable link when it is a safe http(s) URL.
  // zod `.url()` accepts `javascript:`/`data:`, and the portal self-update
  // PATCH stores `website` as a plain string — so a hostile value can reach
  // this staff-facing sink. When unsafe, the raw value shows as text.
  const websiteHref = safeExternalHref(member.website);

  const windowStatus =
    member.status === 'archived' && member.archivedAt
      ? archiveWindowStatus(member.archivedAt, new Date())
      : null;

  const isErased = erasureStatus.erasedAt !== null;

  // 108 FR-003 — would a money email for this member reach anyone?
  //
  // Asked of a USE CASE, which asks the resolver, so the banner and the money
  // path can never disagree about what counts as deliverable. The page's own
  // `primary` lookup answers a DIFFERENT question — which contact to DISPLAY —
  // and a primary contact with an empty `email` is a fine thing to display and
  // a completely undeliverable address. The archived / erased exclusions live
  // in the use case (round-5 #2) so all three banner sites share them. A failed
  // read is logged (inside the use case, with `errKind`) and the banner hidden
  // — it is not a claim about the member's contacts.
  let moneyEmailUndeliverable = false;
  {
    const recipientStatus = await getMemberMoneyRecipientStatus(
      makeMemberMoneyRecipientStatusDeps(),
      { tenantId: tenant.slug, memberId: member.memberId },
    );
    if (recipientStatus.ok) {
      moneyEmailUndeliverable = recipientStatus.value.shouldWarn;
    } else {
      logger.warn(
        { requestId, tenantId: tenant.slug, memberId: member.memberId },
        'admin.members.detail.recipient_status_read_failed — banner suppressed',
      );
    }
  }

  // Post-erase state (COMP-1 US3-A S5): Renew needs write access and a
  // not-yet-erased member. Cluster 4 (2026-07-12) — and never an archived
  // member: `adminRenewLapsedMember` rejects one server-side
  // (`member_archived`); it must be restored first.
  const canRenew = canWrite && !isErased && member.status !== 'archived';

  const legalEntityLabel = resolveLegalEntityTypeLabel(
    member.legalEntityType,
    tLegalTypes,
  );

  // 016 re-review D — each section's gate mirrors the page or API it leads to:
  // benefits 'members.read' (F9), invoices 'invoicing.read' (manager keeps it,
  // marketing is excluded per the D3 finance carve-out), data export
  // 'members.bulk' (F9, hidden once erased — no PII left to export).
  const canReadInvoices = canPerform(session.user.role, 'invoicing.read');
  const showBenefitsPreview =
    env.features.f9Dashboard && canPerform(session.user.role, 'members.read');
  const showDataExport =
    env.features.f9Dashboard && canPerform(session.user.role, 'members.bulk') && !isErased;

  const portalOf = (c: Contact): SummaryPortalState => {
    if (!c.linkedUserId) return 'not_invited';
    const pending = pendingInvitationsByContactId.get(c.contactId);
    if (!pending) return 'linked';
    return pending.expired ? 'expired' : 'invited';
  };
  const summaryCells = 2 + (canReadInvoices ? 1 : 0) + (env.features.f9Dashboard ? 1 : 0);

  return renderMemberDetailView({
    member,
    contacts,
    planDisplayName,
    memberNumberDisplay,
    legalEntityLabel,
    websiteHref,
    windowStatus,
    erasure: { erasedAt: erasureStatus.erasedAt, completed: erasureStatus.completed },
    moneyEmailUndeliverable,
    pendingInvitations: pendingInvitationsByContactId,
    marketingStates: new Map(contacts.map((c) => [c.contactId, marketingStateFor(c)])),
    verificationPending: verificationResult.pending,
    can: { write: canWrite, marketing: canMarketing },
    features: { f9Dashboard: env.features.f9Dashboard, f7Broadcasts: env.features.f7Broadcasts },
    locale,
    slots: {
      // Each section reads its own data in its own Suspense boundary, so no
      // read blocks the header, the company card or the contacts.
      strip: (
        <Suspense fallback={<MemberSummaryStripSkeleton cells={summaryCells} />}>
          <MemberSummaryStripSection
            tenant={tenant}
            memberId={member.memberId}
            canReadInvoices={canReadInvoices}
            primaryContact={
              primary
                ? { name: `${primary.firstName} ${primary.lastName}`.trim(), portal: portalOf(primary) }
                : null
            }
            lastActivityIso={member.lastActivityAt ? member.lastActivityAt.toISOString() : null}
          />
        </Suspense>
      ),
      renewal: (
        <Suspense fallback={<MemberRenewalHealthSkeleton />}>
          <MemberRenewalHealthSection tenant={tenant} memberId={member.memberId} canRenew={canRenew} />
        </Suspense>
      ),
      benefits: showBenefitsPreview ? (
        <Suspense fallback={<MemberBenefitsPreviewSkeleton />}>
          <MemberBenefitsPreviewSection
            tenant={tenant}
            memberId={member.memberId}
            companyName={member.companyName}
          />
        </Suspense>
      ) : null,
      invoices: canReadInvoices ? (
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
      ) : null,
      timeline: (
        <Suspense fallback={<TimelinePreviewSkeleton />}>
          <TimelinePreviewSection
            memberId={member.memberId}
            actorUserId={session.user.id}
            actorRole={session.user.role}
          />
        </Suspense>
      ),
      // F114 US4 (FR-026) — the member's change-request history; hidden while
      // the platform flag is off (FR-039: no request state shown when dark).
      pendingChangeRequest: env.features.memberChangeApproval ? (
        <Suspense fallback={null}>
          <MemberPendingChangeRequestAlert tenant={tenant} memberId={member.memberId} />
        </Suspense>
      ) : null,
      changeRequests: env.features.memberChangeApproval ? (
        <Suspense fallback={<MemberChangeRequestsSkeleton />}>
          <MemberChangeRequestsSection tenant={tenant} memberId={member.memberId} />
        </Suspense>
      ) : null,
      dataExport: showDataExport ? (
        <Suspense fallback={<MemberDataExportSkeleton />}>
          <MemberDataExportSection tenant={tenant} memberId={member.memberId} contacts={contacts} />
        </Suspense>
      ) : null,
    },
  });
}
