/**
 * Bug #15 (2026-07-10) — the FEATURE_F7_BROADCASTS kill-switch path matcher
 * missed two F7 state-changing API routes that live OUTSIDE the
 * /api/broadcasts + /api/admin/broadcasts prefixes:
 *   - POST /api/admin/members/<id>/broadcasts-halt-clear
 *   - POST /api/portal/broadcasts/acknowledge
 * Both stayed writable with F7 disabled. This locks the full path set.
 */
import { describe, expect, it } from 'vitest';
import { matchesF7KillSwitchPath } from '@/proxy';

describe('matchesF7KillSwitchPath — F7 kill-switch coverage (bug #15)', () => {
  it('covers the two previously-missed F7 routes', () => {
    expect(
      matchesF7KillSwitchPath(
        '/api/admin/members/11111111-1111-1111-1111-111111111111/broadcasts-halt-clear',
      ),
    ).toBe(true);
    expect(matchesF7KillSwitchPath('/api/portal/broadcasts/acknowledge')).toBe(
      true,
    );
    // Code-review follow-up: the member snapshot-template write route.
    expect(
      matchesF7KillSwitchPath(
        '/api/member/broadcasts/draft/22222222-2222-2222-2222-222222222222/snapshot-template',
      ),
    ).toBe(true);
  });

  it('still covers the originally-gated F7 surfaces', () => {
    for (const p of [
      '/api/broadcasts/submit',
      '/api/broadcasts/draft',
      '/api/admin/broadcasts/abc/approve',
      '/api/webhooks/resend-broadcasts',
      '/unsubscribe/v1.token.mac',
      '/portal/broadcasts/new',
      '/admin/broadcasts',
      '/portal/benefits/e-blasts',
    ]) {
      expect(matchesF7KillSwitchPath(p)).toBe(true);
    }
  });

  it('does NOT over-match unrelated routes', () => {
    for (const p of [
      '/api/admin/members/11111111-1111-1111-1111-111111111111', // member detail, not halt-clear
      '/api/admin/members/11111111-1111-1111-1111-111111111111/block-auto-reactivation', // F8, not F7
      '/api/portal/invoices',
      '/api/members',
      '/portal/profile',
      '/admin/dashboard',
    ]) {
      expect(matchesF7KillSwitchPath(p)).toBe(false);
    }
  });
});
