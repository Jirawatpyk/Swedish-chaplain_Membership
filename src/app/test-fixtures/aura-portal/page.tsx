import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CircleCheck, FileClockIcon, FileText, PencilIcon, TrendingUp, UserPlusIcon } from 'lucide-react';

import { ChangePasswordForm } from '@/components/auth/change-password-form';
import { BenefitUsageCard } from '@/components/benefits/benefit-usage-card';
import { DataExportPanel, type DataExportRow } from '@/components/data-export/data-export-panel';
import { buildDataExportLabels } from '@/components/data-export/data-export-view-model';
import { DirectoryLogoControl } from '@/components/directory/directory-logo-control';
import { DirectoryVisibilityForm } from '@/components/directory/directory-visibility-form';
import { DetailContainer, FormContainer } from '@/components/layout';
import { MemberBottomTabs } from '@/components/layout/member-bottom-tabs';
import { MemberHeader } from '@/components/layout/member-header';
import { PageHeader } from '@/components/layout/page-header';
import { ChangeRequestDiffTable } from '@/components/members/change-requests/change-request-diff-table';
import { ChangeRequestStatusBadge, changeRequestStatusOf } from '@/components/members/change-requests/change-request-status-badge';
import { DecisionOutcomeBanner } from '@/components/members/change-requests/decision-outcome-banner';
import { PendingRequestBanner } from '@/components/members/change-requests/pending-request-banner';
import { PortalChangeRequestForm } from '@/components/members/change-requests/portal-change-request-form';
import { CopyButton } from '@/components/members/copy-button';
import { DetailField } from '@/components/members/detail-field';
import { InviteColleagueForm } from '@/components/members/invite-colleague-form';
import { PortalEditForm } from '@/components/members/portal-edit-form';
import { PortalMarketingToggle } from '@/components/members/portal-marketing-toggle';
import { TimelineFilters } from '@/components/members/timeline-filters';
import { TimelineStream } from '@/components/members/timeline-stream';
import type { TimelineItemProps } from '@/components/members/timeline-event-item';
import { ContactLanguageForm } from '@/components/portal/contact-language-form';
import { StatCard } from '@/components/portal/dashboard/stat-card';
import { PreferredLocaleForm } from '@/components/portal/preferred-locale-form';
import { AuraBadge, AuraCard, AuraStatusPill, auraButtonClass } from '@/components/shell/aura-markup';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';
import { RenewalRemindersToggle } from '@/app/(member)/portal/preferences/renewals/_components/renewal-reminders-toggle';
import { RecentActivityList } from '@/app/(member)/portal/_components/recent-activity-list';
import { BenefitsTabs } from '@/app/(member)/portal/benefits/_components/benefits-tabs';
import PortalNotFound from '@/app/(member)/portal/not-found';

// Request-time evaluation so the guard runs per request (see button-matrix).
export const dynamic = 'force-dynamic';

/**
 * Spec 122 US3 (T310) — the member-portal screens of US3 inside the real
 * member frame with no DB, so they can be screenshot at 390 / 1280 in light
 * and dark and compared with the `Main`, `Benefits`, `Portal-*` boards
 * (`?view=home|benefits|profile|edit|change-request|history|account|invite|
 * directory|timeline|not-found`). Client components render as they ship; the
 * DB-bound page bodies (home, profile, history, account) are rebuilt here from
 * the same parts they use, with fixture data. Nothing here can succeed: a
 * submit reaches the API without a session and only gets an error.
 *
 * Reachable only with `ALLOW_TEST_ROUTES=1` (never set on Vercel), exactly
 * like `/test-fixtures/aura-shell`.
 */

const TS = '2026-09-20T08:30:00.000Z';

const EVENTS: TimelineItemProps[] = [
  { id: 'e1', timestamp: '2026-09-24T09:12:00.000Z', source: 'invoice', eventType: 'invoice_issued', actorKind: 'staff', actorDisplayName: null, payload: null },
  { id: 'e2', timestamp: '2026-09-22T14:05:00.000Z', source: 'payment', eventType: 'payment_succeeded', actorKind: 'member', actorDisplayName: null, payload: null },
  { id: 'e3', timestamp: '2026-09-18T10:40:00.000Z', source: 'event', eventType: 'attendance_recorded', actorKind: 'system', actorDisplayName: null, payload: null },
  { id: 'e4', timestamp: '2026-09-12T07:55:00.000Z', source: 'broadcast', eventType: 'broadcast_sent', actorKind: 'staff', actorDisplayName: null, payload: null },
];

