import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CircleCheck, FileText, TrendingUp } from 'lucide-react';

import { PortalBenefitsPanel } from '@/components/benefits/portal-benefits-panel';
import type { DataExportRow } from '@/components/data-export/data-export-panel';
import { DirectoryLogoControl } from '@/components/directory/directory-logo-control';
import { DirectoryVisibilityForm } from '@/components/directory/directory-visibility-form';
import { DetailContainer, FormContainer } from '@/components/layout';
import { MemberBottomTabs } from '@/components/layout/member-bottom-tabs';
import { MemberHeader } from '@/components/layout/member-header';
import { BreadcrumbProvider } from '@/components/layout/breadcrumb-provider';
import { PageHeader } from '@/components/layout/page-header';
import { renderChangeRequestHistoryView } from '@/components/members/change-requests/change-request-history-view';
import { PortalChangeRequestForm } from '@/components/members/change-requests/portal-change-request-form';
import { InviteColleagueForm } from '@/components/members/invite-colleague-form';
import { BackLink } from '@/components/portal/back-link';
import { PortalEditForm } from '@/components/members/portal-edit-form';
import { renderPortalProfileView, type PortalProfileViewProps } from '@/components/members/portal-profile-view';
import { renderPortalAccountView } from '@/components/portal/portal-account-view';
import { TimelineFilters } from '@/components/members/timeline-filters';
import { TimelineStream } from '@/components/members/timeline-stream';
import type { TimelineItemProps } from '@/components/members/timeline-event-item';
import { StatCard } from '@/components/portal/dashboard/stat-card';
import { InvoicesSummaryView } from '@/components/portal/invoices-summary-card';
import { PortalBenefitsSummaryCard } from '@/components/benefits/portal-benefits-summary-card';
import type { Invoice } from '@/modules/invoicing';
import type { Contact } from '@/modules/members';
import { Badge, Card, StatusPill } from '@jirawatpyk/aura-react/server';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';
import { RecentActivityList } from '@/app/(member)/portal/_components/recent-activity-list';
import { MembershipInvoiceAlert } from '@/app/(member)/portal/_components/membership-invoice-alert';
import { BenefitsTabs } from '@/app/(member)/portal/benefits/_components/benefits-tabs';
import PortalNotFound from '@/app/(member)/portal/not-found';
import { renderPortalInvoicesView } from '@/app/(member)/portal/invoices/page';
import { renderPortalInvoiceDetailView } from '@/app/(member)/portal/invoices/[invoiceId]/page';
import { renderPortalCreditNoteView } from '@/app/(member)/portal/credit-notes/[creditNoteId]/page';
import { toInvoiceRowViewModel } from '@/app/(member)/portal/invoices/_utils/invoice-row-view-model';
import { PayPreview, type PayPreviewState } from './pay-preview';

// Request-time evaluation so the guard runs per request (see button-matrix).
export const dynamic = 'force-dynamic';

/**
 * Spec 122 US3 (T310) — the member-portal screens of US3 inside the real
 * member frame with no DB, so they can be screenshot at 390 / 1280 in light
 * and dark and compared with the `Main`, `Benefits`, `Portal-*` boards
 * (`?view=home|benefits|profile|edit|change-request|history|account|invite|
 * directory|timeline|not-found`). Client components render as they ship;
 * profile and history render through the pages' own view functions; the
 * other DB-bound bodies (home, account) are rebuilt here from the same parts
 * they use, with fixture data. Nothing here can succeed: a
 * submit reaches the API without a session and only gets an error.
 *
 * Reachable only with `ALLOW_TEST_ROUTES=1` (never set on Vercel), exactly
 * like `/test-fixtures/aura-shell`.
 */

