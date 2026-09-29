/**
 * 122 US5b-1 (T553) — the member detail page's markup once its data is
 * loaded, split out so the no-DB preview route renders the page's own layout
 * (the US3–US5a pattern). Board `Admin-member-detail`:
 *
 *   header (status, member number and badges above the name; plan · year;
 *   Benefits · Erase · Archive · Edit) → state banners → figures strip →
 *   sticky "On this page" links → Company + Contacts beside Renewal & Health
 *   and Benefits → Invoices → Change requests → Timeline beside Data export.
 *
 * The sections that read their own data arrive as `slots` (the page wraps
 * each in its own Suspense); a slot the viewer does not get is `null`, and
 * the section and its link are left out. Every gate that decides an action
 * (`can`, the member's status and erasure) is applied here exactly as the
 * page did before.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ArchiveIcon, ChartColumnIcon, ExternalLinkIcon, PencilIcon } from 'lucide-react';
import { Badge, Card, StatusPill, buttonClass } from '@jirawatpyk/aura-react/server';
import { formatCalendarYear, formatLocalisedDate } from '@/lib/format-date-localised';
import type { archiveWindowStatus, Contact, MarketingState, Member } from '@/modules/members';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { DynamicBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { InfoHint } from '@/components/shell/info-hint';
import { CopyButton } from '@/components/members/copy-button';
import { DetailField } from '@/components/members/detail-field';
import { MemberNumberField } from '@/components/members/member-number-field';
import { CountryDisplay } from '@/components/members/country-display';
import { ArchivedBanner } from '@/components/members/archived-banner';
import { NoPrimaryContactBanner } from '@/components/members/no-primary-contact-banner';
import { ArchiveMemberButton } from '@/components/members/archive-member-button';
import { EraseMemberButton } from '@/components/members/erase-member-button';
import { ErasedBanner } from '@/components/members/erased-banner';
import { AddContactButton } from './add-contact-button';
import { ContactBlock, type PendingInvitation } from './contact-block';
import { SectionLinks, type SectionLink } from './section-links';

export interface MemberDetailSlots {
  readonly strip: ReactNode;
  readonly renewal: ReactNode;
  /** `null` — F9 off (the benefits page does not exist). */
  readonly benefits: ReactNode | null;
  /** `null` — the viewer may not read invoices. */
  readonly invoices: ReactNode | null;
  readonly timeline: ReactNode;
  /** `null` — the member-change-approval flag is off. */
  readonly changeRequests: ReactNode | null;
  /** A request awaiting review, flagged above the figures (`null` without F114). */
  readonly pendingChangeRequest: ReactNode | null;
  /** `null` — F9 off, no `members.bulk`, or the member is erased. */
  readonly dataExport: ReactNode | null;
}

export interface MemberDetailViewProps {
  readonly member: Member;
  /** The route's `[memberId]` as typed, for the breadcrumb match (a UUID may arrive in upper case). */
  readonly routeSegment?: string;
  readonly contacts: readonly Contact[];
  readonly planDisplayName: string;
  readonly memberNumberDisplay: string;
  readonly legalEntityLabel: string | null | undefined;
  /** The website as a safe http(s) href, or `null` (then shown as text). */
  readonly websiteHref: string | null | undefined;
  readonly windowStatus: ReturnType<typeof archiveWindowStatus> | null;
  readonly erasure: { readonly erasedAt: Date | null; readonly completed: boolean };
  readonly moneyEmailUndeliverable: boolean;
  readonly pendingInvitations: ReadonlyMap<string, PendingInvitation>;
  readonly marketingStates: ReadonlyMap<string, MarketingState>;
  readonly verificationPending: ReadonlySet<string>;
  /** `write` — members.write; `marketing` — contacts.marketing. */
  readonly can: { readonly write: boolean; readonly marketing: boolean };
  readonly features: { readonly f9Dashboard: boolean; readonly f7Broadcasts: boolean };
  readonly locale: string;
  readonly slots: MemberDetailSlots;
}

