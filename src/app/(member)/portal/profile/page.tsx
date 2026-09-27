import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { renderPortalProfileView } from '@/components/members/portal-profile-view';
import { resolveLegalEntityTypeLabel } from '@/components/members/resolve-legal-entity-type-label';
import { safeExternalHref } from '@/lib/safe-url';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  getMember,
  formatMemberNumber,
  resolveMemberNumberPrefix,
  deriveMarketingState,
  type MarketingState,
} from '@/modules/members';
import { makeMarketingSuppressionLookup } from '@/lib/contact-marketing-deps';
import { env } from '@/lib/env';
// F114 — the caller's OWN pending change request (never another contact's).
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { asMembersUserId } from '@/lib/members-change-request-deps';
import { serialiseChangeRequestForPortal, type ChangeRequestView } from '@/lib/change-request-portal-view';

/**
 * 057 G4 — member-facing member-detail (design §4.2, Option C structure
 * WITHOUT admin actions / renewal-triage).
 *
 * Header (company + SCCM-NNNN + status) → Organisation card →
 * Membership card → Contacts card → Directory listing.
 *
 * Refactor of the old inline `<dt>/<dd>` page (review S-3): all rows now
 * use the shared `DetailField`; section titles are real `<h2>` (review
 * a11y-6 — NEVER CardTitle, which renders a div and reproduced the admin
 * h1→h3 skip). Dates render via `formatLocalisedDate` (BE display-only
 * for th-TH; storage stays Gregorian ISO).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.profile');
  return { title: t('pageTitle') };
}

/**
 * 057 fix — every section heading is a real `<h2>` labelling its card
 * (`<section aria-labelledby>`), so each content group is reachable via SR
 * heading navigation under the page `<h1>`. Spec 122 US3: `Card` with
 * `headingLevel={2}` and `titleId` renders exactly that, in AURA's look.
 */

/**
 * Testable RSC body — accepts the already-resolved session user so a unit
 * test can invoke it directly (no live session). The default export below
 * is a thin wrapper that resolves the member session and delegates here.
 */
