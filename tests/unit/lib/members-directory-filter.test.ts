/**
 * Unit: `parseDirectoryFilterFromParams` — the shared WHERE-shaping allow-list
 * used by BOTH the members directory page and the select-all-matching ids
 * endpoint (#2 members-ux). Proves the two surfaces agree on what a filter
 * matches, and that unrecognised params never silently become an active filter.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDirectoryFilterFromParams,
  parsePortalFilter,
} from '@/lib/members-directory-filter';

describe('parseDirectoryFilterFromParams', () => {
  it('defaults to active+inactive, no filters, when no params are given', () => {
    const f = parseDirectoryFilterFromParams({});
    expect(f.status).toEqual(['active', 'inactive']);
    expect(f.portalNeedsInvite).toBe(false);
    expect(f.hasFilters).toBe(false);
    expect(f.q).toBeUndefined();
    expect(f.planId).toBeUndefined();
    expect(f.riskBand).toBeUndefined();
  });

  it('honours a valid single status and marks it as an active filter', () => {
    const f = parseDirectoryFilterFromParams({ status: 'archived' });
    expect(f.status).toEqual(['archived']);
    expect(f.hasFilters).toBe(true);
  });

  it('treats status=all as no status filter (not an active filter)', () => {
    const f = parseDirectoryFilterFromParams({ status: 'all' });
    expect(f.status).toEqual(['active', 'inactive']);
    expect(f.hasFilters).toBe(false);
  });

  it('falls back to the default status set for an unknown status value', () => {
    const f = parseDirectoryFilterFromParams({ status: 'bogus' });
    // Unknown value never reaches the WHERE (defaults to active+inactive)...
    expect(f.status).toEqual(['active', 'inactive']);
    // ...but ANY non-'all' status param still counts as an active filter —
    // faithful parity with the pre-extraction page.tsx `hasFilters` logic
    // (only 'all' and absence are treated as "no status filter").
    expect(f.hasFilters).toBe(true);
  });

  it('expands legacy show_archived=1 to all three statuses', () => {
    const f = parseDirectoryFilterFromParams({ show_archived: '1' });
    expect(f.status).toEqual(['active', 'inactive', 'archived']);
    expect(f.hasFilters).toBe(true);
  });

  it('parses a single risk band as a scalar', () => {
    const f = parseDirectoryFilterFromParams({ risk_band: 'at-risk' });
    expect(f.riskBand).toBe('at-risk');
    expect(f.hasFilters).toBe(true);
  });

  it('parses a comma list of risk bands, dropping invalid entries', () => {
    const f = parseDirectoryFilterFromParams({
      risk_band: 'critical, at-risk , bogus',
    });
    expect(f.riskBand).toEqual(['critical', 'at-risk']);
    expect(f.hasFilters).toBe(true);
  });

  it('drops an all-invalid risk band (not an active filter)', () => {
    const f = parseDirectoryFilterFromParams({ risk_band: 'bogus,nope' });
    expect(f.riskBand).toBeUndefined();
    expect(f.hasFilters).toBe(false);
  });

  it('trims q and ignores whitespace-only q', () => {
    expect(parseDirectoryFilterFromParams({ q: '  acme ' }).q).toBe('acme');
    const blank = parseDirectoryFilterFromParams({ q: '   ' });
    expect(blank.q).toBeUndefined();
    expect(blank.hasFilters).toBe(false);
  });

  it('treats plan_id=all as no plan filter', () => {
    expect(parseDirectoryFilterFromParams({ plan_id: 'p1' }).planId).toBe('p1');
    const all = parseDirectoryFilterFromParams({ plan_id: 'all' });
    expect(all.planId).toBeUndefined();
    expect(all.hasFilters).toBe(false);
  });

  it('honours the needs-invite chip and counts it as an active filter', () => {
    const f = parseDirectoryFilterFromParams({ portal: 'needs_invite' });
    expect(f.portalNeedsInvite).toBe(true);
    expect(f.hasFilters).toBe(true);
  });

  it('ignores an unknown portal value (never a phantom active filter)', () => {
    const f = parseDirectoryFilterFromParams({ portal: 'xyz' });
    expect(f.portalNeedsInvite).toBe(false);
    expect(f.hasFilters).toBe(false);
  });
});

describe('parsePortalFilter', () => {
  it('accepts only the exact "needs_invite" token', () => {
    expect(parsePortalFilter('needs_invite')).toBe(true);
    expect(parsePortalFilter(undefined)).toBe(false);
    expect(parsePortalFilter('')).toBe(false);
    expect(parsePortalFilter('needs-invite')).toBe(false);
    expect(parsePortalFilter('NEEDS_INVITE')).toBe(false);
  });
});
