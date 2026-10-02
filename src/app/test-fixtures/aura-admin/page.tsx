import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { PageHeader } from '@/components/layout/page-header';
import { StaffShell } from '@/components/layout/staff-shell';
import { AuraDensity } from '@/components/providers/aura-bridge';
import type { PlanOption } from '@/components/members/directory-filters';
import type { MembersTableRow } from '@/components/members/members-table';
import type { DirectoryTableRow } from '@/components/directory/directory-table';
import type { RecentExportRow } from '@/components/directory/recent-exports';
import { GenerateExportActions } from '@/components/directory/generate-export-actions';
import type { ChangeRequestReviewFieldView, StaffChangeRequestView } from '@/lib/change-request-staff-view';
import type { ChangeRequestQueueItem } from '@/modules/members';
import { flattenNavItems, staffNavConfig } from '@/config/nav';
import { renderMembersDirectoryBody, renderMembersListView } from '@/app/(staff)/admin/members/page';
import { renderDirectoryView } from '@/app/(staff)/admin/directory/page';
import { renderChangeRequestReviewView } from '@/app/(staff)/admin/change-requests/[id]/page';
import { renderChangeRequestQueueView } from '@/app/(staff)/admin/change-requests/page';
import type { Contact, Member } from '@/modules/members';
import type { TimelineItemProps } from '@/components/members/timeline-event-item';
import { RenewalHealthCard } from '@/components/members/renewal-health-card';
import { BenefitUsageCard } from '@/components/benefits/benefit-usage-card';
import { renderMemberDetailView } from '@/app/(staff)/admin/members/[memberId]/_components/member-detail-view';
import { MemberSummaryStrip } from '@/app/(staff)/admin/members/[memberId]/_components/member-summary-strip';
import { MemberInvoicesCard } from '@/app/(staff)/admin/members/[memberId]/_components/member-invoices-section';
import { TimelinePreviewCard } from '@/app/(staff)/admin/members/[memberId]/_components/timeline-preview-section';
import { MemberDataExportCard } from '@/app/(staff)/admin/members/[memberId]/_components/member-data-export-section';
import { PendingChangeRequestAlert } from '@/app/(staff)/admin/members/[memberId]/_components/member-change-requests-section';
import { renderMemberTimelineView } from '@/app/(staff)/admin/members/[memberId]/_components/member-timeline-view';
import { renderMemberBenefitsView } from '@/app/(staff)/admin/members/[memberId]/_components/member-benefits-view';
import { MemberFormFrame } from '@/app/(staff)/admin/members/_components/member-form-frame';
import { FormContainer, TableContainer } from '@/components/layout';
import { CreateMemberClient } from '@/components/members/create-member-client';
import { EditMemberClient } from '@/components/members/edit-member-client';
import { AdminPreferredLocaleCard } from '@/components/admin/admin-preferred-locale-card';
import type { PlanOption as FormPlanOption } from '@/components/members/member-form';
import { MemberFormDialogPreview } from './member-form-previews';
import { PlansTable } from '@/components/plans/plans-table';
import { renderPlansListView } from '@/app/(staff)/admin/plans/_components/plans-list-view';
import {
  renderCloneYearView,
  renderNewPlanView,
  renderPlanEditView,
} from '@/app/(staff)/admin/plans/_components/plan-form-views';
import { renderPlanDetailView } from '@/app/(staff)/admin/plans/[year]/[planId]/_components/plan-detail-view';
import { CLONE_SOURCE_PLANS, PLAN_ID, PLAN_ROWS, PLAN_YEAR, PREMIUM_PLAN, premiumPlanInput } from './plan-fixtures';
import {
  renderPipelineLens,
  renderPipelineLoadError,
  renderRenewalsPipelineView,
} from '@/app/(staff)/admin/renewals/_components/renewals-pipeline-view';
import { PipelineMoneyBand } from '@/app/(staff)/admin/renewals/_components/pipeline-money-band';
import { RenewalsSectionTabs } from '@/app/(staff)/admin/renewals/_components/renewals-section-tabs';
import { AtRiskWidget } from '@/app/(staff)/admin/renewals/_components/at-risk-widget';
import { RenewalsByMonthSection } from '@/app/(staff)/admin/renewals/_components/renewals-by-month-section';
import { MembersWithoutCycleTray } from '@/app/(staff)/admin/renewals/_components/members-without-cycle-tray';
import {
  MEMBERS_WITHOUT_CYCLE,
  RENEWALS_BY_MONTH,
  RENEWALS_BY_MONTH_EMPTY_WINDOW,
  RENEWALS_MONEY,
  RENEWALS_NEEDS_ACTION_COUNT,
  RENEWALS_NOW_ISO,
  RENEWALS_SECTION_COUNTS,
  RENEWALS_SUMMARY,
  RENEWALS_SUMMARY_EMPTY,
  RENEWAL_ROWS,
  CYCLE_FIXTURES,
  CYCLE_PREVIEW_ID,
  TIER_UPGRADE_ITEMS,
  TASK_ITEMS,
  TASK_TYPES,
  SCHEDULE_POLICIES,
  type CycleFixtureKind,
} from './renewal-fixtures';
import { AtRiskFixture, MarkPaidDialogPreview, TierUpgradeAcceptPreview } from './renewal-previews';
import { renderInvoicesListView, renderInvoicesSetupView } from '@/app/(staff)/admin/invoices/_components/invoices-list-view';
import { InvoiceCreateSwitcher } from '@/app/(staff)/admin/invoices/new/_components/invoice-create-switcher';
import { INVOICE_EVENTS, INVOICE_MEMBERS, INVOICE_PLANS, INVOICE_ROWS, INVOICES_TODAY_ISO } from './invoice-fixtures';
import { OpenFirstMatchingButton } from './invoice-previews';
import { renderInvoiceDetailView } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/invoice-detail-view';
import { PaymentTimelineSkeleton } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline-skeleton';
import { VoidConfirmDialog } from '@/app/(staff)/admin/invoices/[invoiceId]/void/_components/void-confirm-dialog';
import { CreditNoteForm } from '@/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/_components/credit-note-form';
import { DETAIL_INVOICE_ID, DETAIL_KINDS, detailFixture, type DetailFixtureKind } from './invoice-detail-fixtures';
import { CycleDetailBadges, renderCycleDetailView } from '@/app/(staff)/admin/renewals/[cycleId]/_components/cycle-detail-view';
import { CycleAdminActions } from '@/app/(staff)/admin/renewals/[cycleId]/_components/cycle-admin-actions';
import { PendingReactivationActions } from '@/app/(staff)/admin/renewals/[cycleId]/_components/pending-reactivation-actions';
import { renderTierUpgradesView } from '@/app/(staff)/admin/renewals/tier-upgrades/_components/tier-upgrades-view';
import { TierUpgradeQueueClient } from '@/app/(staff)/admin/renewals/tier-upgrades/_components/tier-upgrade-queue';
import { renderTasksQueueView } from '@/app/(staff)/admin/renewals/tasks/_components/tasks-queue-view';
import { EscalationTaskQueue } from '@/app/(staff)/admin/renewals/tasks/_components/escalation-task-queue';
import { renderSchedulesStateView } from '@/app/(staff)/admin/settings/renewals/schedules/_components/schedules-state-view';
import { ScheduleEditor } from '@/app/(staff)/admin/settings/renewals/schedules/_components/schedule-editor';
import Link from 'next/link';
import { ArrowLeftIcon } from 'lucide-react';
import { DetailContainer } from '@/components/layout';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';

