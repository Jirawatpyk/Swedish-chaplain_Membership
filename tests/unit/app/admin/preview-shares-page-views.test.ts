/**
 * 122 US5a (US5a review, 29 Sep) — the no-DB preview route renders the
 * members list and the change-request queue through the pages' own view
 * functions, never a copy of their layout: a copy drifted once, and the
 * screenshots then showed the copy, not the page.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const preview = readFileSync('src/app/test-fixtures/aura-admin/page.tsx', 'utf8');

describe('aura-admin preview renders the pages’ own views', () => {
  it('the queue through renderChangeRequestQueueView', () => {
    expect(preview).toContain('renderChangeRequestQueueView(');
    expect(preview).not.toContain('<ChangeRequestQueueTable');
    expect(preview).not.toContain('<ChangeRequestQueueFilters');
  });

  it('the members states through renderMembersDirectoryBody', () => {
    expect(preview).toContain('renderMembersDirectoryBody(');
    expect(preview).not.toContain('<MembersStateCard');
    expect(preview).not.toContain('<DirectoryWithBulk');
  });

  it('frames the review at its detail path, so the shell draws the phone back link as on the real page', () => {
    // At the queue's path the shell has no parent to link back to, and the
    // phone screenshot showed no "← Change requests" (local review, 29 Sep).
    expect(preview).toContain('<StaffFrame path={`/admin/change-requests/${request.id}`}>');
  });

  it('the member detail, timeline and benefits through their views, framed at their real paths (US5b-1)', () => {
    expect(preview).toContain('renderMemberDetailView(');
    expect(preview).toContain('renderMemberTimelineView(');
    expect(preview).toContain('renderMemberBenefitsView(');
    expect(preview).toContain('<StaffFrame path={`/admin/members/${MEMBER_ID}`}>');
    // The sections render through the page's own cards, never a copy.
    expect(preview).toContain('<MemberInvoicesCard');
    expect(preview).toContain('<MemberSummaryStrip');
    expect(preview).not.toContain('<MemberInvoicesTable');
  });

  it('the plans pages through their views, framed at their real paths (US6)', () => {
    expect(preview).toContain('renderPlansListView(');
    expect(preview).toContain('renderPlanDetailView(');
    expect(preview).toContain('renderNewPlanView(');
    expect(preview).toContain('renderPlanEditView(');
    expect(preview).toContain('renderCloneYearView(');
    expect(preview).toContain('<StaffFrame path="/admin/plans">');
    expect(preview).toContain('<StaffFrame path={`/admin/plans/${PLAN_YEAR}/${PLAN_ID}`}>');
    // The list renders through the page's own table, never a copy.
    expect(preview).toContain('<PlansTable');
  });

  it('the renewals pipeline through the page’s own view, framed at its real path (US7a)', () => {
    const page = readFileSync('src/app/(staff)/admin/renewals/page.tsx', 'utf8');
    for (const view of ['renderRenewalsPipelineView(', 'renderPipelineLens(', 'renderPipelineLoadError(']) {
      expect(page).toContain(view);
      expect(preview).toContain(view);
    }
    expect(preview).toContain('<StaffFrame path="/admin/renewals">');
    // No copy of the lens: the filters and table come only from the view.
    expect(preview).not.toContain('<PipelineWithBulk');
    expect(preview).not.toContain('<UrgencyBucketTabs');
  });

  it('the cycle detail and tier upgrade pages through their own views (US7b-1)', () => {
    const cycle = readFileSync('src/app/(staff)/admin/renewals/[cycleId]/page.tsx', 'utf8');
    const tiers = readFileSync('src/app/(staff)/admin/renewals/tier-upgrades/page.tsx', 'utf8');
    for (const view of ['renderCycleDetailView(', '<CycleDetailBadges']) {
      expect(cycle).toContain(view);
      expect(preview).toContain(view);
    }
    expect(tiers).toContain('renderTierUpgradesView(');
    expect(preview).toContain('renderTierUpgradesView(');
    expect(preview).toContain('<StaffFrame path={`/admin/renewals/${CYCLE_PREVIEW_ID}`}>');
    expect(preview).toContain('<StaffFrame path="/admin/renewals/tier-upgrades">');
    // No copy of the cards or the queue table: they come only from the views.
    expect(preview).not.toContain('sectionMemberPlan');
    expect(preview).not.toContain('<DataTable');
  });

  it('the escalation tasks and reminder schedules through their own views (US7b-2)', () => {
    const tasks = readFileSync('src/app/(staff)/admin/renewals/tasks/page.tsx', 'utf8');
    const schedules = readFileSync('src/app/(staff)/admin/settings/renewals/schedules/page.tsx', 'utf8');
    expect(tasks).toContain('renderTasksQueueView(');
    expect(preview).toContain('renderTasksQueueView(');
    expect(schedules).toContain('renderSchedulesStateView(');
    expect(preview).toContain('renderSchedulesStateView(');
    // The editor is the page's own client component, never a copy.
    expect(preview).toContain('<ScheduleEditor');
    expect(preview).toContain('<EscalationTaskQueue');
    expect(preview).toContain('<StaffFrame path="/admin/renewals/tasks">');
    expect(preview).toContain('<StaffFrame path="/admin/settings/renewals/schedules">');
  });

  it('the invoice list and new invoice through the pages’ own views and components (US8a)', () => {
    const list = readFileSync('src/app/(staff)/admin/invoices/page.tsx', 'utf8');
    const create = readFileSync('src/app/(staff)/admin/invoices/new/page.tsx', 'utf8');
    for (const view of ['renderInvoicesListView(', 'renderInvoicesSetupView(']) {
      expect(list).toContain(view);
      expect(preview).toContain(view);
    }
    expect(create).toContain('<InvoiceCreateSwitcher');
    expect(preview).toContain('<InvoiceCreateSwitcher');
    expect(preview).not.toContain('<InvoicesTable');
    expect(preview).toContain('<StaffFrame path="/admin/invoices">');
    expect(preview).toContain('<StaffFrame path="/admin/invoices/new">');
  });
});