export async function PortalProfileBody({
  user,
}: {
  user: { id: string };
}) {
  const t = await getTranslations('portal.profile');
  // 059 / PR-A Task 3b — the ADMIN member-detail page already resolves
  // legal_entity_type through these same labels (resolveLegalEntityTypeLabel);
  // reused here rather than duplicated so a member sees IDENTICAL copy to
  // what staff see, in all three locales, from one translated source.
  const tLegalTypes = await getTranslations(
    'admin.members.detail.legalEntityTypes',
  );

  const tenant = resolveTenantFromRequest();
  const deps = buildMembersDeps(tenant);

  // memberId is ALWAYS resolved from the session user via findByLinkedUserId —
  // NEVER from a URL param (review M-2: cross-tenant safety. The repo wraps
  // the query in runInTenant so RLS scopes it to the caller's tenant).
  const memberResult = await deps.memberRepo.findByLinkedUserId(
    tenant,
    user.id,
  );
  if (!memberResult.ok) {
    return (
      <DetailContainer>
        <PageHeader title={t('pageTitle')} />
        <div className="py-12 text-center">
          <p className="text-body text-muted-foreground">{t('notLinked')}</p>
        </div>
      </DetailContainer>
    );
  }

  const member = memberResult.value;
  const result = await getMember(
    member.memberId,
    { actorUserId: user.id, requestId: 'portal-profile' },
    {
      tenant,
      memberRepo: deps.memberRepo,
      contactRepo: deps.contactRepo,
      audit: deps.audit,
    },
  );

  if (!result.ok) {
    return (
      <DetailContainer>
        <PageHeader title={t('pageTitle')} />
        <div className="py-12 text-center">
          <p className="text-body text-muted-foreground">{t('loadError')}</p>
        </div>
      </DetailContainer>
    );
  }

  const { member: m, contacts } = result.value;
  const activeContacts = contacts.filter((c) => !c.removedAt);
  const ownContact = activeContacts.find(
    (c) => String(c.linkedUserId) === user.id,
  );
  const isPrimary = ownContact?.isPrimary === true;

  // 108 PR-D (US6 / FR-031a, FR-032) — the OWN contact's displayed marketing
  // state only (suppression > opt-out > on; unreadable list → 'unavailable').
  // Other contacts' states are never rendered in the portal.
  let ownMarketingState: MarketingState | null = null;
  if (ownContact) {
    let suppressed: boolean | 'unknown';
    try {
      suppressed = await makeMarketingSuppressionLookup(tenant).isSuppressed(ownContact.email);
    } catch {
      suppressed = 'unknown';
    }
    ownMarketingState = deriveMarketingState(ownContact.marketing, suppressed);
  }

  // F114 US1 (FR-010) — the pending banner: the caller's OWN pending request,
  // only while the flag is on AND the tenant requires approval. Best-effort:
  // a read failure logs and the profile still renders (never-500 contract).
  let pendingRequest: ChangeRequestView | null = null;
  // F114 US3 (FR-010) — the caller's LAST decided request until they dismiss
  // it; hidden while a newer (pending) request exists.
  let decidedRequest: ChangeRequestView | null = null;
  // a failed read renders its OWN state (`role=status`), never the profile
  // that says "no request pending" — the member section's rule (PR review)
  let ownRequestReadFailed = false;
  if (ownContact && env.features.memberChangeApproval) {
    try {
      const gate = await deps.memberChangeGate.resolve(tenant);
      if (gate === 'approval') {
        const me = {
          contactId: ownContact.contactId,
          displayName: `${ownContact.firstName} ${ownContact.lastName}`.trim(),
          isMe: true,
        };
        // a PLAIN read (no lock) — the page never queues behind a decide /
        // submit holding the row (PR-1 review, Rel M-5)
        const pending = await deps.changeRequestRepo.findPendingBySubmitter(tenant, asMembersUserId(user.id));
        if (pending.ok && pending.value) {
          pendingRequest = serialiseChangeRequestForPortal(pending.value, me);
        } else if (!pending.ok) {
          ownRequestReadFailed = true;
          logger.error(
            { errorId: 'M114.portal.profile.pending_read_failed', err: pending.error.code, tenantId: tenant.slug },
            'portal.profile.pending_read_failed',
          );
        } else {
          const decided = await deps.changeRequestRepo.listQueue(
            tenant,
            { state: 'decided', submitterUserId: asMembersUserId(user.id) },
            { cursor: null, limit: 1 },
          );
          const last = decided.ok ? decided.value.items[0] : undefined;
          if (last && last.request.outcomeAcknowledgedAt === null) {
            decidedRequest = serialiseChangeRequestForPortal(last.request, me);
          } else if (!decided.ok) {
            ownRequestReadFailed = true;
            logger.error(
              { errorId: 'M114.portal.profile.decided_read_failed', err: decided.error.code, tenantId: tenant.slug },
              'portal.profile.decided_read_failed',
            );
          }
        }
      }
    } catch (e) {
      // its own id: a throwing gate resolver is not a failed pending read
      ownRequestReadFailed = true;
      logger.error(
        { errorId: 'M114.portal.profile.gate_failed', err: errKind(e), tenantId: tenant.slug },
        'portal.profile.gate_failed',
      );
    }
  }

  // Both reads are independent (plan lookup vs. member-settings row) —
  // collapse to ~1 RTT. Mirrors the Promise.all on the admin detail page.
  const [planLookup, memberPrefix] = await Promise.all([
    deps.plans.getPlan(tenant, m.planId, m.planYear),
    resolveMemberNumberPrefix(tenant, deps.memberSettings),
  ]);
  const planDisplayName = planLookup.ok ? planLookup.value.planNameEn : m.planId;
  // 067 — natural-person members (individual / student plans) have no company
  // identity, so company-only profile fields (legal entity type, founded year)
  // are HIDDEN for them. This is a member-TYPE hide (the field never applies),
  // distinct from an empty company field, which still shows "—" as a
  // completeness prompt. memberTypeScope comes from the plan lookup.
  const isIndividual =
    planLookup.ok && planLookup.value.memberTypeScope === 'individual';

  // `m.memberNumber` is already a branded MemberNumber (validated by
  // rowToMember) — no re-wrap needed.
  const memberNumberFormatted = formatMemberNumber(memberPrefix, m.memberNumber);
  // 059 / PR-A Task 3b — was rendered RAW (`value={m.legalEntityType}`), so a
  // member saw the machine code (`limited_company`) verbatim. Resolved
  // through the same i18n labels + fail-soft fallback the admin page uses.
  const legalEntityLabel = resolveLegalEntityTypeLabel(
    m.legalEntityType,
    tLegalTypes,
  );

  // 069 — surface the member's address so they can verify the value that
  // prints as the §86/4 BUYER address on every tax invoice they receive (same
  // "verify what the chamber has on file" rationale as tax_id above). Read-only:
  // the §86/4 address is admin-managed — a member who spots an error asks the
  // chamber to correct it (the portal edit whitelist, FR-042, deliberately
  // excludes it). Composed exactly like the admin detail page (sub-district →
  // city → province → postcode, then the two street lines), joined onto one line
  // for the DetailField cell; `null` when nothing is on file → renders "—".
  const cityLine = [m.subDistrict, m.city, m.province, m.postalCode]
    .filter((p): p is string => Boolean(p && p.trim()))
    .join(' ');
  const addressText =
    [m.addressLine1, m.addressLine2, cityLine]
      .filter((l): l is string => Boolean(l && l.trim()))
      .join(', ') || null;

  // member-billing-address (0284) — read-only, shown ONLY when set ("set" ⟺
  // line1 present): the ภ.พ.20-registered address that overrides the company
  // address on the member's tax documents. Same "verify what the chamber has
  // on file" rationale as the address above; NOT self-editable this round
  // (admin-managed — the portal edit whitelist deliberately excludes it;
  // self-service editing is a noted follow-up). Includes the group's OWN
  // country code — it may differ from the member's country.
  const billingCityLine = [
    m.billingSubDistrict,
    m.billingCity,
    m.billingProvince,
    m.billingPostalCode,
  ]
    .filter((p): p is string => Boolean(p && p.trim()))
    .join(' ');
  const billingAddressText = m.billingAddressLine1
    ? [m.billingAddressLine1, m.billingAddressLine2, billingCityLine, m.billingCountry]
        .filter((l): l is string => Boolean(l && l.trim()))
        .join(', ')
    : null;

  // Render the website as a link only when it is a safe http(s) URL — an
  // unsafe scheme (javascript:/data:) falls back to plain text. See safe-url.ts.
  return renderPortalProfileView({
    member: m,
    contacts: activeContacts,
    ownContactId: ownContact?.contactId ?? null,
    isPrimary,
    ownMarketingState,
    pendingRequest,
    decidedRequest,
    ownRequestReadFailed,
    planDisplayName,
    isIndividual,
    memberNumberFormatted,
    legalEntityLabel,
    addressText,
    billingAddressText,
    websiteHref: safeExternalHref(m.website) ?? null,
    showHistoryLink: env.features.memberChangeApproval,
    showDirectoryLink: env.features.f9Dashboard,
  });
}

export default async function PortalProfilePage() {
  const { user } = await requireSession('member');
  return <PortalProfileBody user={{ id: user.id }} />;
}