/** Anchored sections clear the sticky shell bar and the links (56 + 44 px). */
const ANCHOR = 'scroll-mt-28';

/** A group inside the company card: an h3 under the card's h2, as the board has it. */
function SubGroupLabel({ children }: { readonly children: ReactNode }) {
  return (
    <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--aura-fg-secondary)]">{children}</h3>
  );
}

function AddressGroup({ label, lines }: { readonly label: string; readonly lines: readonly string[] }) {
  return (
    <div className="flex flex-col gap-2">
      <SubGroupLabel>{label}</SubGroupLabel>
      {lines.length > 0 ? (
        <p className="text-sm">
          {lines.map((line, i) => (
            <span key={i} className="block">
              {line}
            </span>
          ))}
        </p>
      ) : (
        <p className="text-sm text-[var(--aura-fg-secondary)]">—</p>
      )}
    </div>
  );
}

function TextBlock({ label, lines }: { readonly label: string; readonly lines: readonly string[] }) {
  return (
    <dl>
      <dt className="mb-1 text-xs text-[var(--aura-fg-secondary)]">{label}</dt>
      <dd className="whitespace-pre-wrap text-sm">{lines.length > 0 ? lines.join('\n') : '—'}</dd>
    </dl>
  );
}

export async function renderMemberDetailView({
  member,
  routeSegment,
  contacts,
  planDisplayName,
  memberNumberDisplay,
  legalEntityLabel,
  websiteHref,
  windowStatus,
  erasure,
  moneyEmailUndeliverable,
  pendingInvitations,
  marketingStates,
  verificationPending,
  can,
  features,
  locale,
  slots,
}: MemberDetailViewProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.members.detail');
  const tDir = await getTranslations('admin.members.directory');
  const format = await getFormatter();

  const primary = contacts.find((c) => c.isPrimary && c.removedAt === null);
  const secondary = contacts.filter((c) => !c.isPrimary && c.removedAt === null);
  const isErased = erasure.erasedAt !== null;
  // Post-erase state (COMP-1 US3-A S5): Erase, Archive, Edit and add-contact
  // need write access and a not-yet-erased member; Archive, Edit and
  // add-contact also need a member that is not archived.
  const canModify = can.write && !isErased;
  const notArchived = member.status !== 'archived';
  const year = formatCalendarYear(member.planYear, locale);

  const cityLine = [member.subDistrict, member.city, member.province, member.postalCode]
    .filter((p) => p && p.trim().length > 0)
    .join(' ');
  const addressLines = [member.addressLine1, member.addressLine2, cityLine].filter(
    (l): l is string => Boolean(l && l.trim().length > 0),
  );
  // member-billing-address (0284) — shown only when set ("set" ⟺ line1), with
  // the billing group's own country on the last line, as the §86/4 buyer
  // block will carry it on the next issued document.
  const billingLines = member.billingAddressLine1
    ? [
        member.billingAddressLine1,
        member.billingAddressLine2,
        [member.billingSubDistrict, member.billingCity, member.billingProvince, member.billingPostalCode]
          .filter((p) => p && p.trim().length > 0)
          .join(' '),
        member.billingCountry,
      ].filter((l): l is string => Boolean(l && l.trim().length > 0))
    : null;

  const contactBlock = (c: Contact) => (
    <ContactBlock
      contact={c}
      memberId={member.memberId}
      pendingInvitation={pendingInvitations.get(c.contactId)}
      marketingState={marketingStates.get(c.contactId) ?? 'unavailable'}
      canWrite={can.write}
      canMarketing={can.marketing}
      verificationPending={verificationPending.has(c.contactId)}
      locale={locale}
      t={t}
    />
  );

  const links: SectionLink[] = [
    { id: 'overview', label: t('sectionLinks.overview') },
    { id: 'contacts', label: t('sectionLinks.contacts') },
    ...(slots.invoices ? [{ id: 'invoices', label: t('sectionLinks.invoices') }] : []),
    ...(slots.changeRequests ? [{ id: 'change-requests', label: t('sectionLinks.changeRequests') }] : []),
    { id: 'timeline', label: t('sectionLinks.timeline') },
    ...(slots.dataExport ? [{ id: 'data-export', label: t('sectionLinks.dataExport') }] : []),
  ];

  return (
    <DetailContainer>
      <DynamicBreadcrumbLabel segment={routeSegment ?? member.memberId} label={member.companyName} />
      <PageHeader
        title={member.companyName}
        eyebrow={
          <>
            {member.status === 'archived' ? (
              <Badge tone="neutral" icon={<ArchiveIcon aria-hidden="true" />}>
                {tDir('filters.status.archived')}
              </Badge>
            ) : (
              <StatusPill tone={member.status === 'active' ? 'ready' : 'neutral'}>
                {tDir(`filters.status.${member.status}`)}
              </StatusPill>
            )}
            <Badge tone="neutral" variant="outline" className="font-mono">
              {memberNumberDisplay}
            </Badge>
            {/* 107-auto-invoice Task 15 — read-only enrolment indicator: this
                flag bills the member with no human in the loop, so it sits
                above the fold. Deliberately not a control. */}
            {member.autoInvoiceEnrolledAt != null && (
              <Badge tone="accent">{t('autoInvoiceEnrolledBadge')}</Badge>
            )}
          </>
        }
        subtitle={
          member.status === 'archived'
            ? t('subtitleArchived', { plan: planDisplayName, year })
            : t('subtitle', { plan: planDisplayName, year })
        }
        actions={
          <>
            {features.f9Dashboard && (
              <Link
                href={`/admin/members/${member.memberId}/benefits`}
                className={buttonClass({ variant: 'secondary' })}
              >
                <ChartColumnIcon className="size-4" aria-hidden="true" />
                {t('sections.benefits')}
              </Link>
            )}
            {/* Erase sits left of Archive and Edit (most destructive first,
                Edit rightmost), and shows for an archived member too —
                erasure is orthogonal to archive (UX M2). */}
            {canModify && (
              <>
                <EraseMemberButton
                  memberId={member.memberId}
                  companyName={member.companyName}
                  memberNumberDisplay={memberNumberDisplay}
                />
                {notArchived && (
                  <>
                    <ArchiveMemberButton memberId={member.memberId} companyName={member.companyName} />
                    {/* Edit leads on a phone, as the mobile board has it. */}
                    <Link href={`/admin/members/${member.memberId}/edit`} className={`${buttonClass()} max-sm:order-first`}>
                      <PencilIcon className="size-4" aria-hidden="true" />
                      {t('editCta')}
                    </Link>
                  </>
                )}
              </>
            )}
          </>
        }
      />

      {isErased && erasure.erasedAt && (
        <ErasedBanner erasedAtIso={erasure.erasedAt.toISOString()} completed={erasure.completed} />
      )}
      {!isErased &&
        member.status === 'archived' &&
        member.archivedAt &&
        windowStatus &&
        (windowStatus.state === 'within_window' || windowStatus.state === 'window_expired') && (
          <ArchivedBanner
            memberId={member.memberId}
            archivedAtIso={member.archivedAt.toISOString()}
            windowStatus={windowStatus}
          />
        )}
      {/* 108 FR-003 — money emails are being skipped for this member. */}
      {moneyEmailUndeliverable && <NoPrimaryContactBanner memberId={member.memberId} />}

      {slots.pendingChangeRequest}
      {slots.strip}
      <SectionLinks label={t('sectionLinks.label')} links={links} />

      <div className="grid grid-cols-1 items-start gap-[var(--page-section-gap)] lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-[var(--page-section-gap)]">
          <Card
            as="section"
            id="overview"
            className={ANCHOR}
            title={t('sections.company')}
            titleId="member-company-heading"
            headingLevel={2}
          >
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <SubGroupLabel>{t('sections.organisation')}</SubGroupLabel>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:gap-x-8 xl:grid-cols-3">
                  <DetailField label={t('fields.country')} value={null} extra={<CountryDisplay code={member.country} />} />
                  <DetailField label={t('fields.legalEntityType')} value={legalEntityLabel} />
                  <DetailField
                    label={t('fields.taxId')}
                    value={member.taxId}
                    mono
                    {...(member.taxId
                      ? { extra: <CopyButton value={member.taxId} label={t('copy.copyTaxId')} /> }
                      : {})}
                  />
                  {/* 066 fix — only a safe http(s) URL becomes an anchor; an
                      unsafe scheme falls back to plain text. */}
                  <DetailField
                    label={t('fields.website')}
                    value={websiteHref ? null : member.website || null}
                    {...(websiteHref
                      ? {
                          extra: (
                            <a
                              href={websiteHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex min-w-0 items-center gap-1 text-sm font-medium underline underline-offset-4 hover:no-underline"
                            >
                              {/* Named by the address it shows (2.5.3), then the new-tab note. */}
                              {/* The host and path, as the board shows it; the href keeps the scheme. */}
                              <span className="truncate">{member.website?.replace(/^https?:\/\//i, '').replace(/\/$/, '')}</span>
                              <span className="sr-only">{` (${t('fields.websiteExternal')})`}</span>
                              <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
                            </a>
                          ),
                        }
                      : {})}
                  />
                  <DetailField label={t('fields.foundedYear')} value={member.foundedYear} />
                  <DetailField
                    label={t('fields.turnoverThb')}
                    value={
                      member.turnoverThb !== null
                        ? format.number(member.turnoverThb, { maximumFractionDigits: 2 })
                        : null
                    }
                  />
                  <DetailField
                    label={t('fields.registeredCapitalThb')}
                    value={
                      member.registeredCapitalThb !== null
                        ? format.number(member.registeredCapitalThb, { maximumFractionDigits: 2 })
                        : null
                    }
                  />
                </dl>
              </div>

              <div className="flex flex-col gap-2 border-t border-[var(--aura-border-default)] pt-4">
                <SubGroupLabel>{t('sections.membership')}</SubGroupLabel>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:gap-x-8 xl:grid-cols-3">
                  <DetailField label={t('fields.plan')} value={planDisplayName} />
                  <DetailField label={t('fields.planYear')} value={year} />
                  <DetailField
                    label={t('fields.registrationDate')}
                    value={formatLocalisedDate(member.registrationDate.toISOString(), locale, { dateStyle: 'medium' })}
                  />
                  <DetailField
                    label={t('fields.registrationFeePaid')}
                    value={
                      member.registrationFeePaid ? t('fields.registrationFeePaidYes') : t('fields.registrationFeePaidNo')
                    }
                  />
                  <DetailField
                    label={t('fields.lastActivityAt')}
                    value={
                      member.lastActivityAt
                        ? formatLocalisedDate(member.lastActivityAt.toISOString(), locale, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : null
                    }
                  />
                  {/* 056 fix #9 — archivedAt only when the ArchivedBanner (which
                      already shows the date) is not rendered. */}
                  {member.status === 'archived' && windowStatus === null && member.archivedAt && (
                    <DetailField
                      label={t('fields.archivedAt')}
                      value={formatLocalisedDate(member.archivedAt.toISOString(), locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    />
                  )}
                </dl>
              </div>

              {/* Board: Address and Billing address (tax documents) are groups
                  of their own; an unset one reads "—". */}
              <div className="grid grid-cols-1 gap-4 border-t border-[var(--aura-border-default)] pt-4 md:grid-cols-2">
                <AddressGroup label={t('fields.address')} lines={addressLines} />
                <AddressGroup label={t('fields.billingAddress')} lines={billingLines ?? []} />
              </div>
              {member.description && (
                <div className="border-t border-[var(--aura-border-default)] pt-4">
                  <TextBlock label={t('fields.description')} lines={[member.description]} />
                </div>
              )}
              {member.notes && (
                <div className="border-t border-[var(--aura-border-default)] pt-4">
                  <TextBlock label={t('fields.notes')} lines={[member.notes]} />
                </div>
              )}

              {/* 056 layout C — the raw UUIDs behind a disclosure; the human
                  member number stays in the header. */}
              <details className="border-t border-[var(--aura-border-default)] pt-4">
                <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-[var(--aura-fg-secondary)]">
                  {t('sections.technical')}
                </summary>
                <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 xl:grid-cols-3">
                  <MemberNumberField formatted={memberNumberDisplay} />
                  <DetailField
                    label={t('fields.memberId')}
                    value={member.memberId}
                    mono
                    extra={<CopyButton value={member.memberId} label={t('copy.copyMemberId')} />}
                  />
                  <DetailField label={t('fields.planId')} value={member.planId} mono />
                </dl>
              </details>
            </div>
          </Card>

          <Card
            as="section"
            id="contacts"
            className={ANCHOR}
            title={t('sections.contacts')}
            titleId="member-contacts-heading"
            headingLevel={2}
            // Only Add contact beside the title: AURA's card head does not
            // wrap, so more would squeeze the title on a phone.
            actions={canModify && notArchived ? <AddContactButton memberId={member.memberId} /> : undefined}
          >
            <div className="flex flex-col gap-6">
              <div className="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                {/* T097 — the two-step emergency primary transfer, as a
                    popover so it reaches touch users. */}
                <InfoHint ariaLabel={t('emergencyPrimary.ariaLabel')} triggerClassName="-my-1">
                  <strong className="block">{t('emergencyPrimary.title')}</strong>
                  {t('emergencyPrimary.body')}
                </InfoHint>
                {/* 108 PR-D (US4 s8) — the marketing audience filtered to this
                    member; gated like the page it links to. */}
                {features.f7Broadcasts && (
                  <Link
                    href={`/admin/marketing/audience?member_id=${encodeURIComponent(member.memberId)}&eligible=0`}
                    className="inline-flex min-h-6 items-center text-sm font-medium text-[var(--aura-fg-accent)] underline-offset-4 hover:underline"
                  >
                    {t('marketing.audienceLink')}
                  </Link>
                )}
              </div>
              {primary ? contactBlock(primary) : null}
              {secondary.length > 0 && (
                <div className="flex flex-col gap-6 border-t border-[var(--aura-border-default)] pt-6">
                  <h3 className="text-sm font-medium text-[var(--aura-fg-secondary)]">{t('sections.secondary')}</h3>
                  {secondary.map((c, i) => (
                    <div
                      key={c.contactId}
                      className={i > 0 ? 'border-t border-[var(--aura-border-default)] pt-6' : undefined}
                    >
                      {contactBlock(c)}
                    </div>
                  ))}
                </div>
              )}
              {/* 056 fix #6 — no primary and no other contact. */}
              {!primary && secondary.length === 0 && (
                <p className="py-2 text-sm text-[var(--aura-fg-secondary)]">{t('sections.contactsEmpty')}</p>
              )}
            </div>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-[var(--page-section-gap)]">
          {slots.renewal}
          {slots.benefits}
        </div>
      </div>

      {slots.invoices && (
        <div id="invoices" className={ANCHOR}>
          {slots.invoices}
        </div>
      )}
      {slots.changeRequests && (
        <div id="change-requests" className={ANCHOR}>
          {slots.changeRequests}
        </div>
      )}
      <div
        className={`grid grid-cols-1 items-start gap-[var(--page-section-gap)] ${
          slots.dataExport ? 'lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]' : ''
        }`}
      >
        <div id="timeline" className={`min-w-0 ${ANCHOR}`}>
          {slots.timeline}
        </div>
        {slots.dataExport && (
          <div id="data-export" className={`min-w-0 ${ANCHOR}`}>
            {slots.dataExport}
          </div>
        )}
      </div>
    </DetailContainer>
  );
}