// Request-time evaluation so the guard runs per request (see button-matrix).
export const dynamic = 'force-dynamic';

/**
 * Spec 122 US5a (T509) — the US5a staff screens inside the real staff shell
 * with no session and no DB, so they can be screenshot at 390 / 820 / 1440 in
 * light and dark and compared with the `Admin-members*`,
 * `Admin-state-members-*`, `Admin-directory*` and `Admin-change-request*`
 * boards:
 *
 *   ?view=members&state=default|manager|filtered|empty|all-invited|error
 *   ?view=directory
 *   ?view=change-requests&state=default|empty
 *   ?view=change-request&state=pending|manager|decided
 *   ?view=member&state=default|manager|archived|erased|no-primary   (US5b-1)
 *   ?view=member-timeline
 *   ?view=member-benefits
 *   ?view=member-new                                                   (US5b-2)
 *   ?view=renewal-tasks|renewal-tasks-manager|renewal-tasks-empty|renewal-tasks-error (US7b-2)
 *   ?view=renewal-schedules|renewal-schedules-error                    (US7b-2)
 *   ?view=member-edit&state=default|complete
 *   ?view=member-edit&dialog=plan-change|bundle|override|duplicate
 *   ?view=invoices|invoices-empty|invoices-filtered|invoices-setup|record-payment (US8a)
 *   ?view=invoice-new|invoice-new-event
 *   ?view=invoice&state=draft|issued|overdue|paid|credited|manager|email-failed|
 *         auto-refund-failed|refund-settling|refund-partial|voided         (US8b)
 *   ?view=invoice&state=draft&dialog=issue|delete · state=paid|refund-partial&dialog=refund
 *   ?view=invoice-void · ?view=credit-note-new&state=manual|online
 *   ?view=loading&state=members|plans|invoices|invoice|invoice-void|credit-note-new|…
 *
 * The payment activity streams from the database, so a paid state shows its
 * skeleton in that slot; its states are covered by its own unit tests.
 *
 * The bodies render through the pages' own view functions and client
 * components with fixture data. Nothing here can succeed: an action reaches
 * the API without a session and only gets an error.
 *
 * Reachable only with `ALLOW_TEST_ROUTES=1` (never set on Vercel), exactly
 * like `/test-fixtures/aura-shell`. Every value below is invented.
 */

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const PLANS: PlanOption[] = [
  { id: 'premium', label: 'Premium Corporate' },
  { id: 'large', label: 'Large Corporate' },
  { id: 'regular', label: 'Regular Corporate' },
  { id: 'start-up', label: 'Start-up' },
  { id: 'diamond', label: 'Diamond Partnership' },
];

function memberRow(
  n: number,
  company: string,
  contact: [string, string] | null,
  plan: string,
  extra: Partial<MembersTableRow> = {},
): MembersTableRow {
  return {
    member_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    member_number_display: `TSCC-${String(n).padStart(4, '0')}`,
    company_name: company,
    country: 'TH',
    plan_id: plan.toLowerCase().replace(/\s+/g, '-'),
    plan_year: 2026,
    plan_display_name: plan,
    status: 'active',
    membership_lapsed: false,
    membership_suspended: false,
    portal_state: contact ? 'active' : null,
    engagement: { score: 82, band: 'healthy' },
    last_activity_at: ago(2),
    primary_contact: contact
      ? {
          contact_id: `c-${n}`,
          first_name: contact[0],
          last_name: contact[1],
          email: `${contact[0].toLowerCase()}@example.com`,
        }
      : null,
    ...extra,
  };
}

// The `Admin-members` board rows.
const MEMBERS: MembersTableRow[] = [
  memberRow(3, 'Siam Nordic Trading Co., Ltd.', ['Erik', 'Johansson'], 'Premium Corporate'),
  memberRow(8, 'Baltic Bay Consulting Co., Ltd.', ['Pimchanok', 'Srisuk'], 'Large Corporate', {
    engagement: { score: 58, band: 'warning' },
    last_activity_at: ago(21),
    portal_state: 'invited',
  }),
  memberRow(12, 'Midsommar Hospitality Co., Ltd.', ['Anders', 'Nilsson'], 'Regular Corporate', {
    engagement: { score: 34, band: 'critical' },
    last_activity_at: ago(64),
    portal_state: 'not_invited',
  }),
  memberRow(15, 'Andaman Marine Tech Co., Ltd.', ['Karin', 'Lund'], 'Diamond Partnership', {
    last_activity_at: ago(0),
  }),
  memberRow(21, 'Gamla Stan Coffee Roasters', ['Nattapong', 'Wongsa'], 'Start-up', {
    membership_suspended: true,
    engagement: { score: 12, band: 'critical' },
    last_activity_at: ago(150),
  }),
  memberRow(27, 'Chao Phraya Design Studio', ['Sofia', 'Berg'], 'Regular Corporate', {
    last_activity_at: ago(6),
  }),
  memberRow(31, 'Öresund Medical Supplies Co., Ltd.', ['Lars', 'Ek'], 'Large Corporate', {
    country: 'SE',
    portal_state: 'invite_expired',
  }),
  memberRow(36, 'Kiruna Mining Services (Thailand)', ['Suda', 'Phromma'], 'Premium Corporate', {
    engagement: { score: 41, band: 'moderate' },
    last_activity_at: ago(48),
  }),
  memberRow(42, 'Uppsala Education Partners', null, 'Start-up', {
    status: 'inactive',
    membership_lapsed: true,
    engagement: null,
    last_activity_at: ago(9),
  }),
  memberRow(48, 'Visby Software Asia Co., Ltd.', ['Kanya', 'Thongdee'], 'Diamond Partnership', {
    status: 'archived',
    last_activity_at: ago(1),
  }),
];

const DIRECTORY: DirectoryTableRow[] = [
  { memberId: 'd1', companyName: 'Andaman Marine Tech Co., Ltd.', tier: 'Diamond Partnership', industry: 'Marine engineering', location: 'Phuket, TH', listed: true, hasLogo: true, contactName: 'Karin Lund' },
  { memberId: 'd2', companyName: 'Baltic Bay Consulting Co., Ltd.', tier: 'Large Corporate', industry: 'Management consulting', location: 'Bangkok, TH', listed: true, hasLogo: true, contactName: 'Pimchanok Srisuk' },
  { memberId: 'd3', companyName: 'Chao Phraya Design Studio', tier: 'Regular Corporate', industry: 'Interior design', location: 'Bangkok, TH', listed: true, hasLogo: false, contactName: 'Sofia Berg' },
  { memberId: 'd4', companyName: 'Kiruna Mining Services (Thailand)', tier: 'Premium Corporate', industry: 'Mining services', location: 'Rayong, TH', listed: false, hasLogo: true, contactName: 'Suda Phromma' },
  { memberId: 'd5', companyName: 'Midsommar Hospitality Co., Ltd.', tier: 'Regular Corporate', industry: 'Hotels', location: 'Chiang Mai, TH', listed: true, hasLogo: true, contactName: 'Anders Nilsson' },
  { memberId: 'd6', companyName: 'Siam Nordic Trading Co., Ltd.', tier: 'Premium Corporate', industry: 'Furniture import', location: 'Bangkok, TH', listed: true, hasLogo: true, contactName: 'Erik Johansson' },
  { memberId: 'd7', companyName: 'Visby Software Asia Co., Ltd.', tier: 'Gold Partnership', industry: 'Software', location: 'Bangkok, TH', listed: true, hasLogo: true, contactName: null },
];

