/**
 * On a wide screen the spare width is shared by every column of text that
 * wraps, not given to one column (maintainer, 19 Oct 2026, option ก): those
 * columns take a minimum (`minWidth`, AURA's flexible column) instead of a
 * fixed width, so they keep today's size on a laptop and stop wrapping once
 * there is room. Short columns (numbers, pills, dates, buttons) keep a fixed
 * width. The invoice row actions fit "Record payment…" and the ⋯ on one line
 * so the ⋯ ends at the same place on every row, and a six-figure total fits.
 */
import { describe, expect, it } from 'vitest';
import { MEMBERS_COLUMN_SIZES } from '@/components/members/members-table-columns';
import { INVOICES_COLUMN_LAYOUT } from '@/app/(staff)/admin/invoices/_components/invoices-table-columns';
import { DIRECTORY_COLUMN_LAYOUT } from '@/components/directory/directory-table-layout';
import { AUDIENCE_COLUMN_WIDTHS, AUDIENCE_MIN_WIDTH } from '@/app/(staff)/admin/marketing/audience/_components/audience-table';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const flexible = (column: object): boolean => 'minWidth' in column && !('width' in column);

describe('wide screens share the spare width among the columns of text', () => {
  it('members: Company, Primary contact and Plan are flexible; the short columns stay fixed', () => {
    expect(flexible(MEMBERS_COLUMN_SIZES.company_name)).toBe(true);
    expect(flexible(MEMBERS_COLUMN_SIZES.primary_contact)).toBe(true);
    expect(flexible(MEMBERS_COLUMN_SIZES.plan_display_name)).toBe(true);
    for (const key of ['member_number_display', 'status', 'engagement', 'last_activity_at', 'actions'] as const) {
      expect(flexible(MEMBERS_COLUMN_SIZES[key]), key).toBe(false);
    }
  });

  it('directory: Company, Tier, Industry, Location and Contact are flexible; Listed and Logo stay fixed', () => {
    const byKey = Object.fromEntries(DIRECTORY_COLUMN_LAYOUT.map((c) => [c.key, c]));
    for (const key of ['companyName', 'tier', 'industry', 'location', 'contactName']) {
      expect(flexible(byKey[key] as object), key).toBe(true);
    }
    for (const key of ['listed', 'hasLogo']) expect(flexible(byKey[key] as object), key).toBe(false);
  });

  it('marketing audience: Contact and Member share the spare width (no fixed column width)', () => {
    expect(AUDIENCE_COLUMN_WIDTHS).not.toHaveProperty('member');
    expect(AUDIENCE_COLUMN_WIDTHS).not.toHaveProperty('contact');
  });

  it('marketing audience: fits the 1280px window without scrolling sideways (959px box, 15px spare)', () => {
    expect(AUDIENCE_MIN_WIDTH.withSwitch).toBeLessThanOrEqual(944);
  });

  it('hand-drawn table skeletons read the real table’s widths from the same module, not copied literals', () => {
    const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
    const audience = read('src/app/(staff)/admin/marketing/audience/_components/audience-table-skeleton.tsx');
    expect(audience).toMatch(/from '\.\/audience-table-layout'/);
    expect(audience).not.toMatch(/\[184, 184, 112/);
    const queue = read('src/app/(staff)/admin/broadcasts/loading.tsx');
    expect(queue).toMatch(/QUEUE_COLUMN_LAYOUT/);
    expect(read('src/components/broadcast/admin/queue-table-client.tsx')).toMatch(/QUEUE_COLUMN_LAYOUT/);
  });

  it('invoices: the row actions fit Record payment… beside the ⋯, and a six-figure total fits one line', () => {
    // 138px ghost button + 4px gap + 32px ⋯ + AURA's 32px of cell padding.
    expect(INVOICES_COLUMN_LAYOUT.actions.width).toBeGreaterThanOrEqual(206);
    // "107,000.00 THB" is 110px at 14px tabular figures, plus the padding.
    expect(INVOICES_COLUMN_LAYOUT.total.width).toBeGreaterThanOrEqual(136);
  });
});
