/**
 * buildAuditPaginationLinks — the audit viewer's bidirectional-keyset nav
 * derivation (First/Latest + Previous(dir=prev) + Next), extracted from the
 * server component so it's unit-testable without rendering the page.
 */
import { describe, expect, it } from 'vitest';
import { buildAuditPaginationLinks } from '@/app/(staff)/admin/audit/_lib/pagination-links';

const BASE = '/admin/audit';

describe('buildAuditPaginationLinks', () => {
  it('first page, no adjacent rows → only firstHref, nothing else shown', () => {
    const r = buildAuditPaginationLinks({
      basePath: BASE,
      filterParams: new URLSearchParams(),
      cursor: '',
      prevCursor: null,
      nextCursor: null,
    });
    expect(r.firstHref).toBe('/admin/audit');
    expect(r.showFirst).toBe(false);
    expect(r.prevHref).toBeNull();
    expect(r.nextHref).toBeNull();
  });

  it('first page with older rows → Next only (no dir param), no First/Previous', () => {
    const r = buildAuditPaginationLinks({
      basePath: BASE,
      filterParams: new URLSearchParams(),
      cursor: '',
      prevCursor: null,
      nextCursor: 'NEXT',
    });
    expect(r.showFirst).toBe(false);
    expect(r.prevHref).toBeNull();
    expect(r.nextHref).toBe('/admin/audit?cursor=NEXT'); // no dir → forward/older
  });

  it('a deep page → First + Previous(dir=prev) + Next, all preserving the filters', () => {
    const filters = new URLSearchParams({ eventType: 'role_changed', from: '2026-01-01' });
    const r = buildAuditPaginationLinks({
      basePath: BASE,
      filterParams: filters,
      cursor: 'CUR',
      prevCursor: 'PREV',
      nextCursor: 'NEXT',
    });
    expect(r.showFirst).toBe(true);
    // First = filters only, NO cursor/dir.
    expect(r.firstHref).toBe('/admin/audit?eventType=role_changed&from=2026-01-01');
    // Previous carries dir=prev + prevCursor + filters.
    expect(r.prevHref).toContain('cursor=PREV');
    expect(r.prevHref).toContain('dir=prev');
    expect(r.prevHref).toContain('eventType=role_changed');
    // Next carries nextCursor + filters, NO dir.
    expect(r.nextHref).toContain('cursor=NEXT');
    expect(r.nextHref).not.toContain('dir=');
    expect(r.nextHref).toContain('from=2026-01-01');
    // The filter param is never mutated by the link builder.
    expect(filters.get('eventType')).toBe('role_changed');
  });

  it('newest edge reached via a cursor (prevCursor null) → First shown, Previous hidden', () => {
    const r = buildAuditPaginationLinks({
      basePath: BASE,
      filterParams: new URLSearchParams(),
      cursor: 'CUR',
      prevCursor: null,
      nextCursor: 'NEXT',
    });
    expect(r.showFirst).toBe(true); // a cursor is present → escape via Latest
    expect(r.prevHref).toBeNull(); // no newer rows
    expect(r.nextHref).not.toBeNull();
  });
});
