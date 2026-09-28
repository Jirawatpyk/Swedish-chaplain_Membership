import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { PageHeader } from '@/components/layout/page-header';
import { StaffShell } from '@/components/layout/staff-shell';
import { TableContainer } from '@/components/layout';
import { AuraDensity } from '@/components/providers/aura-bridge';
import { DirectoryFilters, type PlanOption } from '@/components/members/directory-filters';
import type { MembersTableRow } from '@/components/members/members-table';
import {
  MembersAllInvitedEmptyState,
  MembersErrorState,
  MembersStateCard,
  MembersFilteredEmptyState,
  MembersZeroState,
} from '@/components/members/empty-states';
import type { DirectoryTableRow } from '@/components/directory/directory-table';
import type { RecentExportRow } from '@/components/directory/recent-exports';
import { GenerateExportActions } from '@/components/directory/generate-export-actions';
import type { ChangeRequestReviewFieldView, StaffChangeRequestView } from '@/lib/change-request-staff-view';
import type { ChangeRequestQueueItem } from '@/modules/members';
import { EmptyState } from '@/components/shell/empty-state';
import { InboxIcon } from 'lucide-react';
import { flattenNavItems, staffNavConfig } from '@/config/nav';
import { renderMembersListView } from '@/app/(staff)/admin/members/page';
import { DirectoryWithBulk } from '@/app/(staff)/admin/members/_components/directory-with-bulk';
import { renderDirectoryView } from '@/app/(staff)/admin/directory/page';
import { ChangeRequestQueueFilters } from '@/app/(staff)/admin/change-requests/_components/queue-filters';
import { ChangeRequestQueueTable } from '@/app/(staff)/admin/change-requests/_components/queue-table';
import { renderChangeRequestReviewView } from '@/app/(staff)/admin/change-requests/[id]/page';

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

export default async function AuraAdminPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; state?: string }>;
}) {
  if (!process.env.ALLOW_TEST_ROUTES) notFound();
  const { view = 'members', state = 'default' } = await searchParams;

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
    const t = await getTranslations('admin.changeRequests.queue');
    const empty = state === 'empty';
    return (
      <StaffFrame path="/admin/change-requests">
        <TableContainer>
          <PageHeader
            title={t('title')}
            subtitle={t('subtitle')}
            actions={
              empty ? undefined : (
                <p className="text-sm text-[var(--aura-fg-secondary)]" data-testid="queue-pending-count">
                  {t('pendingSummary', { count: 3, oldestDays: 6 })}
                </p>
              )
            }
          />
          <ChangeRequestQueueFilters resultCount={empty ? 0 : QUEUE.length} hasMore={false} />
          {/* The page's own empty state (default filters), as the page renders it. */}
          {empty ? (
            <div data-testid="queue-empty">
              <EmptyState icon={InboxIcon} title={t('empty')} description={t('emptyHint')} bordered />
            </div>
          ) : (
            <ChangeRequestQueueTable items={QUEUE} />
          )}
        </TableContainer>
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
    return (
      <StaffFrame path="/admin/change-requests">
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

  // Members (default view), with the state boards.
  const t = await getTranslations('admin.members');
  const isAdmin = state !== 'manager';
  const body =
    state === 'error' ? (
      <MembersStateCard>
        <DirectoryFilters plans={PLANS} portalInviteCount={7} />
        <MembersErrorState />
      </MembersStateCard>
    ) : state === 'filtered' ? (
      <MembersStateCard>
        <DirectoryFilters plans={PLANS} portalInviteCount={7} />
        <MembersFilteredEmptyState />
      </MembersStateCard>
    ) : state === 'all-invited' ? (
      <MembersStateCard>
        <DirectoryFilters plans={PLANS} portalInviteCount={0} />
        <MembersAllInvitedEmptyState />
      </MembersStateCard>
    ) : state === 'empty' ? (
      <MembersZeroState canAddMember />
    ) : (
      <>
        <DirectoryFilters plans={PLANS} portalInviteCount={7} />
        <DirectoryWithBulk rows={MEMBERS} page={1} pageSize={50} total={131} isAdmin={isAdmin} />
      </>
    );
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
