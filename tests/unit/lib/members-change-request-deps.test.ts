/**
 * F114 T028 — the `src/lib` composition root for change requests.
 *
 * Pins two things TypeScript cannot: (1) the reviewer set comes from the
 * permission EVALUATOR, so the SQL filters on exactly the roles that hold
 * `members.write` today (admin + super_admin — never manager / marketing /
 * member) and on `status = 'active'`; (2) `buildChangeRequestDeps` wires the
 * real singletons (a type-compatible but WRONG adapter for `audit` would
 * silently break the FR-025 trail).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectRows = vi.fn();
const whereSpy = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => {
          whereSpy(...args);
          return { orderBy: async () => selectRows() };
        },
      }),
    }),
  },
  runInTenant: vi.fn(),
}));

import { ROLES } from '@/modules/auth';
import { asTenantContext } from '@/modules/tenants';
import {
  drizzleChangeRequestRepo,
  drizzleContactRepo,
  drizzleMemberRepo,
  drizzleTenantMemberChangeSettingsRepo,
  f3DrizzleAuditAdapter,
} from '@/modules/members';
import { resendEmailPort } from '@/modules/members/infrastructure/adapters/resend-email-port';
import {
  buildChangeRequestDeps,
  makeReviewerDirectory,
  reviewerRoles,
} from '@/lib/members-change-request-deps';

const tenant = asTenantContext('test-tenant');

beforeEach(() => {
  selectRows.mockReset();
  whereSpy.mockReset();
});

describe('reviewerRoles', () => {
  it('is exactly the roles the evaluator says hold members.write — admin + super_admin', () => {
    expect([...reviewerRoles()].sort()).toEqual(['admin', 'super_admin']);
    // and NOT the read-only staff roles or the member role
    for (const excluded of ['manager', 'marketing', 'member'] as const) {
      expect(reviewerRoles()).not.toContain(excluded);
      expect(ROLES).toContain(excluded); // the exclusion is a decision, not an absence
    }
  });
});

describe('makeReviewerDirectory', () => {
  it('lists active users in the reviewer roles with the platform default locale', async () => {
    selectRows.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000001', email: 'a@staff.example' },
      { id: '00000000-0000-4000-8000-000000000002', email: 'b@staff.example' },
    ]);
    const reviewers = await makeReviewerDirectory().listReviewers();
    expect(reviewers).toEqual([
      { userId: '00000000-0000-4000-8000-000000000001', email: 'a@staff.example', locale: 'en' },
      { userId: '00000000-0000-4000-8000-000000000002', email: 'b@staff.example', locale: 'en' },
    ]);
    expect(whereSpy).toHaveBeenCalledTimes(1);
  });

  it('an empty roster is a valid answer (misconfigured tenant — the use case warns, never throws)', async () => {
    selectRows.mockResolvedValue([]);
    await expect(makeReviewerDirectory().listReviewers()).resolves.toEqual([]);
  });
});

describe('buildChangeRequestDeps', () => {
  it('wires the real singletons by reference', () => {
    const deps = buildChangeRequestDeps(tenant);
    expect(deps.tenant).toBe(tenant);
    expect(deps.changeRequestRepo).toBe(drizzleChangeRequestRepo);
    expect(deps.memberRepo).toBe(drizzleMemberRepo);
    expect(deps.contactRepo).toBe(drizzleContactRepo);
    expect(deps.audit).toBe(f3DrizzleAuditAdapter);
    expect(deps.emails).toBe(resendEmailPort);
    expect(deps.tenantMemberChangeSettings).toBe(drizzleTenantMemberChangeSettingsRepo);
    expect(typeof deps.reviewers.listReviewers).toBe('function');
    expect(typeof deps.memberChangeGate.resolve).toBe('function');
    expect(deps.clock.now()).toBeInstanceOf(Date);
  });
});