const PENDING: ChangeRequestView = {
  id: '00000000-0000-4000-8000-000000000001',
  memberId: '11111111-1111-4111-8111-111111111111',
  scope: 'own_contact',
  state: 'pending',
  outcome: null,
  withdrawnReason: null,
  submittedAt: TS,
  submittedBy: { contactId: 'c-1', displayName: 'Anna Lindqvist', isMe: true },
  decidedAt: null,
  decidedBy: 'organisation',
  decisionReason: null,
  outcomeAcknowledgedAt: null,
  fields: [
    { key: 'phone', target: 'contact', seen: '+66 81 234 5678', proposed: '+66 89 999 9999', affectsTaxDocuments: false, outcome: null, appliedAt: null },
    {
      key: 'registered_address',
      target: 'member',
      seen: { line1: '1 Sukhumvit Rd', line2: null, sub_district: 'Khlong Toei', city: 'Bangkok', province: 'Bangkok', postal_code: '10110' },
      proposed: { line1: '88 Sathorn Rd', line2: 'Floor 12', sub_district: 'Silom', city: 'Bangkok', province: 'Bangkok', postal_code: '10500' },
      affectsTaxDocuments: true,
      outcome: null,
      appliedAt: null,
    },
  ],
} as unknown as ChangeRequestView;

const DECIDED: ChangeRequestView = {
  ...PENDING,
  id: '00000000-0000-4000-8000-000000000002',
  state: 'decided',
  outcome: 'partially_approved',
  submittedAt: '2026-09-02T08:30:00.000Z',
  decidedAt: '2026-09-04T11:00:00.000Z',
  decisionReason: 'The registered address must match the DBD certificate. Please upload it with your next request.',
  fields: PENDING.fields.map((f) => ({ ...f, outcome: f.key === 'phone' ? 'approved' : 'rejected' })),
} as unknown as ChangeRequestView;

const WITHDRAWN: ChangeRequestView = {
  ...PENDING,
  id: '00000000-0000-4000-8000-000000000003',
  state: 'withdrawn',
  withdrawnReason: 'replaced',
  submittedAt: '2026-08-20T08:30:00.000Z',
  fields: PENDING.fields.slice(0, 1),
} as unknown as ChangeRequestView;

const CR_VALUES = {
  firstName: 'Anna',
  lastName: 'Lindqvist',
  phone: '+66 89 999 9999',
  roleTitle: 'Managing Director',
  companyName: 'Nordic Trading Co., Ltd.',
  website: 'https://nordic.example',
  description: 'Scandinavian design and logistics in Thailand since 2004.',
  regLine1: '88 Sathorn Rd',
  regLine2: 'Floor 12',
  regSubDistrict: 'Silom',
  regCity: 'Bangkok',
  regProvince: 'Bangkok',
  regPostalCode: '10500',
  billLine1: '',
  billLine2: '',
  billSubDistrict: '',
  billCity: '',
  billProvince: '',
  billPostalCode: '',
  billCountry: '',
};

function MemberFrame({ path, children }: { readonly path: string; readonly children: React.ReactNode }) {
  // The member frame as the portal layout composes it (see /test-fixtures/aura-shell?view=member).
  return (
    <div className="chamber-shell flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)]">
        <MemberHeader
          tenantName="SweCham"
          user={{ displayName: 'Anna Lindqvist', email: 'anna@example.com', role: 'member' }}
          currentPath={path}
        />
      </header>
      <main className="flex-1" id="main-content" tabIndex={-1}>
        {children}
      </main>
      <MemberBottomTabs currentPath={path} />
    </div>
  );
}

