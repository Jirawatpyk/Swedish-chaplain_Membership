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
});
