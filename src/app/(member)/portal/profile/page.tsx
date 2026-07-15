import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, getLocale } from 'next-intl/server';
import { BookUserIcon, PencilIcon, UserPlusIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { CopyButton } from '@/components/members/copy-button';
import { CountryDisplay } from '@/components/members/country-display';
import { DetailField } from '@/components/members/detail-field';
import { resolveLegalEntityTypeLabel } from '@/components/members/resolve-legal-entity-type-label';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { safeExternalHref } from '@/lib/safe-url';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  getMember,
  formatMemberNumber,
  resolveMemberNumberPrefix,
} from '@/modules/members';
import { env } from '@/lib/env';

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
 * 057 fix — section heading as a real `<h2>` (not a CardTitle `<div>`) so
 * every content group is reachable via SR heading navigation under the
 * page `<h1>`. Mirrors the admin detail page's SectionHeading; carries
 * CardTitle font classes so the visual is unchanged. The `id` is wired to
 * the wrapping `<section aria-labelledby>`.
 */
function SectionHeading({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <h2
      id={id}
      className="font-heading text-base font-medium leading-snug"
    >
      {children}
    </h2>
  );
}

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
            <Badge
              variant={m.status === 'active' ? 'default' : 'secondary'}
            >
              {t(`statusBadge.${m.status}`)}
            </Badge>
            <Badge variant="outline" className="font-mono">
              {memberNumberFormatted}
            </Badge>
          </div>
        }
        actions={
          <Link href="/portal/edit" className={buttonVariants()}>
            <PencilIcon className="size-4" aria-hidden />
            {t('editButton')}
          </Link>
        }
      />

      {/* Organisation — who the member is. */}
      <section aria-labelledby="portal-profile-org-heading">
        <Card>
          <CardHeader>
            <SectionHeading id="portal-profile-org-heading">
              {t('organisationSection')}
            </SectionHeading>
          </CardHeader>
          <CardContent>
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
              <div className="sm:col-span-2 lg:col-span-3">
                <DetailField
                  label={t('fields.address')}
                  value={addressText}
                />
              </div>
              {websiteHref ? (
                <DetailField
                  label={t('fields.website')}
                  value={null}
                  extra={
                    <a
                      href={websiteHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
                <div className="sm:col-span-2 lg:col-span-3">
                  <DetailField
                    label={t('fields.description')}
                    value={m.description}
                  />
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </section>

      {/* Membership — the chamber relationship. */}
      <section aria-labelledby="portal-profile-membership-heading">
        <Card>
          <CardHeader>
            <SectionHeading id="portal-profile-membership-heading">
              {t('membershipSection')}
            </SectionHeading>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
              <DetailField
                label={t('fields.planName')}
                value={planDisplayName}
              />
              <DetailField
                label={t('fields.planYear')}
                value={m.planYear}
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
          </CardContent>
        </Card>
      </section>

      {/* Contacts — primary + others. */}
      <section aria-labelledby="portal-profile-contacts-heading">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <SectionHeading id="portal-profile-contacts-heading">
              {t('contactsSection')}
            </SectionHeading>
            {isPrimary && (
              <Link
                href="/portal/contacts/invite"
                className={buttonVariants({ variant: 'outline' })}
              >
                <UserPlusIcon className="size-4" aria-hidden />
                {t('inviteColleague')}
              </Link>
            )}
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              {activeContacts.map((contact, i) => (
                <div key={contact.contactId} className="flex flex-col gap-4">
                  {i > 0 ? <Separator /> : null}
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-body font-medium">
                          {`${contact.firstName} ${contact.lastName}`.trim()}
                        </p>
                        {contact.isPrimary && (
                          <Badge variant="secondary">
                            {t('primaryBadge')}
                          </Badge>
                        )}
                        {contact.linkedUserId && (
                          <Badge variant="outline">{t('portalLinked')}</Badge>
                        )}
                      </div>
                      <p className="text-caption text-muted-foreground">
                        {contact.email}
                      </p>
                      {contact.phone ? (
                        <p className="text-caption text-muted-foreground">
                          {contact.phone}
                        </p>
                      ) : null}
                      {contact.roleTitle ? (
                        <p className="text-caption text-muted-foreground">
                          {contact.roleTitle}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
              {activeContacts.length === 0 && (
                <p className="text-body text-muted-foreground">
                  {t('noContacts')}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      {/* F9 directory listing self-service — gated on the F9 flag so it stays
          hidden until the feature flips on; the target page notFounds when
          dark. Heading is a real <h2> per a11y-6. */}
      {env.features.f9Dashboard ? (
        <section aria-labelledby="portal-profile-directory-heading">
          <Card>
            <CardHeader>
              <SectionHeading id="portal-profile-directory-heading">
                {tDir('title')}
              </SectionHeading>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-body text-muted-foreground">
                {tDir('subtitle')}
              </p>
              <Link
                href="/portal/profile/directory"
                className={buttonVariants({ variant: 'outline' })}
              >
                <BookUserIcon className="size-4" aria-hidden />
                {tDir('manage')}
              </Link>
            </CardContent>
          </Card>
        </section>
      ) : null}
    </DetailContainer>
  );
}

export default async function PortalProfilePage() {
  const { user } = await requireSession('member');
  return <PortalProfileBody user={{ id: user.id }} />;
}
