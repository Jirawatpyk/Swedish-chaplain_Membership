/**
 * 108 PR-D T058 (FR-035) — URL search params → Marketing audience filter.
 *
 * One allow-listed parser for the page so a hostile or stale query string can
 * only ever narrow the view, never widen it: unknown `kind` / `state` values
 * are dropped, `member_id` must be a UUID, `eligible` defaults to ON (the
 * spec's default view) and is lifted only by an explicit `eligible=0`, and
 * `page` clamps to ≥ 1. `hasFilters` drives the "no matches → clear filters"
 * empty state (FR-035b). The pre-flight preset is exactly
 * `kind=secondary&state=on&eligible=1` (FR-027a).
 */
import { describe, expect, it } from 'vitest';
import {
  MARKETING_AUDIENCE_PREFLIGHT_QUERY,
  parseMarketingAudienceParams,
  MARKETING_AUDIENCE_MAX_PAGE,
  AUDIENCE_COUNT_ID,
} from '@/lib/marketing-audience-filter';

const MEMBER = '11111111-2222-4333-8444-555555555555';

describe('parseMarketingAudienceParams', () => {
  it('defaults: eligible on, page 1, no other legs, hasFilters false', () => {
    const p = parseMarketingAudienceParams({});
    expect(p.filter).toEqual({ eligible: true });
    expect(p.page).toBe(1);
    expect(p.hasFilters).toBe(false);
  });

  it('q is trimmed, empty q is dropped', () => {
    expect(parseMarketingAudienceParams({ q: '  acme ' }).filter.q).toBe('acme');
    expect(parseMarketingAudienceParams({ q: '   ' }).filter.q).toBeUndefined();
  });

  it('q is capped at 100 characters (the directory search cap)', () => {
    const long = 'a'.repeat(150);
    expect(parseMarketingAudienceParams({ q: long }).filter.q).toHaveLength(100);
  });

  it('member_id must be a UUID (lower-cased); anything else is dropped', () => {
    expect(parseMarketingAudienceParams({ member_id: MEMBER.toUpperCase() }).filter.memberId).toBe(MEMBER);
    expect(parseMarketingAudienceParams({ member_id: 'nope' }).filter.memberId).toBeUndefined();
  });

  it.each(['primary', 'secondary'] as const)('kind=%s passes through', (kind) => {
    expect(parseMarketingAudienceParams({ kind }).filter.kind).toBe(kind);
  });

  it('kind outside the allow-list is dropped', () => {
    expect(parseMarketingAudienceParams({ kind: 'all' }).filter.kind).toBeUndefined();
  });

  it.each([
    ['on', 'on'],
    ['off_staff', 'off_by_staff'],
    ['off_contact', 'off_by_contact'],
    ['unsubscribed', 'unsubscribed'],
  ] as const)('state=%s → filter state %s (URL vocabulary is the contract § 3 one)', (raw, state) => {
    expect(parseMarketingAudienceParams({ state: raw }).filter.state).toBe(state);
  });

  it('state=unavailable (a display outcome, not a filter) and unknown states are dropped', () => {
    expect(parseMarketingAudienceParams({ state: 'unavailable' }).filter.state).toBeUndefined();
    expect(parseMarketingAudienceParams({ state: 'maybe' }).filter.state).toBeUndefined();
  });

  it('eligible: default true; only an explicit 0 / false lifts it', () => {
    expect(parseMarketingAudienceParams({ eligible: '1' }).filter.eligible).toBe(true);
    expect(parseMarketingAudienceParams({ eligible: '0' }).filter.eligible).toBe(false);
    expect(parseMarketingAudienceParams({ eligible: 'false' }).filter.eligible).toBe(false);
    expect(parseMarketingAudienceParams({ eligible: 'banana' }).filter.eligible).toBe(true);
  });

  it('page parses positive integers and clamps everything else to 1', () => {
    expect(parseMarketingAudienceParams({ page: '3' }).page).toBe(3);
    for (const raw of ['0', '-2', 'x', '2.7', undefined]) {
      expect(parseMarketingAudienceParams({ page: raw }).page).toBe(raw === '2.7' ? 2 : 1);
    }
  });

  it('page is clamped UPWARD too (security LOW-4): an absurd page cannot become a huge OFFSET', () => {
    expect(MARKETING_AUDIENCE_MAX_PAGE).toBe(100_000);
    expect(parseMarketingAudienceParams({ page: '99999999999999999999' }).page).toBe(
      MARKETING_AUDIENCE_MAX_PAGE,
    );
    expect(parseMarketingAudienceParams({ page: String(MARKETING_AUDIENCE_MAX_PAGE + 1) }).page).toBe(
      MARKETING_AUDIENCE_MAX_PAGE,
    );
    expect(parseMarketingAudienceParams({ page: String(MARKETING_AUDIENCE_MAX_PAGE) }).page).toBe(
      MARKETING_AUDIENCE_MAX_PAGE,
    );
  });

  it('hasFilters is true for any narrowing leg, and for eligible=0 (the default was lifted)', () => {
    expect(parseMarketingAudienceParams({ q: 'x' }).hasFilters).toBe(true);
    expect(parseMarketingAudienceParams({ kind: 'primary' }).hasFilters).toBe(true);
    expect(parseMarketingAudienceParams({ state: 'on' }).hasFilters).toBe(true);
    expect(parseMarketingAudienceParams({ member_id: MEMBER }).hasFilters).toBe(true);
    expect(parseMarketingAudienceParams({ eligible: '0' }).hasFilters).toBe(true);
    expect(parseMarketingAudienceParams({ page: '4' }).hasFilters).toBe(false);
  });

  it('the pre-flight preset is the FR-027a query and parses to secondary + on + eligible', () => {
    expect(MARKETING_AUDIENCE_PREFLIGHT_QUERY).toBe('kind=secondary&state=on&eligible=1');
    const p = parseMarketingAudienceParams(
      Object.fromEntries(new URLSearchParams(MARKETING_AUDIENCE_PREFLIGHT_QUERY)),
    );
    expect(p.filter).toEqual({ kind: 'secondary', state: 'on', eligible: true });
  });

  it('accepts string[] values (Next.js repeats) by taking the first', () => {
    expect(parseMarketingAudienceParams({ kind: ['primary', 'secondary'] }).filter.kind).toBe('primary');
  });
});

