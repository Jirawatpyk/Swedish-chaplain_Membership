import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, getLocale } from 'next-intl/server';
import { BookUserIcon, FileClockIcon, PencilIcon, UserPlusIcon } from 'lucide-react';
import {
  AuraAlert,
  AuraBadge,
  AuraCard,
  AuraStatusPill,
  auraButtonClass,
} from '@/components/shell/aura-markup';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { CopyButton } from '@/components/members/copy-button';
import { CountryDisplay } from '@/components/members/country-display';
import { DetailField } from '@/components/members/detail-field';
import { resolveLegalEntityTypeLabel } from '@/components/members/resolve-legal-entity-type-label';
import { formatCalendarYear, formatLocalisedDate } from '@/lib/format-date-localised';
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
import { PortalMarketingToggle } from '@/components/members/portal-marketing-toggle';
import { env } from '@/lib/env';
// F114 — the caller's OWN pending change request (never another contact's).
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { asMembersUserId } from '@/lib/members-change-request-deps';
import { serialiseChangeRequestForPortal, type ChangeRequestView } from '@/lib/change-request-portal-view';
import { PendingRequestBanner } from '@/components/members/change-requests/pending-request-banner';
import { DecisionOutcomeBanner } from '@/components/members/change-requests/decision-outcome-banner';

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
 * heading navigation under the page `<h1>`. Spec 122 US3: `AuraCard` with
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
  const tDir = await getTranslations('directorySettings');
  const tHistory = await getTranslations('portal.changeRequests.history');
  const tPending = await getTranslations('portal.changeRequests.pending');
  // 059 / PR-A Task 3b — the ADMIN member-detail page already resolves
  // legal_entity_type through these same labels (resolveLegalEntityTypeLabel);
  // reused here rather than duplicated so a member sees IDENTICAL copy to
  // what staff see, in all three locales, from one translated source.
  const tLegalTypes = await getTranslations(
    'admin.members.detail.legalEntityTypes',
  );
  const locale = await getLocale();

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
  const websiteHref = safeExternalHref(m.website);

  return (
    <DetailContainer>
      <PageHeader
        title={m.companyName}
        subtitle={t('pageTitle')}
        badge={
          <div className="flex flex-wrap items-center gap-2">
            <AuraStatusPill tone={m.status === 'active' ? 'ready' : 'neutral'}>
              {t(`statusBadge.${m.status}`)}
            </AuraStatusPill>
            <AuraBadge variant="outline" className="font-mono">
              {memberNumberFormatted}
            </AuraBadge>
          </div>
        }
        actions={
          <Link href="/portal/edit" className={auraButtonClass()}>
            <PencilIcon className="aura-icon size-4" aria-hidden />
            {t('editButton')}
          </Link>
        }
      />

      {/* F114 — awaiting-review banner (role=status), above the record it will change. */}
      {pendingRequest ? <PendingRequestBanner request={pendingRequest} /> : null}
      {ownRequestReadFailed ? (
        <div data-testid="portal-own-request-unavailable">
          <AuraAlert tone="danger" role="status">
            {tPending('loadFailed')}
          </AuraAlert>
        </div>
      ) : null}
      {/* F114 US3 — the shown decision (role=status) until dismissed; never alongside a pending one. */}
      {!pendingRequest && decidedRequest ? <DecisionOutcomeBanner request={decidedRequest} /> : null}

      {/* Organisation — who the member is. */}
      <AuraCard title={t('organisationSection')} titleId="portal-profile-org-heading" headingLevel={2}>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
              <DetailField
                label={t('fields.memberNumber')}
                value={memberNumberFormatted}
                mono
                extra={
                  <CopyButton
                    value={memberNumberFormatted}
                    label={t('fields.memberNumberCopy')}
                  />
                }
              />
              <DetailField
                label={t('fields.companyName')}
                value={m.companyName}
              />
              {!isIndividual && (
                <DetailField
                  label={t('fields.legalEntityType')}
                  value={legalEntityLabel}
                />
              )}
              {/* 067 — members get their tax_id on every issued tax invoice;
                  surface it here so they can verify the value the chamber has
                  on file (and notice when it is missing — the §86/4 buyer TIN).
                  Own-profile PII, member-visible by design. DetailField shows
                  the "—" placeholder when null (no-TIN members). */}
              <DetailField
                label={t('fields.taxId')}
                value={m.taxId}
              />
              <DetailField
                label={t('fields.country')}
                value={null}
                extra={<CountryDisplay code={m.country} />}
              />
              {/* 069 — §86/4 buyer address on file (read-only; admin-managed).
                  Full-width so a long address wraps cleanly. */}
              {/* `className` on the field itself, not a wrapper <div>: inside
                  the <dl> a wrapper is `div > div > dt`, which axe rejects
                  (definition-list / dlitem — caught by the PR-D portal sweep). */}
              <DetailField
                label={t('fields.address')}
                value={addressText}
                className="sm:col-span-2 lg:col-span-3"
              />
              {billingAddressText ? (
                // member-billing-address (0284) — shown only when set, so
                // the common no-billing-address profile is unchanged.
                <DetailField
                  label={t('fields.billingAddress')}
                  value={billingAddressText}
                  className="sm:col-span-2 lg:col-span-3"
                />
              ) : null}
              {websiteHref ? (
                <DetailField
                  label={t('fields.website')}
                  value={null}
                  extra={
                    <a
                      href={websiteHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm font-medium text-[var(--aura-fg-accent)] no-underline hover:text-[var(--aura-fg-primary)] hover:underline"
                    >
                      <span className="truncate">{m.website}</span>
                    </a>
                  }
                />
              ) : (
                <DetailField
                  label={t('fields.website')}
                  value={m.website || null}
                />
              )}
              {!isIndividual && (
                <DetailField
                  label={t('fields.foundedYear')}
                  value={m.foundedYear}
                />
              )}
              {m.description ? (
                <DetailField
                  label={t('fields.description')}
                  value={m.description}
                  className="sm:col-span-2 lg:col-span-3"
                />
              ) : null}
            </dl>
      </AuraCard>

      {/* Membership — the chamber relationship. */}
      <AuraCard title={t('membershipSection')} titleId="portal-profile-membership-heading" headingLevel={2}>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
              <DetailField
                label={t('fields.planName')}
                value={planDisplayName}
              />
              <DetailField
                label={t('fields.planYear')}
                value={formatCalendarYear(m.planYear, locale)}
              />
              <DetailField
                label={t('fields.registrationDate')}
                value={formatLocalisedDate(
                  m.registrationDate.toISOString(),
                  locale,
                  { dateStyle: 'medium' },
                )}
              />
              <DetailField
                label={t('fields.lastActivityAt')}
                value={
                  m.lastActivityAt
                    ? formatLocalisedDate(
                        m.lastActivityAt.toISOString(),
                        locale,
                        { dateStyle: 'medium', timeStyle: 'short' },
                      )
                    : null
                }
              />
            </dl>
      </AuraCard>

      {/* Contacts — primary + others. */}
      <AuraCard
        title={t('contactsSection')}
        titleId="portal-profile-contacts-heading"
        headingLevel={2}
        actions={
          isPrimary ? (
            <Link href="/portal/contacts/invite" className={auraButtonClass({ variant: 'secondary' })}>
              <UserPlusIcon className="aura-icon size-4" aria-hidden />
              {t('inviteColleague')}
            </Link>
          ) : undefined
        }
      >
            <div className="flex flex-col">
              {activeContacts.map((contact) => (
                // Hairline rows, as on the Portal-profile board.
                <div
                  key={contact.contactId}
                  className="flex flex-col gap-4 border-t border-[var(--aura-border-default)] py-4 first:border-t-0 first:pt-0 last:pb-0"
                >
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-body font-medium">
                          {`${contact.firstName} ${contact.lastName}`.trim()}
                        </p>
                        {contact.isPrimary && (
                          <AuraBadge variant="outline">{t('primaryBadge')}</AuraBadge>
                        )}
                        {contact.linkedUserId && (
                          <AuraBadge variant="outline">{t('portalLinked')}</AuraBadge>
                        )}
                      </div>
                      <p className="text-[13px] text-[var(--aura-fg-secondary)]">
                        {contact.email}
                      </p>
                      {contact.phone ? (
                        <p className="text-[13px] text-[var(--aura-fg-secondary)]">
                          {contact.phone}
                        </p>
                      ) : null}
                      {contact.roleTitle ? (
                        <p className="text-[13px] text-[var(--aura-fg-secondary)]">
                          {contact.roleTitle}
                        </p>
                      ) : null}
                      {/* 108 PR-D (US6) — the signed-in contact's OWN marketing
                          control; never rendered on another contact's row. */}
                      {ownContact !== undefined &&
                        contact.contactId === ownContact.contactId &&
                        ownMarketingState !== null && (
                          <div className="mt-3">
                            <PortalMarketingToggle
                              state={ownMarketingState}
                              isPrimary={contact.isPrimary}
                            />
                          </div>
                        )}
                    </div>
                  </div>
                </div>
              ))}
              {activeContacts.length === 0 && (
                <p className="text-[var(--aura-fg-secondary)]">{t('noContacts')}</p>
              )}
            </div>
      </AuraCard>

      {/* F114 US4 (FR-029) — the member's own change-request history. Gated on
          the platform flag (the target page notFounds when dark); shown
          regardless of the tenant setting — history exists once requests do
          (FR-032). Real <h2> like the sibling cards. */}
      {env.features.memberChangeApproval ? (
        <AuraCard
          title={tHistory('profileCard.title')}
          titleId="portal-profile-change-requests-heading"
          headingLevel={2}
          actions={
            <Link
              href="/portal/change-requests"
              className={auraButtonClass({ variant: 'secondary' })}
              data-testid="profile-history-link"
            >
              <FileClockIcon className="aura-icon size-4" aria-hidden />
              {tHistory('profileCard.link')}
            </Link>
          }
        >
          <p className="text-[var(--aura-fg-secondary)]">{tHistory('profileCard.subtitle')}</p>
        </AuraCard>
      ) : null}

      {/* F9 directory listing self-service — gated on the F9 flag so it stays
          hidden until the feature flips on; the target page notFounds when
          dark. Heading is a real <h2> per a11y-6. */}
      {env.features.f9Dashboard ? (
        <AuraCard
          title={tDir('title')}
          titleId="portal-profile-directory-heading"
          headingLevel={2}
          actions={
            <Link href="/portal/profile/directory" className={auraButtonClass({ variant: 'secondary' })}>
              <BookUserIcon className="aura-icon size-4" aria-hidden />
              {tDir('manage')}
            </Link>
          }
        >
          <p className="text-[var(--aura-fg-secondary)]">{tDir('subtitle')}</p>
        </AuraCard>
      ) : null}
    </DetailContainer>
  );
}

export default async function PortalProfilePage() {
  const { user } = await requireSession('member');
  return <PortalProfileBody user={{ id: user.id }} />;
}