// Dated from now so the timeline shows its Today / This month / month groups.
const ago = (days: number, hours = 0): string => new Date(Date.now() - (days * 24 + hours) * 3_600_000).toISOString();
const EVENTS: TimelineItemProps[] = [
  { id: 'e1', timestamp: ago(0, 1), source: 'payment', eventType: 'succeeded', actorKind: 'member', actorDisplayName: null, payload: { document_number: 'SC-2026-000123', payment_method: 'promptpay' } },
  { id: 'e2', timestamp: ago(5), source: 'audit', eventType: 'member_change_request_submitted', actorKind: 'member', actorUserId: '', actorDisplayName: null, payload: { scope: 'company', field_keys: ['registered_address', 'website'] } },
  { id: 'e3', timestamp: ago(12), source: 'invoice', eventType: 'issued', actorKind: 'staff', actorDisplayName: null, payload: { document_number: 'SC-2026-000123' } },
  { id: 'e4', timestamp: ago(12), source: 'renewal', eventType: 'reminded', actorKind: 'system', actorDisplayName: null, payload: null },
  { id: 'e5', timestamp: ago(22), source: 'event', eventType: 'attended', actorKind: 'member', actorDisplayName: null, payload: { event_name: 'Crayfish Party 2026' } },
  { id: 'e6', timestamp: ago(86), source: 'broadcast', eventType: 'sent', actorKind: 'member', actorDisplayName: null, payload: { broadcast_subject: 'New office on Wireless Road' } },
];

const ADDR_OLD = { line1: '98 Sathorn Road', line2: null, sub_district: 'Silom, Bang Rak', city: 'Bangkok', province: null, postal_code: '10500' };
const ADDR_NEW = { line1: '55 Wireless Road', line2: null, sub_district: 'Lumphini, Pathum Wan', city: 'Bangkok', province: null, postal_code: '10330' };

// The `Portal-profile` / `Portal-change-requests` / `Portal-edit` boards' data.
const PENDING: ChangeRequestView = {
  id: '00000000-0000-4000-8000-000000000001',
  memberId: '11111111-1111-4111-8111-111111111111',
  scope: 'organisation',
  state: 'pending',
  outcome: null,
  withdrawnReason: null,
  withdrawnAt: null,
  submittedAt: '2026-09-22T07:10:00.000Z',
  submittedBy: { contactId: 'c-1', displayName: 'Anna Lindqvist', isMe: true },
  decidedAt: null,
  decidedBy: 'organisation',
  decisionReason: null,
  outcomeAcknowledgedAt: null,
  fields: [
    { key: 'registered_address', target: 'member', seen: ADDR_OLD, proposed: ADDR_NEW, affectsTaxDocuments: true, outcome: null, appliedAt: null },
    { key: 'website', target: 'member', seen: 'lindqvist.example', proposed: 'lindqvistpartners.example', affectsTaxDocuments: false, outcome: null, appliedAt: null },
  ],
} as unknown as ChangeRequestView;

const DECIDED: ChangeRequestView = {
  ...PENDING,
  id: '00000000-0000-4000-8000-000000000002',
  scope: 'mixed',
  state: 'decided',
  outcome: 'partially_approved',
  submittedAt: '2026-08-02T02:30:00.000Z',
  decidedAt: '2026-08-04T04:00:00.000Z',
  decisionReason: 'A company name change needs the DBD certificate. Contact the chamber office about the document, then submit a new request.',
  fields: [
    { key: 'phone', target: 'contact', seen: '+66 81 234 0000', proposed: '+66 81 234 5678', affectsTaxDocuments: false, outcome: 'approved', appliedAt: '2026-08-04T04:00:00.000Z' },
    { key: 'company_name', target: 'member', seen: 'Lindqvist & Partners Co., Ltd.', proposed: 'Lindqvist Partners (Thailand) Co., Ltd.', affectsTaxDocuments: true, outcome: 'rejected', appliedAt: null },
  ],
} as unknown as ChangeRequestView;

const WITHDRAWN: ChangeRequestView = {
  ...PENDING,
  id: '00000000-0000-4000-8000-000000000003',
  scope: 'own_contact',
  state: 'withdrawn',
  withdrawnReason: 'member',
  withdrawnAt: '2026-05-12T09:30:00.000Z',
  submittedAt: '2026-05-12T09:02:00.000Z',
  fields: [{ key: 'role_title', target: 'contact', seen: 'Director', proposed: 'Managing Director', affectsTaxDocuments: false, outcome: null, appliedAt: null }],
} as unknown as ChangeRequestView;

