/**
 * Shared fixtures for resend-verification contract tests.
 *
 * NOTE: vi.mock() declarations are NOT here — they are HOISTED above all
 * imports by Vitest and must live in each test file. Only plain values and
 * factory functions that do not depend on vi.mock hoisting live here.
 */
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Shared UUID constants
// ---------------------------------------------------------------------------

export const memberId = '11111111-1111-1111-1111-111111111111';
export const contactId = '22222222-2222-2222-2222-222222222222';

// ---------------------------------------------------------------------------
// Shared admin context fixture
// ---------------------------------------------------------------------------

export const adminContext = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-1',
};

// ---------------------------------------------------------------------------
// Request / params helpers
// ---------------------------------------------------------------------------

export function makeRequest(
  overrideMemberId = memberId,
  overrideContactId = contactId,
): NextRequest {
  return new NextRequest(
    `http://localhost:3100/api/members/${overrideMemberId}/contacts/${overrideContactId}/resend-verification`,
    { method: 'POST' },
  );
}

export const routeParams = async () => ({ memberId, contactId });

// ---------------------------------------------------------------------------
// buildMembersDeps mock shape factory
// Returns the object shape expected by the route — each test file creates
// its OWN vi.fn() wrapper so that per-test clearAllMocks() isolation is
// preserved.  This helper only describes the SHAPE; callers pass their own
// vi.fn().
// ---------------------------------------------------------------------------

export function makeBuildMembersDepsMockReturn() {
  return {
    contactRepo: {},
    tokens: {},
    emails: {},
    userEmails: {},
    audit: {},
    clock: { now: () => new Date() },
  };
}