function queueItem(
  n: number,
  company: string,
  submitter: string,
  fieldCount: number,
  tax: boolean,
  days: number,
): ChangeRequestQueueItem {
  const submittedAt = new Date(Date.now() - days * DAY);
  return {
    row: {
      request: {
        id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
        state: 'pending',
        outcome: null,
        withdrawnReason: null,
        submitterRoleAtSubmission: 'primary',
        submittedAt,
        decidedAt: null,
        fields: Array.from({ length: fieldCount }, (_, i) => ({ affectsTaxDocuments: tax && i === 0 })),
      },
      member: { companyName: company, memberNumber: n, status: 'active', archived: false },
      submitter: { displayName: submitter },
      decidedBy: null,
    },
    waitingSeconds: days * 86_400 + 3 * 3600,
    overdue: days > 5,
  } as unknown as ChangeRequestQueueItem;
}

// The `Admin-change-requests` board rows.
const QUEUE: ChangeRequestQueueItem[] = [
  queueItem(12, 'Midsommar Hospitality Co., Ltd.', 'Anders Nilsson', 3, true, 6),
  queueItem(8, 'Baltic Bay Consulting Co., Ltd.', 'Pimchanok Srisuk', 1, false, 2),
  queueItem(36, 'Kiruna Mining Services (Thailand)', 'Suda Phromma', 2, false, 0),
];

// The `Admin-change-request` board.
const REVIEW_REQUEST = {
  id: '00000000-0000-4000-9000-000000000012',
  memberId: '00000000-0000-4000-8000-000000000012',
  scope: 'member_record',
  state: 'pending',
  outcome: null,
  withdrawnReason: null,
  replacedByRequestId: null,
  submittedAt: ago(6),
  staffNotifiedAt: null,
  submittedBy: { contactId: 'c-12', displayName: 'Anders Nilsson', roleAtSubmission: 'primary' },
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  decisionNote: null,
  member: { companyName: 'Midsommar Hospitality Co., Ltd.', memberNumber: 12, status: 'active', archived: false },
  fields: [],
} as unknown as StaffChangeRequestView;

const REVIEW_FIELDS = [
  {
    key: 'company_name',
    target: 'member',
    seen: 'Midsommar Hospitality Co., Ltd.',
    current: 'Midsommar Hospitality Co., Ltd.',
    proposed: 'Midsommar Hotels & Hospitality Co., Ltd.',
    affectsTaxDocuments: true,
    taxHint: 'buyer_name',
    outcome: null,
    appliedAt: null,
    changedSinceSubmitted: false,
    alreadyCurrent: false,
    undecidable: null,
  },
  {
    key: 'billing_address',
    target: 'member',
    seen: { line1: '12 Sukhumvit Soi 11', line2: null, sub_district: null, city: null, province: 'Bangkok', postal_code: '10110', country: 'TH' },
    current: { line1: '12 Sukhumvit Soi 11', line2: null, sub_district: 'Khlong Toei Nuea', city: 'Watthana', province: 'Bangkok', postal_code: '10110', country: 'TH' },
    proposed: { line1: '88 Rama IV Road', line2: 'Floor 14', sub_district: 'Khlong Toei', city: 'Khlong Toei', province: 'Bangkok', postal_code: '10110', country: 'TH' },
    affectsTaxDocuments: true,
    taxHint: 'buyer_address',
    outcome: null,
    appliedAt: null,
    changedSinceSubmitted: true,
    alreadyCurrent: false,
    undecidable: null,
  },
  {
    key: 'phone',
    target: 'contact',
    seen: '+66 2 123 4567',
    current: '+66 2 123 4567',
    proposed: '+66 2 654 3210',
    affectsTaxDocuments: false,
    taxHint: null,
    outcome: null,
    appliedAt: null,
    changedSinceSubmitted: false,
    alreadyCurrent: false,
    undecidable: null,
  },
] as unknown as ChangeRequestReviewFieldView[];

const LOADING_ROUTES = {
  members: { path: '/admin/members', load: async () => (await import('@/app/(staff)/admin/members/loading')).default() },
  plans: { path: '/admin/plans', load: async () => (await import('@/app/(staff)/admin/plans/loading')).default() },
  invoices: { path: '/admin/invoices', load: async () => (await import('@/app/(staff)/admin/invoices/loading')).default() },
  'change-requests': {
    path: '/admin/change-requests',
    load: async () => (await import('@/app/(staff)/admin/change-requests/loading')).default(),
  },
  renewals: { path: '/admin/renewals', load: async () => (await import('@/app/(staff)/admin/renewals/loading')).default() },
  'tier-upgrades': {
    path: '/admin/renewals/tier-upgrades',
    load: async () => (await import('@/app/(staff)/admin/renewals/tier-upgrades/loading')).default(),
  },
  tasks: { path: '/admin/renewals/tasks', load: async () => (await import('@/app/(staff)/admin/renewals/tasks/loading')).default() },
  invoice: {
    path: `/admin/invoices/${DETAIL_INVOICE_ID}`,
    load: async () => (await import('@/app/(staff)/admin/invoices/[invoiceId]/loading')).default(),
  },
  'invoice-void': {
    path: `/admin/invoices/${DETAIL_INVOICE_ID}/void`,
    load: async () => (await import('@/app/(staff)/admin/invoices/[invoiceId]/void/loading')).default(),
  },
  'credit-note-new': {
    path: `/admin/invoices/${DETAIL_INVOICE_ID}/credit-notes/new`,
    load: async () => (await import('@/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/loading')).default(),
  },
} as const;

function StaffFrame({ path, children }: { readonly path: string; readonly children: React.ReactNode }) {
  // The staff frame as the admin layout composes it (see /test-fixtures/aura-shell).
  return (
    <AuraDensity density="compact">
      <StaffShell
        nav={{
          tenantName: 'SweCham',
          allowedHrefs: flattenNavItems(staffNavConfig).map((item) => item.href),
          navVisibilityFlags: { broadcastsEnabled: true, eventsEnabled: true, memberChangeApproval: true },
          navBadgeCounts: { '/admin/change-requests': 3 },
          currentPath: path,
          defaultCollapsed: false,
        }}
        user={{ displayName: 'Malin Berg', email: 'malin.berg@example.com', role: 'admin' }}
      >
        {children}
      </StaffShell>
    </AuraDensity>
  );
}


