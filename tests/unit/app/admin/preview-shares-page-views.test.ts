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
});