const CONTACTS = [
  { contactId: 'c-1', firstName: 'Anna', lastName: 'Lindqvist', email: 'anna.lindqvist@lindqvist.example', phone: '+66 81 234 5678', roleTitle: 'Managing Director', isPrimary: true, linkedUserId: 'u-1' },
  { contactId: 'c-2', firstName: 'Johan', lastName: 'Berg', email: 'johan.berg@lindqvist.example', phone: '+66 89 555 0142', roleTitle: 'Finance Manager', isPrimary: false, linkedUserId: 'u-2' },
] as unknown as Contact[];

const CR_VALUES = {
  firstName: 'Anna',
  lastName: 'Lindqvist',
  phone: '+66 81 234 5678',
  roleTitle: 'Managing Director',
  companyName: 'Lindqvist & Partners Co., Ltd.',
  website: 'https://lindqvistpartners.example',
  description: 'Nordic–Thai trade advisory: market entry, sourcing and partner search.',
  regLine1: '55 Wireless Road',
  regLine2: '',
  regSubDistrict: 'Lumphini, Pathum Wan',
  regCity: 'Bangkok',
  regProvince: '',
  regPostalCode: '10330',
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
    <div className="chamber-shell chamber-portal flex min-h-screen flex-col">
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
  searchParams: Promise<{ view?: string; state?: string }>;
}) {
  if (!process.env.ALLOW_TEST_ROUTES) notFound();
  const sp = await searchParams;
  const { view = 'home' } = sp;

  if (view === 'benefits') {
    // The `Benefits` / `Benefits-mobile` board data.
    const t = await getTranslations('benefits.page');
    return (
      <MemberFrame path="/portal/benefits">
        <DetailContainer>
          <PageHeader
            title={t('title')}
            subtitle={t('subtitlePlanEblasts', { plan: 'Premium Corporate' })}
            size="hero-lg"
            meta={
              <>
                <Badge tone="accent" variant="solid">Premium Corporate</Badge>
                <StatusPill tone="ready">{t('statusFull')}</StatusPill>
              </>
            }
          />
          <BenefitsTabs
            showBroadcastsTab
            active="benefits"
            broadcastsPanel={null}
            benefitsPanel={
              <PortalBenefitsPanel
                locale="en"
                membershipYear={2026}
                elapsedYearPct={74}
                quantifiable={[
                  { key: 'eblast', used: 2, entitlement: 6, lastUsedAt: '2026-07-03T08:00:00.000Z', actionHref: '/portal/broadcasts/new' },
                  { key: 'cultural_tickets', used: 0, entitlement: 2, lastUsedAt: null },
                ]}
                active={[
                  { key: 'directory_listing' },
                  { key: 'all_employee_event_discount' },
                  { key: 'm2m_benefits' },
                  { key: 'business_referrals' },
                  { key: 'tailor_made_services' },
                ]}
                aggregateConsumedPct={60}
                underUseWarning={false}
                planName="Premium Corporate"
              />
            }
          />
        </DetailContainer>
      </MemberFrame>
    );
  }

  if (view === 'profile') {
    return (
      <MemberFrame path="/portal/profile">
        {await renderPortalProfileView({
          member: {
            companyName: 'Lindqvist & Partners Co., Ltd.',
            status: 'active',
            taxId: '0105559876541',
            country: 'TH',
            website: 'lindqvist.example',
            foundedYear: 2011,
            description: null,
            planYear: 2026,
            registrationDate: new Date('2019-01-12T03:00:00.000Z'),
            lastActivityAt: new Date('2026-09-24T02:12:00.000Z'),
          } as unknown as PortalProfileViewProps['member'],
          contacts: CONTACTS,
          ownContactId: CONTACTS[0]!.contactId,
          isPrimary: true,
          ownMarketingState: 'on',
          pendingRequest: PENDING,
          decidedRequest: null,
          ownRequestReadFailed: false,
          planDisplayName: 'Premium Corporate',
          isIndividual: false,
          memberNumberFormatted: 'TSCC-0042',
          legalEntityLabel: 'Limited company',
          addressText: '98 Sathorn Road, Silom, Bang Rak, Bangkok 10500',
          billingAddressText: null,
          websiteHref: 'https://lindqvist.example',
          showHistoryLink: true,
          showDirectoryLink: true,
        })}
      </MemberFrame>
    );
  }

  if (view === 'edit') {
    const t = await getTranslations('portal.edit');
    return (
      <MemberFrame path="/portal/edit">
        <FormContainer>
          <PageHeader title={t('pageTitle')} size="hero" />
          <PortalEditForm
            initialValues={{ firstName: 'Anna', lastName: 'Lindqvist', phone: '+66 81 234 5678', website: 'https://nordic.example', description: '' }}
          />
        </FormContainer>
      </MemberFrame>
    );
  }

  if (view === 'change-request') {
    const t = await getTranslations('portal.changeRequests.form');
    // As /portal/edit renders its approval branch (page.tsx) with a pending request.
    return (
      <MemberFrame path="/portal/edit">
        <FormContainer className="max-w-[calc(55rem+2*var(--page-padding-x))]">
          <PageHeader title={t('pageTitle')} subtitle={t('pageSubtitle')} size="hero" />
          <PortalChangeRequestForm
            initialValues={CR_VALUES}
            canProposeCompanyFields
            pending={PENDING}
            privacyNoticeHref="https://swecham.example/privacy"
          />
        </FormContainer>
      </MemberFrame>
    );
  }

  if (view === 'history') {
    return (
      <MemberFrame path="/portal/change-requests">
        {await renderChangeRequestHistoryView({ items: [PENDING, DECIDED, WITHDRAWN], nextCursor: 'fixture', isFirstPage: true })}
      </MemberFrame>
    );
  }

  if (view === 'account') {
    const tExport = await getTranslations('dataExport');
    // The `Portal-account` board's rows.
    const rows: DataExportRow[] = [
      { jobId: 'j0', status: 'processing', statusLabel: tExport('statusPending'), downloadable: false, requestedAt: '24 Sept 2026, 11:02' },
      { jobId: 'j1', status: 'ready', statusLabel: tExport('statusReady'), downloadable: true, requestedAt: '24 Sept 2026, 09:40' },
      { jobId: 'j2', status: 'expired', statusLabel: tExport('statusExpired'), downloadable: false, requestedAt: '2 Jun 2026, 16:05' },
    ];
    return (
      <MemberFrame path="/portal/account">
        <DetailContainer>
          {await renderPortalAccountView({
            email: 'anna.lindqvist@lindqvist.example',
            roleLabel: 'Member',
            initialLocale: null,
            contactLanguage: 'en',
            hasMember: true,
            initialOptedOut: false,
            showDataPrivacy: true,
            exportsReadFailed: false,
            exportRows: rows,
            privacyContactEmail: 'privacy@swecham.example',
            privacyPolicyUrl: 'https://swecham.example/privacy',
          })}
        </DetailContainer>
      </MemberFrame>
    );
  }

  if (view === 'invite') {
    const t = await getTranslations('portal.invite');
    const tHistory = await getTranslations('portal.changeRequests.history');
    // As /portal/contacts/invite renders it (page.tsx `InviteFrame`).
    return (
      <MemberFrame path="/portal/contacts/invite">
        <DetailContainer>
          <BackLink href="/portal/profile">{tHistory('backToProfile')}</BackLink>
          <div className="flex max-w-[720px] flex-col gap-[var(--page-section-gap)]">
            <PageHeader title={t('pageTitle')} subtitle="Lindqvist & Partners Co., Ltd." />
            <InviteColleagueForm privacyNoticeHref="https://swecham.example/privacy" />
          </div>
        </DetailContainer>
      </MemberFrame>
    );
  }

  if (view === 'directory') {
    const t = await getTranslations('directorySettings');
    const tHistory = await getTranslations('portal.changeRequests.history');
    // A sample logo (the boards show one); served from /public, no Blob needed.
    const logo = '/icon-192.png';
    // As /portal/profile/directory renders it (page.tsx), with the boards' data.
    return (
      <MemberFrame path="/portal/profile/directory">
        <DetailContainer>
          <BackLink href="/portal/profile">{tHistory('backToProfile')}</BackLink>
          <PageHeader title={t('title')} subtitle={t('subtitle')} />
          <DirectoryVisibilityForm
            logoCard={
              <Card title={t('logoHeading')} titleId="dir-logo-heading" headingLevel={2}>
                <DirectoryLogoControl currentLogoUrl={logo} />
              </Card>
            }
            contact={{ viewerIsPrimary: true, chosenByPrimary: true, hasListing: true }}
            identity={{
              companyName: 'Lindqvist & Partners Co., Ltd.',
              tier: 'Premium Corporate',
              logoUrl: logo,
              primaryContact: { name: 'Anna Lindqvist', email: 'anna.lindqvist@lindqvist.example' },
            }}
            initial={{
              listed: true,
              fieldVisibility: { name: true, tier: true, industry: true, description: true, website: true, logo: true, location: true, contact_name: true, contact_email: false },
              industry: 'Management consulting',
              description: 'Nordic–Thai management consultancy helping Swedish companies set up and grow in Thailand.',
              website: 'https://lindqvist.example',
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
          <Card>
            <div className="flex flex-col gap-4">
              <TimelineFilters />
              <TimelineStream
                fetchPath="/api/portal/timeline"
                initialEvents={EVENTS}
                initialCursor="preview-cursor"
                emptyLabel={t('empty')}
                listLabel={t('title')}
                audience="member"
              />
            </div>
          </Card>
        </DetailContainer>
      </MemberFrame>
    );
  }

  // Spec 122 US4 — the `Invoices`, `Invoice-paid` / `Portal-invoice-mobile`,
  // `Portal-credit-note` and `Pay-*` board data, rendered through the pages'
  // own view functions (and the real pay-sheet panels).
  const usInvoice = (over: Record<string, unknown>) =>
    ({
      invoiceId: '00000000-0000-4000-8000-0000000000a1',
      memberId: 'm1',
      invoiceSubject: 'membership',
      status: 'issued',
      documentNumber: null,
      billDocumentNumberRaw: 'SC-2026-000123',
      receiptDocumentNumberRaw: null,
      pdfDocKind: 'bill',
      pdf: { blobKey: 'k' },
      receiptPdf: null,
      receiptPdfStatus: null,
      memberIdentitySnapshot: { tax_id: '0105555000001' },
      issueDate: '2026-09-15',
      dueDate: '2026-10-15',
      paidAt: null,
      voidedAt: null,
      voidReason: null,
      planYear: 2026,
      subtotal: { satang: 3600000n },
      vat: { satang: 252000n },
      total: { satang: 3852000n },
      creditedTotal: { satang: 0n },
      lines: [
        {
          lineId: 'l1',
          descriptionEn: 'SweCham Premium Corporate Membership Fee 2026',
          descriptionTh: 'ค่าสมาชิก SweCham Premium Corporate ปี 2026',
          quantity: 1,
          unitPrice: { satang: 3600000n },
          total: { satang: 3600000n },
        },
      ],
      ...over,
    }) as unknown as Invoice;

  if (view === 'invoices') {
    const now = new Date().toISOString();
    const list = [
      usInvoice({}),
      usInvoice({ invoiceId: 'i2', status: 'paid', billDocumentNumberRaw: 'SC-2026-000045', receiptDocumentNumberRaw: 'RC-2026-000031', receiptPdfStatus: 'rendered', receiptPdf: { blobKey: 'r' }, issueDate: '2026-03-12', dueDate: '2026-04-11', paidAt: '2026-03-20', total: { satang: 214000n } }),
      usInvoice({ invoiceId: 'i3', status: 'paid', billDocumentNumberRaw: 'SC-2025-000087', receiptDocumentNumberRaw: 'RC-2025-000066', receiptPdfStatus: 'rendered', receiptPdf: { blobKey: 'r' }, issueDate: '2025-09-15', dueDate: '2025-10-15', paidAt: '2025-09-30' }),
      usInvoice({ invoiceId: 'i4', status: 'partially_credited', billDocumentNumberRaw: 'SC-2025-000052', receiptDocumentNumberRaw: 'RC-2025-000040', receiptPdfStatus: 'rendered', receiptPdf: { blobKey: 'r' }, issueDate: '2025-06-02', dueDate: '2025-07-02', total: { satang: 428000n } }),
      usInvoice({ invoiceId: 'i5', status: 'void', billDocumentNumberRaw: 'SC-2025-000019', issueDate: '2025-02-20', dueDate: '2025-03-22', total: { satang: 214000n } }),
    ];
    return (
      <MemberFrame path="/portal/invoices">
        {await renderPortalInvoicesView({
          rows: list.map((i) => ({ vm: toInvoiceRowViewModel(i, now, true) })),
          total: list.length,
          page: 1,
          hasActiveFilter: false,
          userLocale: 'en',
          f088TaxAtPayment: true,
          alert: (
            <MembershipInvoiceAlert
              invoiceId="00000000-0000-4000-8000-0000000000a1"
              documentNumber="SC-2026-000123"
              amount="38,520.00 THB"
              dueDate="15 Oct 2026"
              overdue={false}
              online="both"
            />
          ),
        })}
      </MemberFrame>
    );
  }

  if (view === 'invoice') {
    const state = typeof sp.state === 'string' ? sp.state : 'issued';
    const invoice =
      state === 'paid'
        ? usInvoice({ status: 'paid', receiptDocumentNumberRaw: 'RC-2026-000044', receiptPdfStatus: 'pending', paidAt: '2026-09-24' })
        : state === 'void'
          ? usInvoice({ status: 'void', voidedAt: '2026-09-20', voidReason: 'Issued with the wrong plan.' })
          : usInvoice({});
    return (
      <MemberFrame path="/portal/invoices">
        {await renderPortalInvoiceDetailView({
          invoice,
          userLocale: 'en',
          paymentSettings:
            state === 'issued'
              ? ({
                  onlinePaymentEnabled: true,
                  enabledMethods: ['card', 'promptpay'],
                  processorAccountId: 'preview-account',
                  // Not key-shaped on purpose (secret scanners); only drawn, never loaded.
                  processorPublishableKey: 'preview-not-a-key',
                } as never)
              : null,
          portalCreditNotes: [],
          autoRefund: state === 'void' ? { processorRefundId: 're_preview_ABCD1234', failed: false } : null,
          replacedBy: null,
          replaces: [],
          f5OnlinePayment: true,
          f088TaxAtPayment: true,
          tenantContactEmails: ['billing@swecham.example'],
        })}
      </MemberFrame>
    );
  }

  if (view === 'credit-note') {
    return (
      <BreadcrumbProvider>
      <MemberFrame path="/portal/invoices">
        {await renderPortalCreditNoteView({
          creditNoteId: 'cn-1',
          locale: 'en',
          cn: {
            creditNoteId: 'cn-1',
            originalInvoiceId: 'i2',
            documentNumber: { raw: 'CN-2026-000014' },
            issueDate: '2026-09-23',
            originalDocuments: {
              receiptNumberRaw: 'RC-2026-000038',
              related: { kind: 'bill', numberRaw: 'SC-2026-000102' },
            },
            creditAmount: { satang: 1000000n },
            vat: { satang: 70000n },
            total: { satang: 1070000n },
            reason: 'Charged the Premium rate; the member qualifies for Large Corporate for this cycle — difference credited.',
          } as never,
        })}
      </MemberFrame>
      </BreadcrumbProvider>
    );
  }

  if (view === 'pay') {
    const state = (typeof sp.state === 'string' ? sp.state : 'card') as PayPreviewState;
    return (
      <MemberFrame path="/portal/invoices">
        <PayPreview state={state} />
      </MemberFrame>
    );
  }

  if (view === 'not-found') {
    return <MemberFrame path="/portal/does-not-exist">{await PortalNotFound()}</MemberFrame>;
  }

  // home — the `Main` / `Home-mobile` board data
  const t = await getTranslations('portal.dashboard');
  const tActivity = await getTranslations('portal.dashboard.activity');
  const tInvoices = await getTranslations('portal.invoices');
  const tStatus = await getTranslations('admin.invoices.list.statuses');
  const fakeInvoice = (over: Record<string, unknown>) =>
    ({
      documentNumber: null,
      receiptDocumentNumberRaw: null,
      pdf: {},
      pdfDocKind: 'invoice',
      receiptPdf: null,
      receiptPdfStatus: null,
      ...over,
    }) as unknown as Invoice;
  const INVOICES = [
    fakeInvoice({ invoiceId: 'i1', status: 'issued', billDocumentNumberRaw: 'SC-2026-000123', issueDate: '2026-09-15', dueDate: '2026-10-15', total: { satang: 3852000n } }),
    fakeInvoice({ invoiceId: 'i2', status: 'paid', billDocumentNumberRaw: 'SC-2026-000045', receiptDocumentNumberRaw: 'RC-2026-000045', pdfDocKind: 'receipt_combined', receiptPdfStatus: 'rendered', issueDate: '2026-03-12', dueDate: '2026-04-11', total: { satang: 3852000n } }),
    fakeInvoice({ invoiceId: 'i3', status: 'paid', billDocumentNumberRaw: 'SC-2025-000087', receiptDocumentNumberRaw: 'RC-2025-000087', pdfDocKind: 'receipt_combined', receiptPdfStatus: 'rendered', issueDate: '2025-09-15', dueDate: '2025-10-15', total: { satang: 3531000n } }),
  ];
  return (
    <MemberFrame path="/portal">
      <DetailContainer>
        <PageHeader
          title="Hi Anna"
          subtitle={t('intro')}
          size="hero"
          meta={
            <>
              <Badge variant="outline" className="font-mono">TSCC-0042</Badge>
              <Badge tone="accent" variant="solid">Premium Corporate</Badge>
              <StatusPill tone="neutral">{t('statusChip.active')}</StatusPill>
            </>
          }
        />
        <MembershipInvoiceAlert
          invoiceId="00000000-0000-4000-8000-0000000000a1"
          documentNumber="SC-2026-000123"
          amount="38,520.00 THB"
          dueDate="15 Oct 2026"
          overdue={false}
          online="both"
        />
        <div className="grid grid-cols-1 gap-[var(--page-section-gap)] sm:grid-cols-3">
          <StatCard label={t('membership.label')} value={t('membership.activeValue')} sub={t('membership.daysRemainingSub', { days: 98 })} headIcon={CircleCheck} />
          <StatCard label={t('outstanding.label')} value="38,520.00 THB" sub="1 unpaid invoice · Earliest due 15 Oct 2026" headIcon={FileText} href="/portal/invoices" />
          <StatCard label={t('benefits.label')} value={t('benefits.underUseValue', { count: 1 })} sub={t('benefits.underUseSub')} headIcon={TrendingUp} href="/portal/benefits" />
        </div>
        <div className="grid grid-cols-1 gap-[var(--page-section-gap)] lg:grid-cols-2">
          <InvoicesSummaryView rows={INVOICES} nowUtcIso={new Date().toISOString()} t={tInvoices} tStatus={tStatus} userLocale="en" />
          <PortalBenefitsSummaryCard
            locale="en"
            membershipYear={2026}
            fullHref="/portal/benefits"
            quantifiable={[
              { key: 'eblast', used: 2, entitlement: 6, reserved: 1, lastUsedAt: '2026-07-03T08:00:00.000Z', actionHref: '/portal/broadcasts/new' },
              { key: 'cultural_tickets', used: 0, entitlement: 2, lastUsedAt: null },
            ]}
          />
        </div>
        <Card title={tActivity('title')} titleId="recent-heading" headingLevel={2}>
          <div className="flex flex-col">
            <RecentActivityList events={EVENTS.slice(0, 4)} />
            <div className="border-t border-[var(--aura-border-default)] pt-3">
              <Link href="/portal/timeline" className="text-[13px] font-medium text-[var(--aura-fg-accent)] no-underline">
                {tActivity('viewAll')}
              </Link>
            </div>
          </div>
        </Card>
      </DetailContainer>
    </MemberFrame>
  );
}