describe('narrowed vs hasFilters (cycle 15, review code M1)', () => {
  // `eligible=on` is the DEFAULT, so it is not a filter the user set — but it
  // does narrow the query (active, not erased, not halted). A tenant whose
  // members are all inactive/archived would otherwise be told "No contacts
  // yet" with no way back, and the count line would claim a total that is not
  // the tenant's total. `hasFilters` still drives "did the USER filter?";
  // `narrowed` drives "is this a subset?".
  it('the default view is not filtered but IS narrowed', () => {
    const p = parseMarketingAudienceParams({});
    expect(p.hasFilters).toBe(false);
    expect(p.narrowed).toBe(true);
  });

  it('eligible=0 lifts the narrowing: nothing is filtered and nothing is narrowed', () => {
    const p = parseMarketingAudienceParams({ eligible: '0' });
    expect(p.hasFilters).toBe(true);
    expect(p.narrowed).toBe(false);
  });

  it('any user filter narrows too', () => {
    expect(parseMarketingAudienceParams({ q: 'x' }).narrowed).toBe(true);
    expect(parseMarketingAudienceParams({ state: 'on' }).narrowed).toBe(true);
    expect(parseMarketingAudienceParams({ kind: 'secondary', eligible: '0' }).narrowed).toBe(true);
  });
});

describe('AUDIENCE_COUNT_ID (cycle 15, review code L1)', () => {
  it('is a plain string exported from a server-safe module', () => {
    // It used to be exported from `marketing-switch.tsx` ('use client'), so a
    // Server Component importing it received a client-reference proxy rather
    // than the string. It worked only because the page passed it straight
    // through as a prop; `String(...)` or a template literal would have thrown.
    expect(AUDIENCE_COUNT_ID).toBe('audience-count');
    expect(typeof AUDIENCE_COUNT_ID).toBe('string');
  });
});
