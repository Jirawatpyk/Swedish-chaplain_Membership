import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, PencilIcon, UserPlusIcon } from 'lucide-react';
import { Alert, Badge, Card, Icon, StatusPill, buttonClass } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { CopyButton } from '@/components/members/copy-button';
import { CountryDisplay } from '@/components/members/country-display';
import { DetailField } from '@/components/members/detail-field';
import { PortalMarketingToggle } from '@/components/members/portal-marketing-toggle';
import { PendingRequestBanner } from '@/components/members/change-requests/pending-request-banner';
import { DecisionOutcomeBanner } from '@/components/members/change-requests/decision-outcome-banner';
import { ChangeRequestStatusBadge, changeRequestStatusOf } from '@/components/members/change-requests/change-request-status-badge';
import { formatCalendarYear, formatLocalisedDate } from '@/lib/format-date-localised';
import { cn } from '@/lib/utils';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';
import type { Contact, MarketingState, Member } from '@/modules/members';

/**
 * The member's profile as the `Portal-profile` boards draw it — everything
 * `/portal/profile` shows once its reads are done (spec 122 US3). Split from
 * the page so the page keeps the data rules (session → member, the F114
 * gate, the marketing state) and the preview harness renders the SAME markup
 * from sample data. A plain async function rather than a component: the
 * page's tests render the body's returned tree with `renderToStaticMarkup`,
 * which cannot await an async child.
 */
export interface PortalProfileViewProps {
  readonly member: Pick<
    Member,
    'companyName' | 'status' | 'taxId' | 'country' | 'website' | 'foundedYear' | 'description' | 'planYear' | 'registrationDate' | 'lastActivityAt'
  >;
  /** Active contacts only (the page drops removed ones). */
  readonly contacts: readonly Contact[];
  readonly ownContactId: Contact['contactId'] | null;
  readonly isPrimary: boolean;
  readonly ownMarketingState: MarketingState | null;
  readonly pendingRequest: ChangeRequestView | null;
  readonly decidedRequest: ChangeRequestView | null;
  readonly ownRequestReadFailed: boolean;
  /**
   * #239 — the history card's most recent requests (newest first); null when
   * the read did not run or failed, and the card then shows its subtitle.
   */
  readonly recentRequests: readonly ChangeRequestView[] | null;
  readonly planDisplayName: string;
  readonly isIndividual: boolean;
  readonly memberNumberFormatted: string;
  readonly legalEntityLabel: string | null;
  readonly addressText: string | null;
  readonly billingAddressText: string | null;
  /** The website as a safe http(s) link, else null (then shown as text). */
  readonly websiteHref: string | null;
  /** F114 history card (the platform flag). */
  readonly showHistoryLink: boolean;
  /** F9 directory card (the F9 flag). */
  readonly showDirectoryLink: boolean;
}