export default async function AuraPortalPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  if (!process.env.ALLOW_TEST_ROUTES) notFound();
  const { view = 'home' } = await searchParams;

  if (view === 'benefits') {
    const t = await getTranslations('benefits.page');
    return (
      <MemberFrame path="/portal/benefits">
        <DetailContainer>
          <PageHeader title={t('title')} subtitle={t('subtitleMember')} />
          <BenefitsTabs
            showBroadcastsTab={false}
            active="benefits"
            benefitsPanel={
              <BenefitUsageCard
                locale="en"
                membershipYear={2026}
                elapsedYearPct={74}
                quantifiable={[
                  { key: 'eblast', used: 1, entitlement: 4, lastUsedAt: '2026-05-10T00:00:00.000Z', actionHref: '/portal/broadcasts/new' },
                  { key: 'cultural_tickets', used: 2, entitlement: 6, lastUsedAt: '2026-06-02T00:00:00.000Z' },
                ]}
                active={[{ key: 'directory_listing' }, { key: 'm2m_benefits' }]}
                aggregateConsumedPct={30}
                underUseWarning
                warningActionHref="/portal/broadcasts/new"
              />
            }
          />
        </DetailContainer>
      </MemberFrame>
    );
  }

  if (view === 'profile') {
    const t = await getTranslations('portal.profile');
    const tHistory = await getTranslations('portal.changeRequests.history');
    return (
      <MemberFrame path="/portal/profile">
        <DetailContainer>
          <PageHeader
            title="Nordic Trading Co., Ltd."
            subtitle={t('pageTitle')}
            badge={
              <div className="flex flex-wrap items-center gap-2">
                <AuraStatusPill tone="ready">{t('statusBadge.active')}</AuraStatusPill>
                <AuraBadge variant="outline" className="font-mono">SCCM-0042</AuraBadge>
              </div>
            }
            actions={
              <Link href="/portal/edit" className={auraButtonClass()}>
                <PencilIcon className="aura-icon size-4" aria-hidden />
                {t('editButton')}
              </Link>
            }
          />
          <PendingRequestBanner request={PENDING} />
          <AuraCard title={t('organisationSection')} titleId="org-heading" headingLevel={2}>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
              <DetailField
                label={t('fields.memberNumber')}
                value="SCCM-0042"
                mono
                extra={<CopyButton value="SCCM-0042" label={t('fields.memberNumberCopy')} />}
              />
              <DetailField label={t('fields.companyName')} value="Nordic Trading Co., Ltd." />
              <DetailField label={t('fields.website')} value="https://nordic.example" />
            </dl>
          </AuraCard>
          <AuraCard
            title={t('contactsSection')}
            titleId="contacts-heading"
            headingLevel={2}
            actions={
              <Link href="/portal/contacts/invite" className={auraButtonClass({ variant: 'secondary' })}>
                <UserPlusIcon className="aura-icon size-4" aria-hidden />
                {t('inviteColleague')}
              </Link>
            }
          >
            <div className="flex flex-col">
              <div className="flex flex-col gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-body font-medium">Anna Lindqvist</p>
                    <AuraBadge variant="outline">{t('primaryBadge')}</AuraBadge>
                    <AuraBadge variant="outline">{t('portalLinked')}</AuraBadge>
                  </div>
                  <p className="text-[13px] text-[var(--aura-fg-secondary)]">anna@nordic.example</p>
                  <p className="text-[13px] text-[var(--aura-fg-secondary)]">Managing Director</p>
                  <div className="mt-3">
                    <PortalMarketingToggle state="on" isPrimary />
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-4 border-t border-[var(--aura-border-default)] py-4 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-body font-medium">Erik Svensson</p>
                </div>
                <p className="-mt-3 text-[13px] text-[var(--aura-fg-secondary)]">erik@nordic.example</p>
              </div>
            </div>
          </AuraCard>
          <AuraCard
            title={tHistory('profileCard.title')}
            titleId="history-heading"
            headingLevel={2}
            actions={
              <Link href="/portal/change-requests" className={auraButtonClass({ variant: 'secondary' })}>
                <FileClockIcon className="aura-icon size-4" aria-hidden />
                {tHistory('profileCard.link')}
              </Link>
            }
          >
            <p className="text-[var(--aura-fg-secondary)]">{tHistory('profileCard.subtitle')}</p>
          </AuraCard>
        </DetailContainer>
      </MemberFrame>
    );
  }

  if (view === 'edit') {
    const t = await getTranslations('portal.edit');
    return (
      <MemberFrame path="/portal/profile">
        <FormContainer>
          <PageHeader title={t('pageTitle')} />
          <PortalEditForm
            initialValues={{ firstName: 'Anna', lastName: 'Lindqvist', phone: '+66 81 234 5678', website: 'https://nordic.example', description: '' }}
          />
        </FormContainer>
      </MemberFrame>
    );
  }

  if (view === 'change-request') {
    const t = await getTranslations('portal.changeRequests.form');
    return (
      <MemberFrame path="/portal/profile">
        <FormContainer>
          <PageHeader title={t('pageTitle')} />
          <DecisionOutcomeBanner request={DECIDED} />
          <PortalChangeRequestForm
            initialValues={CR_VALUES}
            canProposeCompanyFields
            pending={null}
            privacyNoticeHref="https://swecham.example/privacy"
          />
        </FormContainer>
      </MemberFrame>
    );
  }

  if (view === 'history') {
    const t = await getTranslations('portal.changeRequests.history');
    const tOutcome = await getTranslations('portal.changeRequests.outcome');
    const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
    return (
      <MemberFrame path="/portal/profile">
        <DetailContainer>
          <PageHeader
            title={t('title')}
            subtitle={t('subtitle')}
            actions={<Link href="/portal/profile" className={auraButtonClass({ variant: 'secondary' })}>{t('backToProfile')}</Link>}
          />
          <ul className="flex flex-col gap-4" aria-label={t('listLabel')}>
            {[PENDING, DECIDED, WITHDRAWN].map((r) => (
              <li key={r.id}>
                <AuraCard
                  headingLevel={2}
                  titleId={`h-${r.id}`}
                  title={t('submittedOn', { submittedAt: fmt(r.submittedAt) })}
                  description={
                    <>
                      {t('submittedByYou')}
                      {r.decidedAt ? ` · ${t('decidedOn', { decidedAt: fmt(r.decidedAt) })}` : null}
                    </>
                  }
                  actions={<ChangeRequestStatusBadge status={changeRequestStatusOf(r)} audience="portal" />}
                >
                  <div className="space-y-3">
                    <ChangeRequestDiffTable fields={r.fields} showOutcome={r.state === 'decided'} />
                    {r.decisionReason ? (
                      <div className="rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] p-3 text-sm">
                        <p className="font-medium">{tOutcome('reasonLabel')}</p>
                        <p className="whitespace-pre-wrap break-words">{r.decisionReason}</p>
                      </div>
                    ) : null}
                  </div>
                </AuraCard>
              </li>
            ))}
          </ul>
        </DetailContainer>
      </MemberFrame>
    );
  }

  if (view === 'account') {
    const tPage = await getTranslations('portal.account');
    const tLocale = await getTranslations('portal.preferredLocale');
    const tContactLang = await getTranslations('portal.account.contactLanguage');
    const tExport = await getTranslations('dataExport');
    const rows: DataExportRow[] = [
      { jobId: 'j1', status: 'ready', statusLabel: tExport('statusReady'), downloadable: true, requestedAt: '20 Sept 2026, 15:30' },
      { jobId: 'j2', status: 'expired', statusLabel: tExport('statusExpired'), downloadable: false, requestedAt: '2 Aug 2026, 09:10' },
    ];
    return (
      <MemberFrame path="/portal/account">
        <FormContainer>
          <PageHeader title={tPage('title')} subtitle={tPage('subtitle')} badge={<AuraBadge variant="outline">Member</AuraBadge>} />
          <AuraCard id="account" title={tPage('sections.account')} titleId="account-heading" headingLevel={2} className="scroll-mt-24">
            <div className="space-y-4">
              <p className="text-sm text-[var(--aura-fg-secondary)]">anna@nordic.example</p>
              <ChangePasswordForm />
            </div>
          </AuraCard>
          <AuraCard id="language" title={tLocale('title')} titleId="language-heading" headingLevel={2} className="scroll-mt-24">
            <div className="space-y-2">
              <p className="text-sm text-[var(--aura-fg-secondary)]">{tLocale('description')}</p>
              <PreferredLocaleForm initialValue="en" />
              <div className="mt-6 space-y-2 border-t border-[var(--aura-border-default)] pt-6">
                <h3 className="text-sm font-medium">{tContactLang('title')}</h3>
                <p className="text-sm text-[var(--aura-fg-secondary)]">{tContactLang('description')}</p>
                <ContactLanguageForm initialValue="en" />
              </div>
            </div>
          </AuraCard>
          <AuraCard id="renewal-prefs" title={tPage('sections.renewalPrefs')} titleId="renewal-heading" headingLevel={2} className="scroll-mt-24">
            <RenewalRemindersToggle initialOptedOut={false} />
          </AuraCard>
          <AuraCard id="data-privacy" title={tPage('sections.dataPrivacy')} titleId="privacy-heading" headingLevel={2} className="scroll-mt-24">
            <div className="space-y-4">
              <p className="max-w-prose text-sm text-[var(--aura-fg-secondary)]">{tExport('description')}</p>
              <DataExportPanel rows={rows} labels={buildDataExportLabels(tExport)} />
            </div>
          </AuraCard>
        </FormContainer>
      </MemberFrame>
    );
  }

  if (view === 'invite') {
    const t = await getTranslations('portal.invite');
    return (
      <MemberFrame path="/portal/profile">
        <FormContainer>
          <PageHeader title={t('pageTitle')} subtitle="Nordic Trading Co., Ltd." />
          <InviteColleagueForm />
        </FormContainer>
      </MemberFrame>
    );
  }

  if (view === 'directory') {
    const t = await getTranslations('directorySettings');
    return (
      <MemberFrame path="/portal/profile">
        <DetailContainer>
          <PageHeader title={t('title')} subtitle={t('subtitle')} />
          <AuraCard title={t('logoHeading')} titleId="dir-logo-heading" headingLevel={2}>
            <DirectoryLogoControl currentLogoUrl={null} />
          </AuraCard>
          <DirectoryVisibilityForm
            contact={{ viewerIsPrimary: true, chosenByPrimary: true, hasListing: true }}
            identity={{ companyName: 'Nordic Trading Co., Ltd.', tier: 'Corporate Gold', logoUrl: null, primaryContact: { name: 'Anna Lindqvist', email: 'anna@nordic.example' } }}
            initial={{
              listed: true,
              fieldVisibility: { name: true, industry: true, website: true, contact_name: true, contact_email: false },
              industry: 'Logistics',
              description: 'Scandinavian design and logistics in Thailand since 2004.',
              website: 'https://nordic.example',
              locationCity: 'Bangkok',
              locationCountry: 'TH',
            }}
          />
        </DetailContainer>
      </MemberFrame>
    );
  }

  if (view === 'timeline') {
    const t = await getTranslations('timeline.page');
    return (
      <MemberFrame path="/portal/timeline">
        <DetailContainer>
          <PageHeader title={t('title')} subtitle={t('subtitleMember')} />
          <AuraCard>
            <div className="flex flex-col gap-4">
              <TimelineFilters />
              <TimelineStream
                fetchPath="/api/portal/timeline"
                initialEvents={EVENTS}
                initialCursor="preview-cursor"
                emptyLabel={t('empty')}
                listLabel={t('title')}
              />
            </div>
          </AuraCard>
        </DetailContainer>
      </MemberFrame>
    );
  }

  if (view === 'not-found') {
    return <MemberFrame path="/portal">{await PortalNotFound()}</MemberFrame>;
  }

  // home
  const t = await getTranslations('portal.dashboard.activity');
  return (
    <MemberFrame path="/portal">
      <DetailContainer>
        <PageHeader title="Hi Anna" subtitle="Nordic Trading Co., Ltd." />
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard label="Membership" value="Active" sub="Renews 31 Dec 2026" headIcon={CircleCheck} />
          <StatCard label="Outstanding" value="฿ 21,400.00" sub="1 invoice · due 22 Oct 2026" variant="warning" variantLabel="Due soon" headIcon={FileText} />
          <StatCard label="Benefits used" value="30%" sub="3 of 10 this year" headIcon={TrendingUp} />
        </div>
        <AuraCard title={t('title')} titleId="recent-heading" headingLevel={2}>
          <RecentActivityList events={EVENTS} />
        </AuraCard>
      </DetailContainer>
    </MemberFrame>
  );
}
