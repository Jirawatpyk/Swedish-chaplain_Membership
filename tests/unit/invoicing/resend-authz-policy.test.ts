/**
 * S9 — Resend route authz contract.
 *
 * POST /api/invoices/[id]/resend + /api/credit-notes/[id]/resend call
 * `requireAdminContext(..., { action: 'write' })`. Per
 * `src/modules/auth/domain/policies.ts`:
 *
 *   - admin   → write allowed
 *   - manager → write REJECTED (read-only on finance surfaces)
 *   - member  → not an admin role; the admin-context guard returns 403
 *
 * This test pins the policy matrix so a future refactor that widens
 * `manager` to write on `invoice` fails loudly. A full HTTP-level
 * integration test requires cookie/session plumbing and lives in a
 * separate E2E; this unit test covers the load-bearing policy call
 * that backs the route.
 */
import { describe, expect, it } from 'vitest';
import { canAccess } from '@/modules/auth/domain/policies';

describe('S9 — resend route policy (invoice write)', () => {
  it('admin can write on invoice → resend allowed', () => {
    expect(canAccess('admin', 'invoice', 'write')).toBe(true);
  });

  it('manager CANNOT write on invoice → resend must return 403', () => {
    expect(canAccess('manager', 'invoice', 'write')).toBe(false);
  });

  it('member is not granted write on invoice via admin-context path', () => {
    expect(canAccess('member', 'invoice', 'write')).toBe(false);
  });

  it('manager CAN read invoice (dashboards, detail pages)', () => {
    expect(canAccess('manager', 'invoice', 'read')).toBe(true);
  });

  it('admin can write on credit_note → CN resend allowed', () => {
    expect(canAccess('admin', 'credit_note', 'write')).toBe(true);
  });

  it('manager CANNOT write on credit_note → CN resend must return 403', () => {
    expect(canAccess('manager', 'credit_note', 'write')).toBe(false);
  });
});