export async function renderPortalProfileView({
  member: m,
  contacts,
  ownContactId,
  isPrimary,
  ownMarketingState,
  pendingRequest,
  decidedRequest,
  ownRequestReadFailed,
  recentRequests,
  planDisplayName,
  isIndividual,
  memberNumberFormatted,
  legalEntityLabel,
  addressText,
  billingAddressText,
  websiteHref,
  showHistoryLink,
  showDirectoryLink,
}: PortalProfileViewProps) {
  const t = await getTranslations('portal.profile');
  const tDir = await getTranslations('directorySettings');
  const tHistory = await getTranslations('portal.changeRequests.history');
  const tPending = await getTranslations('portal.changeRequests.pending');
  const tDiff = await getTranslations('portal.changeRequests.diff');
  const locale = await getLocale();

  // #239 — a request's row date: when it was decided or withdrawn, else sent,
  // with the screen-reader word that says which.
  const rowDate = (r: ChangeRequestView): { iso: string; label: 'dateDecided' | 'dateWithdrawn' | 'dateSent' } =>
    r.state === 'decided' && r.decidedAt
      ? { iso: r.decidedAt, label: 'dateDecided' }
      : r.state === 'withdrawn' && r.withdrawnAt
        ? { iso: r.withdrawnAt, label: 'dateWithdrawn' }
        : { iso: r.submittedAt, label: 'dateSent' };
  // a request always carries a field; one that does not has nothing to name
  const recentRows = recentRequests?.filter((r) => r.fields.length > 0) ?? null;

  // #239 — the Organisation fields a phone folds under "More details". Each
  // renders in the grid (from 768px) and in the disclosure (below it).
  const secondary = {
    legalEntity: (className: string) =>
      isIndividual ? null : <DetailField label={t('fields.legalEntityType')} value={legalEntityLabel} className={className} />,
    country: (className: string) => (
      <DetailField label={t('fields.country')} value={null} className={className} extra={<CountryDisplay code={m.country} />} />
    ),
    website: (className: string) =>
      websiteHref ? (
        <DetailField
          label={t('fields.website')}
          value={null}
          className={className}
          extra={
            <a
              href={websiteHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 items-center gap-1 text-sm text-[var(--aura-fg-accent)] no-underline hover:text-[var(--aura-fg-primary)] hover:underline"
            >
              <span className="truncate">{m.website}</span>
              <Icon name={<ExternalLinkIcon />} size={14} />
            </a>
          }
        />
      ) : (
        <DetailField label={t('fields.website')} value={m.website || null} className={className} />
      ),
    founded: (className: string) =>
      isIndividual ? null : <DetailField label={t('fields.foundedYear')} value={m.foundedYear} className={className} />,
    description: (className: string) =>
      m.description ? <DetailField label={t('fields.description')} value={m.description} className={className} /> : null,
  };

  return (
    <DetailContainer>
      <PageHeader
        title={m.companyName}
        subtitle={t('pageTitle')}
        badge={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={m.status === 'active' ? 'ready' : 'neutral'}>
              {t(`statusBadge.${m.status}`)}
            </StatusPill>
            <Badge variant="outline" className="font-mono">
              {memberNumberFormatted}
            </Badge>
          </div>
        }
        actions={
          <Link href="/portal/edit" className={buttonClass()}>
            <Icon name={<PencilIcon />} size={16} />
            {/* While a request waits, the edit page amends it (the board's label). */}
            {pendingRequest ? tPending('editLink') : t('editButton')}
          </Link>
        }
      />

      {/* F114 — awaiting-review banner (role=status), above the record it will change. */}
      {pendingRequest ? <PendingRequestBanner request={pendingRequest} /> : null}
      {ownRequestReadFailed ? (
        <div data-testid="portal-own-request-unavailable">
          <Alert tone="danger" role="status">
            {tPending('loadFailed')}
          </Alert>
        </div>
      ) : null}
      {/* F114 US3 — the shown decision (role=status) until dismissed; never alongside a pending one. */}
      {!pendingRequest && decidedRequest ? <DecisionOutcomeBanner request={decidedRequest} /> : null}

      {/* Organisation — who the member is. The `Portal-profile` board's
          grid: one field per cell, three across from 1024px (two from 768px),
          16px between rows and 24px between columns. #239: below 768px, where
          the grid is one column, the card keeps the fields a member checks
          against an invoice (number, company, Tax ID, the two addresses) and
          folds the rest into "More details"; the folded fields render twice,
          once per width, and only one copy is ever displayed. */}
      <Card title={t('organisationSection')} titleId="portal-profile-org-heading" headingLevel={2}>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 lg:grid-cols-3">
              <DetailField
                label={t('fields.memberNumber')}
                value={memberNumberFormatted}
                mono
                className={FIELD}
                extra={
                  <CopyButton
                    value={memberNumberFormatted}
                    label={t('fields.memberNumberCopy')}
                  />
                }
              />
              <DetailField label={t('fields.companyName')} value={m.companyName} className={FIELD} />
              {secondary.legalEntity(`${FIELD} max-md:hidden`)}
              {/* 067 — members get their tax_id on every issued tax invoice;
                  surface it here so they can verify the value the chamber has
                  on file (and notice when it is missing — the §86/4 buyer TIN).
                  Own-profile PII, member-visible by design. DetailField shows
                  the "—" placeholder when null (no-TIN members). */}
              <DetailField label={t('fields.taxId')} value={m.taxId} mono className={FIELD} />
              {secondary.country(`${FIELD} max-md:hidden`)}
              {secondary.website(`${FIELD} max-md:hidden`)}
              {secondary.founded(`${FIELD} max-md:hidden`)}
              {/* 069 — §86/4 buyer address on file (read-only; admin-managed). */}
              <DetailField label={t('fields.address')} value={addressText} className={FIELD} />
              {/* member-billing-address (0284) — "—" when none is set, as the board draws the row. */}
              <DetailField label={t('fields.billingAddress')} value={billingAddressText} className={FIELD} />
              {secondary.description(`${FIELD} max-md:hidden md:col-span-2 lg:col-span-3`)}
            </dl>
            <details className="group mt-1 md:hidden">
              {/* 44px on phones by hand: AURA has no text-link touch rule yet.
                  Stand-in until AURA #172. */}
              <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1 rounded-[var(--aura-radius-sm)] text-sm font-medium text-[var(--aura-fg-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aura-focus-ring)] [&::-webkit-details-marker]:hidden">
                {t('moreDetails')}
                <Icon name={<ChevronDownIcon />} size={16} className="transition-transform group-open:rotate-180 motion-reduce:transition-none" />
              </summary>
              <dl className="mt-2 grid grid-cols-1 gap-y-4">
                {secondary.legalEntity(FIELD)}
                {secondary.country(FIELD)}
                {secondary.website(FIELD)}
                {secondary.founded(FIELD)}
                {secondary.description(FIELD)}
              </dl>
            </details>
      </Card>

      {/* Membership — the chamber relationship. */}
      <Card title={t('membershipSection')} titleId="portal-profile-membership-heading" headingLevel={2}>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
              <DetailField
                label={t('fields.planName')}
                value={planDisplayName}
                className={FIELD}
              />
              <DetailField
                label={t('fields.planYear')}
                value={formatCalendarYear(m.planYear, locale)}
                className={FIELD}
              />
              <DetailField
                className={FIELD}
                label={t('fields.registrationDate')}
                value={formatLocalisedDate(
                  m.registrationDate.toISOString(),
                  locale,
                  { dateStyle: 'medium' },
                )}
              />
              <DetailField
                className={FIELD}
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
      </Card>

      {/* Contacts — primary + others. */}
      <Card
        title={t('contactsSection')}
        titleId="portal-profile-contacts-heading"
        headingLevel={2}
        actions={
          isPrimary ? (
            // A 44px touch target on phones, as `Portal-profile-mobile` draws it.
            <Link href="/portal/contacts/invite" className={cn(buttonClass({ variant: 'secondary' }), 'max-sm:h-11')}>
              <Icon name={<UserPlusIcon />} size={16} />
              {t('inviteColleague')}
            </Link>
          ) : undefined
        }
      >
            <div className="flex flex-col">
              {contacts.map((contact) => {
                const own = ownContactId !== null && contact.contactId === ownContactId;
                return (
                // The `Portal-profile` board's row: a hairline between rows;
                // from 768px name (with its chips under it) · email · phone ·
                // role in four columns. Phones read name, role, email, phone.
                <div key={contact.contactId} className="border-t border-[var(--aura-border-default)] py-3.5 first:border-t-0 first:pt-0">
                  <div className="flex flex-col gap-1 md:grid md:grid-cols-[1.3fr_1.4fr_1fr_1fr] md:items-center md:gap-4">
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="text-body font-semibold">
                        {`${contact.firstName} ${contact.lastName}`.trim()}
                        {own ? ` ${t('youSuffix')}` : ''}
                      </p>
                      {contact.isPrimary || contact.linkedUserId ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {contact.isPrimary && <Badge variant="outline">{t('primaryBadge')}</Badge>}
                          {contact.linkedUserId && <Badge variant="outline">{t('portalLinked')}</Badge>}
                        </div>
                      ) : null}
                    </div>
                    {contact.roleTitle ? (
                      <p className="aura-text-table-cell text-[var(--aura-fg-secondary)] md:order-last md:text-sm">{contact.roleTitle}</p>
                    ) : (
                      <span className="max-md:hidden md:order-last" aria-hidden />
                    )}
                    {/* #239: email and phone share one wrapping row on phones,
                        each still a 44px target; from 768px the wrapper steps
                        aside and they are grid columns again. */}
                    <div className="flex flex-wrap gap-x-4 gap-y-2 md:contents">
                      <a
                        href={`mailto:${contact.email}`}
                        className="flex min-h-11 min-w-0 items-center text-sm text-[var(--aura-fg-accent)] no-underline [overflow-wrap:anywhere] hover:underline md:min-h-0 md:text-[var(--aura-fg-primary)]"
                      >
                        {contact.email}
                      </a>
                      {contact.phone ? (
                        <a
                          href={`tel:${contact.phone.replace(/\s+/g, '')}`}
                          className="flex min-h-11 items-center text-sm text-[var(--aura-fg-accent)] no-underline hover:underline md:min-h-0 md:text-[var(--aura-fg-primary)]"
                        >
                          {contact.phone}
                        </a>
                      ) : (
                        <span className="max-md:hidden" aria-hidden />
                      )}
                    </div>
                  </div>
                  {/* 108 PR-D (US6) — the signed-in contact's OWN marketing
                      control, under the row at its full width; never rendered
                      on another contact's row. */}
                  {own && ownMarketingState !== null && (
                    <div className="mt-2.5">
                      <PortalMarketingToggle state={ownMarketingState} isPrimary={contact.isPrimary} />
                    </div>
                  )}
                </div>
                );
              })}
              {contacts.length === 0 && (
                <p className="text-[var(--aura-fg-secondary)]">{t('noContacts')}</p>
              )}
            </div>
      </Card>

      {/* The two cards under the record: side by side from 768px (the
          `Portal-profile` board). F114 US4 (FR-029) history is gated on the
          platform flag (the page notFounds when dark; shown regardless of the
          tenant setting); the F9 directory card on the F9 flag. Real <h2>s.
          #239: the history card lists the two most recent requests as compact
          rows (the field, then status · date; never the values) at every width, with
          View all to the history page. Phones keep the directory as a list row
          (`Portal-profile-mobile`). */}
      {showHistoryLink || showDirectoryLink ? (
        // with history off, the grid only holds the desktop directory card:
        // hide it on phones so it adds no empty section gap there
        <div className={cn('grid gap-4 md:grid-cols-2 [&>*:only-child]:md:col-span-2', !showHistoryLink && 'max-md:hidden')}>
          {showHistoryLink ? (
            <Card
              title={tHistory('profileCard.title')}
              titleId="portal-profile-change-requests-heading"
              headingLevel={2}
              actions={
                <Link
                  href="/portal/change-requests"
                  className={cn(buttonClass({ variant: 'secondary' }), 'max-sm:h-11')}
                  data-testid="profile-history-link"
                >
                  {recentRows && recentRows.length > 0 ? tHistory('profileCard.viewAll') : tHistory('profileCard.viewHistory')}
                </Link>
              }
            >
              {recentRows && recentRows.length > 0 ? (
                <ul className="flex flex-col">
                  {recentRows.map((r) => {
                    const [first, ...rest] = r.fields;
                    const date = rowDate(r);
                    return (
                      <li
                        key={r.id}
                        data-testid="profile-recent-request"
                        className="border-t border-[var(--aura-border-default)] first:border-t-0"
                      >
                        {/* the row opens its request on the history page (a 44px target) */}
                        <Link
                          href={`/portal/change-requests#request-${r.id}`}
                          className="-mx-2 flex min-h-11 flex-col justify-center gap-1 rounded-[var(--aura-radius-sm)] px-2 py-2.5 text-[var(--aura-fg-primary)] no-underline hover:bg-[var(--aura-bg-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aura-focus-ring)]"
                        >
                          <span className="min-w-0 font-medium">
                            {first ? tDiff(`labels.${first.key}`) : null}
                            {rest.length > 0 ? (
                              <span className="font-normal text-[var(--aura-fg-secondary)]">
                                {' '}
                                {tHistory('profileCard.moreFields', { count: rest.length })}
                              </span>
                            ) : null}
                          </span>
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <ChangeRequestStatusBadge status={changeRequestStatusOf(r)} audience="portal" />
                            <span className="aura-text-table-cell text-[var(--aura-fg-secondary)] tabular-nums">
                              <span className="sr-only">{tHistory(`profileCard.${date.label}`)} </span>
                              <time dateTime={date.iso}>{formatLocalisedDate(date.iso, locale, { dateStyle: 'medium' })}</time>
                            </span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                // no requests yet says so; a read that did not run keeps the card's description
                <p className="text-[var(--aura-fg-secondary)]">
                  {recentRows ? tHistory('profileCard.empty') : tHistory('profileCard.subtitle')}
                </p>
              )}
            </Card>
          ) : null}
          {showDirectoryLink ? (
            <Card
              title={tDir('title')}
              titleId="portal-profile-directory-heading"
              headingLevel={2}
              className="max-md:hidden"
              actions={
                <Link href="/portal/profile/directory" className={buttonClass({ variant: 'secondary' })}>
                  {tDir('manage')}
                </Link>
              }
            >
              <p className="text-[var(--aura-fg-secondary)]">{tDir('subtitle')}</p>
            </Card>
          ) : null}
        </div>
      ) : null}
      {showDirectoryLink ? (
        <Card as="nav" aria-label={t('moreAboutProfile')} className="md:hidden">
          <Link
            href="/portal/profile/directory"
            className="flex min-h-14 items-center gap-3 px-4 py-3 text-[var(--aura-fg-primary)] no-underline"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold">{tDir('title')}</span>
              <span className="text-xs text-[var(--aura-fg-secondary)]">{tDir('subtitle')}</span>
            </span>
            <Icon name={<ChevronRightIcon />} size={16} className="text-[var(--aura-fg-secondary)]" />
          </Link>
        </Card>
      ) : null}
    </DetailContainer>
  );
}

/**
 * A field of the board's grid: the dt 2px over its value at the cards' 1.7
 * line height, no padding of its own (the grid's gaps space them).
 */
const FIELD = 'gap-0.5 py-0 [&>dt]:leading-[1.7] [&>dd]:leading-[1.7]';