// ── US5b-1: the member detail (`Admin-member-detail*` boards) ────────────────
const MEMBER_ID = '00000000-0000-4000-8000-000000000003';
const MEMBER = {
  memberId: MEMBER_ID,
  companyName: 'Siam Nordic Trading Co., Ltd.',
  status: 'active',
  planId: 'premium-corporate',
  planYear: 2026,
  memberNumber: 3,
  country: 'TH',
  legalEntityType: 'Company Limited',
  taxId: '0105561234567',
  website: 'https://siamnordic.example',
  foundedYear: 2008,
  turnoverThb: 184_000_000,
  registeredCapitalThb: 20_000_000,
  registrationDate: new Date('2021-03-01T00:00:00Z'),
  registrationFeePaid: true,
  lastActivityAt: new Date(Date.now() - 2 * DAY),
  archivedAt: null,
  autoInvoiceEnrolledAt: new Date('2026-01-10T00:00:00Z'),
  addressLine1: '99/1 Sukhumvit Road',
  addressLine2: 'Floor 12, Nordic Tower',
  subDistrict: 'Khlong Toei Nuea',
  city: 'Watthana',
  province: 'Bangkok',
  postalCode: '10110',
  billingAddressLine1: null,
  description: null,
  notes: null,
} as unknown as Member;
const MEMBER_CONTACTS = [
  {
    contactId: 'c-erik',
    firstName: 'Erik',
    lastName: 'Johansson',
    email: 'erik.johansson@siamnordic.example',
    phone: '+66 81 234 5678',
    roleTitle: 'Managing Director',
    preferredLanguage: 'en',
    isPrimary: true,
    linkedUserId: 'u-erik',
    inviteBouncedAt: null,
    removedAt: null,
  },
  {
    contactId: 'c-ploy',
    firstName: 'Ploy',
    lastName: 'Srisuk',
    email: 'ploy.srisuk@siamnordic.example',
    phone: '+66 89 765 4321',
    roleTitle: 'Office Manager',
    preferredLanguage: 'th',
    isPrimary: false,
    linkedUserId: 'u-ploy',
    inviteBouncedAt: null,
    removedAt: null,
  },
] as unknown as Contact[];
const MEMBER_EVENTS: TimelineItemProps[] = [
  { id: 't1', timestamp: ago(2), source: 'payment', eventType: 'succeeded', actorKind: 'member', actorDisplayName: null, payload: { document_number: 'SC-2026-000045', payment_method: 'card' } },
  { id: 't2', timestamp: ago(9), source: 'invoice', eventType: 'issued', actorKind: 'staff', actorDisplayName: 'Malin Berg', payload: { document_number: 'SC-2026-000123' } },
  { id: 't3', timestamp: ago(12), source: 'renewal', eventType: 'reminded', actorKind: 'system', actorDisplayName: null, payload: null },
];

export default async function AuraAdminPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; state?: string; dialog?: string }>;
}) {
  if (!process.env.ALLOW_TEST_ROUTES) notFound();
  const { view = 'members', state = 'default' } = await searchParams;

  // The list routes' own loading.tsx, in the staff frame, so the skeleton can
  // be compared with the loaded page (`view=loading&state=<route>`).
  if (view === 'loading') {
    const route = LOADING_ROUTES[state as keyof typeof LOADING_ROUTES] ?? LOADING_ROUTES.members;
    return <StaffFrame path={route.path}>{await route.load()}</StaffFrame>;
  }

  if (view === 'member') {
    const manager = state === 'manager';
    const archived = state === 'archived';
    const erased = state === 'erased';
    const member = (archived
      ? { ...MEMBER, status: 'archived', archivedAt: new Date(Date.now() - 12 * DAY) }
      : MEMBER) as Member;
    const contacts = state === 'no-primary' ? MEMBER_CONTACTS.filter((c) => !c.isPrimary) : MEMBER_CONTACTS;
    const invoiceRows = [
      { invoiceId: 'i1', number: 'SC-2026-000123', status: 'issued' as const, statusLabel: 'Issued', issued: '15 Sep 2026', due: '15 Oct 2026', paid: null, total: '38,520.00 THB', remaining: '38,520.00 THB', owing: true },
      { invoiceId: 'i2', number: 'SC-2026-000045', status: 'paid' as const, statusLabel: 'Paid', issued: '12 Mar 2026', due: '11 Apr 2026', paid: '20 Mar 2026', total: '2,140.00 THB', remaining: '0.00 THB', owing: false },
      { invoiceId: 'i3', number: 'SC-2025-000087', status: 'paid' as const, statusLabel: 'Paid', issued: '15 Sep 2025', due: '15 Oct 2025', paid: '30 Sep 2025', total: '38,520.00 THB', remaining: '0.00 THB', owing: false },
    ];
    return (
      <StaffFrame path={`/admin/members/${MEMBER_ID}`}>
        {await renderMemberDetailView({
          member,
          contacts,
          planDisplayName: 'Premium Corporate',
          memberNumberDisplay: 'TSCC-0003',
          legalEntityLabel: 'Company Limited',
          websiteHref: 'https://siamnordic.example',
          windowStatus: archived ? { state: 'within_window', daysRemaining: 78 } : null,
          erasure: erased ? { erasedAt: new Date(Date.now() - 3 * DAY), completed: true } : { erasedAt: null, completed: false },
          moneyEmailUndeliverable: state === 'no-primary',
          pendingInvitations: new Map([['c-ploy', { expiresAt: new Date(Date.now() + 3 * DAY), daysUntilExpiry: 3, expired: false }]]),
          marketingStates: new Map([['c-erik', 'on'], ['c-ploy', 'on']]),
          verificationPending: new Set(),
          can: { write: !manager, marketing: !manager },
          features: { f9Dashboard: true, f7Broadcasts: true },
          locale: await getLocale(),
          slots: {
            pendingChangeRequest: state === 'default' ? await PendingChangeRequestAlert({ requestId: 'cr-1', submitterName: 'Erik Johansson', submitterRole: (await getTranslations('admin.changeRequests.review'))('roles.primary') }) : null,
            strip: (
              <MemberSummaryStrip
                outstanding={{ state: 'ok', sumSatang: 3852000n, count: 1, earliestDueIso: '2026-10-15', partial: false }}
                expiry={{ state: 'ok', expiryIso: '2026-12-31', daysRemaining: 98 }}
                primaryContact={state === 'no-primary' ? null : { name: 'Erik Johansson', portal: 'linked' }}
                engagement={{ band: 'healthy', lastActivityIso: ago(2) }}
                now={new Date()}
              />
            ),
            renewal: (
              <RenewalHealthCard
                headingId="member-renewal-health-heading"
                status="awaiting_payment"
                expiryIso="2026-12-31T16:59:59Z"
                daysRemaining={98}
                engagementScore={82}
                engagementBand="healthy"
                viewHref="/admin/renewals"
                canRenew={!manager}
                memberId={MEMBER_ID}
              />
            ),
            benefits: (
              <BenefitUsageCard
                variant="staff"
                headingId="member-benefits-preview-heading"
                locale="en"
                membershipYear={2026}
                elapsedYearPct={73}
                quantifiable={[
                  { key: 'eblast', used: 4, entitlement: 6, lastUsedAt: ago(40) },
                  { key: 'cultural_tickets', used: 1, entitlement: 2, lastUsedAt: ago(90) },
                ]}
                active={[{ key: 'directory_listing' }]}
                aggregateConsumedPct={62}
                underUseWarning={false}
                staffSubjectName="Siam Nordic Trading Co., Ltd."
                compact
                previewHref={`/admin/members/${MEMBER_ID}/benefits`}
                className="h-full flex flex-col"
              />
            ),
            invoices: (
              <MemberInvoicesCard memberId={MEMBER_ID} total={3} rows={invoiceRows} canMutate={!manager} hasFilter={false} showFilters />
            ),
            timeline: <TimelinePreviewCard memberId={MEMBER_ID} events={MEMBER_EVENTS} loadFailed={false} />,
            changeRequests: null,
            dataExport: manager || erased ? null : <MemberDataExportCard memberId={MEMBER_ID} contacts={contacts} jobs={[]} />,
          },
        })}
      </StaffFrame>
    );
  }

  if (view === 'member-new' || view === 'member-edit') {
    const FORM_PLANS: FormPlanOption[] = [
      { plan_id: 'regular', plan_year: 2026, display_name: 'Regular Corporate — 2026', annual_fee_minor_units: 1_600_000, currency_code: 'THB', plan_category: 'corporate' },
      { plan_id: 'large', plan_year: 2026, display_name: 'Large Corporate — 2026', annual_fee_minor_units: 2_600_000, currency_code: 'THB', plan_category: 'corporate' },
      { plan_id: 'premium', plan_year: 2026, display_name: 'Premium Corporate — 2026', annual_fee_minor_units: 3_600_000, currency_code: 'THB', plan_category: 'corporate' },
      { plan_id: 'alumni', plan_year: 2026, display_name: 'Thai Alumni — 2026', annual_fee_minor_units: 200_000, currency_code: 'THB', plan_category: 'corporate', requires_date_of_birth: true },
    ];
    if (view === 'member-new') {
      const t = await getTranslations('admin.members.create');
      return (
        <StaffFrame path="/admin/members/new">
          <FormContainer align="start">
            <MemberFormFrame title={t('title')} subtitle={t('subtitle')} cancelHref="/admin/members" cancelLabel={t('cancel')}>
              <CreateMemberClient plans={FORM_PLANS} defaultPlanYear={2026} />
            </MemberFormFrame>
          </FormContainer>
        </StaffFrame>
      );
    }
    const t = await getTranslations('admin.members.edit');
    const complete = state === 'complete';
    const { dialog } = await searchParams;
    return (
      <StaffFrame path={`/admin/members/${MEMBER_ID}/edit`}>
        <FormContainer align="start">
          <MemberFormFrame
            title={t('title')}
            subtitle="Siam Nordic Trading Co., Ltd."
            cancelHref={`/admin/members/${MEMBER_ID}`}
            cancelLabel={t('cancel')}
          >
            <AdminPreferredLocaleCard memberId={MEMBER_ID} initialValue={null} />
            <EditMemberClient
              plans={FORM_PLANS}
              member={{
                memberId: MEMBER_ID,
                companyName: 'Siam Nordic Trading Co., Ltd.',
                legalEntityType: 'limited_company',
                country: 'TH',
                taxId: '0105561234560',
                website: 'https://siamnordic.example',
                description: 'Nordic furniture and design import, Bangkok showroom.',
                notes: null,
                addressLine1: '98 Sathorn Road',
                addressLine2: null,
                city: 'Bang Rak',
                province: 'Bangkok',
                postalCode: '10500',
                subDistrict: complete ? 'Silom' : null,
                billingAddressLine1: null,
                billingAddressLine2: null,
                billingSubDistrict: null,
                billingCity: null,
                billingProvince: null,
                billingPostalCode: null,
                billingCountry: null,
                foundedYear: 2009,
                turnoverThb: 180_000_000,
                registeredCapitalThb: 20_000_000,
                isHeadOffice: true,
                branchCode: null,
                isVatRegistered: true,
                billingCycle: 'calendar',
                planId: 'premium',
                planYear: 2026,
                registrationDate: '2019-01-12',
              }}
              primaryContact={{
                contactId: 'c-erik',
                firstName: 'Erik',
                lastName: 'Johansson',
                email: 'erik@siamnordic.example',
                phone: '+66812345678',
                roleTitle: 'Managing Director',
                preferredLanguage: 'en',
                dateOfBirth: null,
              }}
            />
            {dialog ? <MemberFormDialogPreview dialog={dialog} /> : null}
          </MemberFormFrame>
        </FormContainer>
      </StaffFrame>
    );
  }

  // ── US6: the plans pages (`Admin-plans*`, `Admin-plan-*` boards) ─────────
  if (view === 'plans' || view === 'plans-empty') {
    const manager = state === 'manager';
    return (
      <StaffFrame path="/admin/plans">
        <TableContainer>
          {await renderPlansListView({
            canWrite: !manager,
            children: (
              <PlansTable
                plans={view === 'plans-empty' ? [] : PLAN_ROWS}
                currencyCode="THB"
                year={PLAN_YEAR}
                currentUserRole={manager ? 'manager' : 'admin'}
                initialFilter={{ category: null, q: null, activeOnly: false, showDeleted: false }}
              />
            ),
          })}
        </TableContainer>
      </StaffFrame>
    );
  }

  if (view === 'plan') {
    return (
      <StaffFrame path={`/admin/plans/${PLAN_YEAR}/${PLAN_ID}`}>
        {await renderPlanDetailView({
          plan: PREMIUM_PLAN,
          year: String(PLAN_YEAR),
          planId: PLAN_ID,
          canWritePlans: state !== 'manager',
          canReadMembers: true,
          currencyCode: 'THB',
          vat: { totalMinorUnits: 3_852_000, ratePercent: 7 },
          memberCount: 28,
          bundledPlanName: null,
        })}
      </StaffFrame>
    );
  }

  if (view === 'plan-new') {
    return (
      <StaffFrame path="/admin/plans/new">
        <FormContainer align="start">
          {await renderNewPlanView({ currentYear: PLAN_YEAR, currencyCode: 'THB', vatRatePercent: 7 })}
        </FormContainer>
      </StaffFrame>
    );
  }

  if (view === 'plan-edit' || view === 'plan-edit-locked') {
    const year = view === 'plan-edit-locked' ? PLAN_YEAR - 1 : PLAN_YEAR;
    return (
      <StaffFrame path={`/admin/plans/${year}/${PLAN_ID}/edit`}>
        <FormContainer align="start">
          {await renderPlanEditView({
            initialValues: premiumPlanInput(year),
            currentYear: PLAN_YEAR,
            currencyCode: 'THB',
            currentYearStatus: 'has_plan',
            vatRatePercent: 7,
          })}
        </FormContainer>
      </StaffFrame>
    );
  }

  if (view === 'plans-clone') {
    return (
      <StaffFrame path="/admin/plans/clone">
        <FormContainer align="start">
          {await renderCloneYearView({
            sourceYear: PLAN_YEAR,
            targetYear: PLAN_YEAR + 1,
            currencyCode: 'THB',
            sourcePlans: CLONE_SOURCE_PLANS,
          })}
        </FormContainer>
      </StaffFrame>
    );
  }

  if (view === 'member-timeline') {
    return (
      <StaffFrame path={`/admin/members/${MEMBER_ID}/timeline`}>
        {await renderMemberTimelineView({
          member: { memberId: MEMBER_ID, companyName: 'Siam Nordic Trading Co., Ltd.' },
          initialEvents: MEMBER_EVENTS,
          initialCursor: null,
          totalEvents: 64,
          hasFilter: false,
          filterKey: 'preview',
        })}
      </StaffFrame>
    );
  }

  if (view === 'member-benefits') {
    return (
      <StaffFrame path={`/admin/members/${MEMBER_ID}/benefits`}>
        {await renderMemberBenefitsView({
          member: { memberId: MEMBER_ID, companyName: 'Siam Nordic Trading Co., Ltd.' },
          usage: {
            membershipYear: 2026,
            elapsedYearPct: 73,
            quantifiable: [
              { key: 'eblast', used: 1, entitlement: 6, lastUsedAt: ago(80) },
              { key: 'cultural_tickets', used: 0, entitlement: 2, lastUsedAt: null },
            ],
            active: [{ key: 'all_employee_event_discount' }, { key: 'directory_listing' }, { key: 'm2m_benefits' }],
            aggregateConsumedPct: 8,
            underUseWarning: true,
          },
          suspended: false,
          reminderHref: 'mailto:erik.johansson@siamnordic.example?subject=preview',
          locale: 'en',
        })}
      </StaffFrame>
    );
  }

  if (view === 'directory') {
    const t = await getTranslations('admin.directory');
    const exportRows: RecentExportRow[] = [
      { jobId: 'j1', kindLabel: 'Directory E-Book (PDF)', status: 'processing', statusLabel: 'Generating…', downloadable: false, requestedAt: '24 Sep 2026, 10:12' },
      { jobId: 'j2', kindLabel: 'Directory JSON', status: 'ready', statusLabel: 'Ready', downloadable: true, requestedAt: '20 Sep 2026, 16:40' },
      { jobId: 'j3', kindLabel: 'Directory E-Book (PDF)', status: 'expired', statusLabel: 'Expired', downloadable: false, requestedAt: '2 Sep 2026, 09:05' },
    ];
    return (
      <StaffFrame path="/admin/directory">
        {await renderDirectoryView({
          header: <PageHeader title={t('title')} subtitle={t('subtitle')} actions={<GenerateExportActions />} />,
          rows: DIRECTORY,
          exportRows,
          page: 1,
          pageSize: 50,
          total: 131,
        })}
      </StaffFrame>
    );
  }

  if (view === 'change-requests') {
    const empty = state === 'empty';
    return (
      <StaffFrame path="/admin/change-requests">
        {await renderChangeRequestQueueView({
          items: empty ? [] : QUEUE,
          hasMore: false,
          nextHref: null,
          pendingSummary: empty ? null : { count: 3, oldestDays: 6 },
          deepLinkNotice: null,
          filtered: false,
          memberCompany: null,
          timeZone: 'Asia/Bangkok',
        })}
      </StaffFrame>
    );
  }

  if (view === 'change-request') {
    const decided = state === 'decided';
    const request = decided
      ? ({
          ...REVIEW_REQUEST,
          state: 'decided',
          outcome: 'partially_approved',
          decidedAt: ago(1),
          decidedBy: { displayName: 'Malin Berg', deactivated: false },
          decisionReason: 'The billing address must match your VAT registration (ภ.พ.20).',
        } as unknown as StaffChangeRequestView)
      : REVIEW_REQUEST;
    const fields = decided
      ? REVIEW_FIELDS.map((f) => ({ ...f, outcome: f.key === 'billing_address' ? 'rejected' : 'approved' }) as ChangeRequestReviewFieldView)
      : REVIEW_FIELDS;
    const canWrite = state !== 'manager';
    // The real route's path: the shell's breadcrumb and phone back link
    // ("← Change requests") come from it.
    return (
      <StaffFrame path={`/admin/change-requests/${request.id}`}>
        {await renderChangeRequestReviewView({
          request,
          fields,
          member: { companyName: 'Midsommar Hospitality Co., Ltd.', erasing: false, archived: false },
          canWrite,
          canDecide: canWrite && !decided,
        })}
      </StaffFrame>
    );
  }

  // ── US7a: the renewals pipeline (`Admin-renewals*`, `Admin-state-renewals-*`,
  // `Admin-renewal-mark-paid`) — the page's own view with sample data; the
  // money band, section counts, chart and tray get settled fixture reads.
  if (
    view === 'renewals' ||
    view === 'renewals-needs-action' ||
    view === 'renewals-empty' ||
    view === 'renewals-error' ||
    view === 'renewals-mark-paid'
  ) {
    const tr = await getTranslations('admin.renewals');
    const canMutate = state !== 'manager';
    const empty = view === 'renewals-empty';
    const summary = empty ? RENEWALS_SUMMARY_EMPTY : RENEWALS_SUMMARY;
    const body =
      view === 'renewals-error'
        ? await renderPipelineLoadError('7c9e6679-7425-40de-944b-e07fc1f90ae7')
        : renderRenewalsPipelineView({
            moneyBand: <PipelineMoneyBand money={RENEWALS_MONEY} windowDays={90} />,
            sectionTabs: <RenewalsSectionTabs {...RENEWALS_SECTION_COUNTS} />,
            pipeline: await renderPipelineLens({
              rows: empty ? [] : RENEWAL_ROWS,
              summary,
              urgency: 't-30',
              tier: undefined,
              monthLensActive: false,
              monthKind: undefined,
              monthLabel: undefined,
              sort: 'expires_at_asc',
              sortHrefs: {
                expires: '/admin/renewals?urgency=t-30&sort=expires_at_desc',
                tier: '/admin/renewals?urgency=t-30&sort=tier_asc',
              },
              nextHref: empty ? null : '/admin/renewals?urgency=t-30&cursor=preview',
              showEmptyState: empty,
              canMutate,
              canManageSchedules: canMutate,
            }),
            needsAction: (
              <>
                <AtRiskFixture />
                <AtRiskWidget canSnooze={canMutate} />
              </>
            ),
            needsActionCount: RENEWALS_NEEDS_ACTION_COUNT,
            ...(view === 'renewals-needs-action' ? { defaultLens: 'needsAction' as const } : {}),
            byMonth: (
              <RenewalsByMonthSection
                tenantSlug="preview"
                nowIso={RENEWALS_NOW_ISO}
                selectedMonth={null}
                summaryPromise={Promise.resolve({ ok: true, v: { ok: true, value: empty ? RENEWALS_BY_MONTH_EMPTY_WINDOW : RENEWALS_BY_MONTH } } as const)}
              />
            ),
            tray: (
              <MembersWithoutCycleTray
                tenantSlug="preview"
                resultPromise={Promise.resolve({ ok: true, v: { ok: true, value: MEMBERS_WITHOUT_CYCLE } } as const)}
              />
            ),
          });
    return (
      <StaffFrame path="/admin/renewals">
        <TableContainer>
          <PageHeader title={tr('title')} subtitle={tr('subtitle')} />
          {body}
          {view === 'renewals-mark-paid' ? <MarkPaidDialogPreview /> : null}
        </TableContainer>
      </StaffFrame>
    );
  }

  // ── US7b-1: cycle detail (`Admin-renewal-cycle`, `-reminded`, `-pending`,
  // `-mobile`) — the page's own title, actions and view with sample data.
  if (view === 'renewal-cycle' || view === 'renewal-cycle-reminded' || view === 'renewal-cycle-pending') {
    const kind: CycleFixtureKind =
      view === 'renewal-cycle-reminded' ? 'reminded' : view === 'renewal-cycle-pending' ? 'pending' : 'bill-issued';
    const fx = CYCLE_FIXTURES[kind];
    const t = await getTranslations('admin.renewals.cycleDetail');
    const tTasks = await getTranslations('admin.renewals.tasks');
    const tChannel = await getTranslations('admin.renewals.settings.schedules.stepCard');
    const tInvoice = await getTranslations('admin.invoices.list.statuses');
    const canWrite = state !== 'manager';
    const liveLinkedBill =
      fx.invoice && fx.status === 'awaiting_payment'
        ? { invoiceId: '00000000-0000-4000-8000-00000000f130', billNumber: fx.invoice.number }
        : null;
    const subtitle =
      fx.status === 'pending_admin_reactivation'
        ? t('subtitlePendingSince', { date: fx.subtitleDate })
        : t('subtitleExpiry', { date: fx.subtitleDate });
    const body = await renderCycleDetailView({
      status: fx.status,
      refundSettling: false,
      lookupFailedMessage: null,
      memberPlan: {
        company: fx.company,
        memberHref: '/admin/members/00000000-0000-4000-8000-000000000003',
        primaryContact: fx.primaryContact,
        tier: fx.tier,
        planName: fx.planName,
        frozenPrice: fx.frozenPrice,
        term: '12',
        currency: 'THB',
        technicalIds: { cycleId: CYCLE_PREVIEW_ID, memberId: '00000000-0000-4000-8000-000000000003', planId: 'gold-partnership' },
      },
      invoice: fx.invoice
        ? {
            number: fx.invoice.number,
            status: fx.invoice.status,
            statusLabel: tInvoice(fx.invoice.status),
            total: fx.invoice.total,
            href: '/admin/invoices/00000000-0000-4000-8000-00000000f130',
          }
        : null,
      invoicePendingMessage: t('noInvoiceYetUpcoming'),
      period: [
        { label: t('fields.periodFrom'), value: fx.period.from },
        { label: t('fields.periodTo'), value: fx.period.to },
        { label: t('fields.expiresAt'), value: fx.period.expires },
        ...(fx.period.enteredPending ? [{ label: t('fields.enteredPendingAt'), value: fx.period.enteredPending }] : []),
      ],
      auditTimestamps: { createdAt: '24 September 2025 at 09:00', updatedAt: '2 September 2026 at 09:05' },
      reminders: fx.reminders.map((r, i) => ({
        id: `r-${i}`,
        stepId: r.stepId,
        status: r.status,
        statusLabel: t(`reminders.status.${r.status}`),
        date: r.date,
        channel: tChannel(`channel.${r.channel}`),
      })),
      escalations: fx.escalations.map((e, i) => ({
        id: `e-${i}`,
        typeLabel: tTasks(`taskType.${e.taskType}`),
        status: e.status,
        statusLabel: tTasks(`status.${e.status}`),
        date: e.date,
        role: tTasks(`assigneeRole.${e.role}`),
      })),
      dangerZone: !canWrite ? null : fx.status === 'pending_admin_reactivation' ? (
        <PendingReactivationActions
          cycleId={CYCLE_PREVIEW_ID}
          status={fx.status}
          rejectRefundInitiatedAt={null}
          placement="dangerZone"
        />
      ) : (
        <CycleAdminActions cycleId={CYCLE_PREVIEW_ID} status={fx.status} liveLinkedBill={liveLinkedBill} placement="dangerZone" />
      ),
    });
    return (
      <StaffFrame path={`/admin/renewals/${CYCLE_PREVIEW_ID}`}>
        <DetailContainer>
          <PlanBreadcrumbLabel segment={CYCLE_PREVIEW_ID} label={fx.company} />
          <PageHeader
            title={`${t('title')} · ${fx.company}`}
            badge={
              <CycleDetailBadges
                status={fx.status}
                statusLabel={t(`cycleStatus.${fx.status}`)}
                statusSrSuffix={t.has(`statusSeverity.${fx.status}`) ? t(`statusSeverity.${fx.status}`) : null}
                refundSettlingLabel={null}
              />
            }
            subtitle={subtitle}
            actions={
              canWrite ? (
                <>
                  {fx.status === 'pending_admin_reactivation' && (
                    <PendingReactivationActions cycleId={CYCLE_PREVIEW_ID} status={fx.status} rejectRefundInitiatedAt={null} />
                  )}
                  <CycleAdminActions cycleId={CYCLE_PREVIEW_ID} status={fx.status} liveLinkedBill={liveLinkedBill} />
                </>
              ) : null
            }
          />
          {body}
        </DetailContainer>
      </StaffFrame>
    );
  }

  // ── US7b-1: the tier upgrade queue (`Admin-tier-upgrades`, `-accept`,
  // `-mobile`), with the empty and failed-read states.
  if (
    view === 'tier-upgrades' ||
    view === 'tier-upgrade-accept' ||
    view === 'tier-upgrades-empty' ||
    view === 'tier-upgrades-error'
  ) {
    const t = await getTranslations('admin.renewals.tier_upgrades');
    const items = view === 'tier-upgrades-empty' ? [] : TIER_UPGRADE_ITEMS;
    const body = await renderTierUpgradesView({
      sectionTabs: <RenewalsSectionTabs {...RENEWALS_SECTION_COUNTS} pathname="/admin/renewals/tier-upgrades" />,
      loadFailed: view === 'tier-upgrades-error',
      queue:
        view === 'tier-upgrade-accept' ? (
          <TierUpgradeAcceptPreview items={items} acceptLabel={t('actions.accept.label')} />
        ) : (
          <TierUpgradeQueueClient items={items} />
        ),
    });
    return (
      <StaffFrame path="/admin/renewals/tier-upgrades">
        <TableContainer>
          <PageHeader title={t('title')} subtitle={t('subtitle')} />
          {body}
        </TableContainer>
      </StaffFrame>
    );
  }

  // ── US7b-2: the escalation tasks queue (`Admin-renewal-tasks`, `-mobile`,
  // `Admin-state-tasks-manager`), with the empty and failed-read states.
  if (
    view === 'renewal-tasks' ||
    view === 'renewal-tasks-manager' ||
    view === 'renewal-tasks-empty' ||
    view === 'renewal-tasks-error'
  ) {
    const t = await getTranslations('admin.renewals.tasks');
    const empty = view === 'renewal-tasks-empty' || view === 'renewal-tasks-manager';
    const body = await renderTasksQueueView({
      sectionTabs: (
        <RenewalsSectionTabs
          {...RENEWALS_SECTION_COUNTS}
          {...(view === 'renewal-tasks-manager' ? { tasksCount: 0 } : {})}
          pathname="/admin/renewals/tasks"
        />
      ),
      loadFailed: view === 'renewal-tasks-error',
      nextHref: empty ? null : '/admin/renewals/tasks?cursor=preview',
      queue: (
        <EscalationTaskQueue
          canMutate={view !== 'renewal-tasks-manager'}
          actorUserId="00000000-0000-4000-8000-00000000a001"
          overdueCount={empty ? 0 : 4}
          distinctTaskTypes={empty ? [] : [...TASK_TYPES]}
          items={empty ? [] : TASK_ITEMS}
        />
      ),
    });
    return (
      <StaffFrame path="/admin/renewals/tasks">
        <TableContainer>
          <PageHeader title={t('title')} subtitle={t('subtitle')} />
          {body}
        </TableContainer>
      </StaffFrame>
    );
  }

  // ── US7b-2: the reminder schedules (`Admin-renewal-schedules`, `-mobile`),
  // opened on Premium as the boards draw it, with the failed-read state.
  if (view === 'renewal-schedules' || view === 'renewal-schedules-error') {
    const t = await getTranslations('admin.renewals.settings.schedules');
    return (
      <StaffFrame path="/admin/settings/renewals/schedules">
        <FormContainer>
          <PageHeader title={t('title')} subtitle={t('subtitle')} />
          {view === 'renewal-schedules-error' ? (
            await renderSchedulesStateView({ kind: 'failed', correlationId: '3f2a9c1e-preview' })
          ) : (
            <ScheduleEditor initialPolicies={SCHEDULE_POLICIES} readOnly={false} defaultBucket="premium" />
          )}
        </FormContainer>
      </StaffFrame>
    );
  }

  // ── US8a: the invoice list and new invoice (`Admin-invoices`,
  // `Admin-state-invoices-setup`, `Admin-invoice-new`, `Admin-record-payment`) ─
  if (
    view === 'invoices' ||
    view === 'invoices-empty' ||
    view === 'invoices-filtered' ||
    view === 'invoices-setup' ||
    view === 'record-payment'
  ) {
    const isAdmin = state !== 'manager';
    if (view === 'invoices-setup') {
      return (
        <StaffFrame path="/admin/invoices">
          <TableContainer>{await renderInvoicesSetupView({ isAdmin })}</TableContainer>
        </StaffFrame>
      );
    }
    const empty = view === 'invoices-empty' || view === 'invoices-filtered';
    const list = await renderInvoicesListView({
      isAdmin,
      isQueueView: false,
      showRegisters: true,
      show088Filters: true,
      showAutoInvoiceFilter: true,
      rows: empty ? [] : INVOICE_ROWS,
      total: empty ? 0 : INVOICE_ROWS.length,
      page: 1,
      pageSize: 50,
      hasFilters: view === 'invoices-filtered',
      draftsHidden: true,
      payIntent: false,
      showMethodColumn: false,
      todayIso: INVOICES_TODAY_ISO,
    });
    return (
      <StaffFrame path="/admin/invoices">
        <TableContainer>
          {view === 'record-payment' ? (
            <OpenFirstMatchingButton testId="row-record-payment-trigger">{list}</OpenFirstMatchingButton>
          ) : (
            list
          )}
        </TableContainer>
      </StaffFrame>
    );
  }

  if (view === 'invoice-new' || view === 'invoice-new-event') {
    const tNew = await getTranslations('admin.invoices.new');
    return (
      <StaffFrame path="/admin/invoices/new">
        <FormContainer>
          <PageHeader title={tNew('title')} subtitle={tNew('description')} />
          <InvoiceCreateSwitcher
            members={INVOICE_MEMBERS}
            plans={INVOICE_PLANS}
            events={INVOICE_EVENTS}
            taxAtPayment
            initialMemberId={view === 'invoice-new' ? 'm-3' : undefined}
            {...(view === 'invoice-new-event' ? { initialRegistrationId: 'preview-reg', initialEventId: 'ev-crayfish' } : {})}
          />
        </FormContainer>
      </StaffFrame>
    );
  }

  // ── US8b: the invoice detail, its dialogs, void and new credit note
  // (`Admin-invoice-*`, `Admin-voided`, `Admin-refund-*`, `Admin-void`,
  // `Admin-credit-note`) ─────────────────────────────────────────────────────
  if (view === 'invoice') {
    const kind = (DETAIL_KINDS as readonly string[]).includes(state) ? (state as DetailFixtureKind) : 'issued';
    const { dialog } = await searchParams;
    const fixture = detailFixture(kind);
    const detail = await renderInvoiceDetailView({
      ...fixture,
      locale: await getLocale(),
      paymentActivity: fixture.invoice.status === 'draft' ? null : <PaymentTimelineSkeleton />,
    });
    const trigger =
      dialog === 'issue'
        ? { label: (await getTranslations('admin.invoices.detail'))('actions.issue') }
        : dialog === 'delete'
          ? { label: (await getTranslations('admin.invoices.deleteDraft'))('trigger') }
          : dialog === 'refund'
            ? { testId: 'refund-dialog-trigger' }
            : null;
    return (
      <StaffFrame path={`/admin/invoices/${DETAIL_INVOICE_ID}`}>
        {trigger ? <OpenFirstMatchingButton {...trigger}>{detail}</OpenFirstMatchingButton> : detail}
      </StaffFrame>
    );
  }

  if (view === 'invoice-void') {
    const tVoid = await getTranslations('admin.invoices.void');
    return (
      <StaffFrame path={`/admin/invoices/${DETAIL_INVOICE_ID}/void`}>
        <FormContainer>
          <Link
            href={`/admin/invoices/${DETAIL_INVOICE_ID}`}
            className="inline-flex items-center gap-1 self-start text-sm text-[var(--aura-fg-accent)] hover:underline"
          >
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            {tVoid('backToInvoice')}
          </Link>
          <PageHeader title={tVoid('title')} subtitle={tVoid('descriptionBill', { number: 'SC-2026-000123' })} />
          <VoidConfirmDialog invoiceId={DETAIL_INVOICE_ID} documentNumber="SC-2026-000123" />
        </FormContainer>
      </StaffFrame>
    );
  }

  if (view === 'credit-note-new') {
    const tCn = await getTranslations('admin.creditNotes.new');
    const online = state === 'online';
    return (
      <StaffFrame path={`/admin/invoices/${DETAIL_INVOICE_ID}/credit-notes/new`}>
        <FormContainer>
          <Link
            href={`/admin/invoices/${DETAIL_INVOICE_ID}`}
            className="inline-flex items-center gap-1 self-start text-sm text-[var(--aura-fg-accent)] hover:underline"
          >
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            {tCn('backToInvoice')}
          </Link>
          <PageHeader title={tCn('title')} subtitle={tCn('description')} />
          <CreditNoteForm
            invoiceId={DETAIL_INVOICE_ID}
            documentNumber="RC-2026-000088"
            remainingSatang="3852000"
            currencySymbol="THB"
            invoiceSubject="membership"
            paymentChannel={online ? 'card' : 'bank_transfer'}
            onlineRefundState={online ? 'refundable' : 'none'}
          />
        </FormContainer>
      </StaffFrame>
    );
  }

  // Members (default view), with the state boards.
  const t = await getTranslations('admin.members');
  const isAdmin = state !== 'manager';
  // The page's own body for each state (renderMembersDirectoryBody), with
  // sample rows.
  const body = renderMembersDirectoryBody({
    plans: PLANS,
    portalInviteCount: state === 'all-invited' ? 0 : 7,
    isAdmin,
    state:
      state === 'error' || state === 'filtered' || state === 'all-invited' || state === 'empty'
        ? { kind: state }
        : { kind: 'list', rows: MEMBERS, page: 1, pageSize: 50, total: 131, filtered: false },
  });
  return (
    <StaffFrame path="/admin/members">
      {renderMembersListView({
        title: t('title'),
        subtitle: t('subtitle'),
        addMemberLabel: t('addMember'),
        canWrite: isAdmin,
        canBulk: isAdmin,
        ...(isAdmin ? {} : { readOnlyNotice: t('directory.managerReadOnlyBanner') }),
        body,
      })}
    </StaffFrame>
  );
}
