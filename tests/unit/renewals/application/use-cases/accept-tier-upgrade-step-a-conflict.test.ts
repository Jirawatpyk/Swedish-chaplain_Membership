/**
 * 065 Fix B (S3 + S14) — `acceptTierUpgrade` step-(a) atomicity +
 * concurrent-conflict mapping.
 *
 * S8 moved step-(a) `supersedeAndInsertPendingAtomically` onto the outer
 * `runInTenant` tx (atomic with the step-(c) F8 CAS). But:
 *
 *   - S3: two accepters reaching step-(a) INSERT concurrently collide on
 *     the partial-unique `scheduled_plan_changes_pending_uniq` → Postgres
 *     23505. The step-(a) catch mapped it to `plan_change_failed` (502).
 *     Pre-S8 the loser reached the step-(c) CAS and got the clean
 *     `suggestion_not_open` (409). Fix: detect the 23505 on that index
 *     and treat it as the SAME concurrent-conflict outcome as a CAS loss
 *     → `suggestion_not_open` (409).
 *   - S14: the step-(a) catch did `return err(...)` inside the shared
 *     outer `runInTenant` tx — `runInTenant` COMMITS on return (only
 *     rolls back on throw). Step-(a) failures MUST THROW so the outer tx
 *     rolls back cleanly (consistent with step-(c)).
 *
 * These are use-case-level tests with `runInTenant` mocked to invoke the
 * callback with a fake tx (so the step-(a) repo throw propagates through
 * the use-case's outer try/catch exactly as it would after a real
 * rollback). The genuine concurrent-at-step-(a) race is exercised at the
 * integration level (`tier-upgrade-pending.test.ts` W-011c).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { acceptTierUpgrade } from '@/modules/renewals/application/use-cases/accept-tier-upgrade';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';

// `runInTenant` mocked to call the callback with a fake tx; a THROW from
// the callback propagates out (the use-case's outer catch then maps it).
// A `return err(...)` from the callback resolves the mock normally (the
// old S14 "return commits the partial tx" behaviour at the use-case
// boundary).
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    tierUpgradeSuggestionsAccepted: vi.fn(),
    tierUpgradeNotifyFailed: vi.fn(),
    tierUpgradeAuditEmitFailed: vi.fn(),
  },
}));

const tenant = asTenantContext('swecham');
const SUGGESTION_ID = '11111111-1111-1111-1111-111111111111';
const ACTOR_ID = '22222222-2222-2222-2222-222222222222';
const MEMBER_ID = '33333333-3333-3333-3333-333333333333';
const CYCLE_ID = '44444444-4444-4444-4444-444444444444';

const PENDING_UNIQ_INDEX = 'scheduled_plan_changes_pending_uniq';

/** A Postgres-error-shaped throw matching `isPostgresError` (code + message). */
function pgError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** A Drizzle-wrapped Postgres error (code + message live on `.cause`). */
function wrappedPgError(code: string, causeMessage: string): Error {
  const cause = pgError(code, causeMessage);
  const outer = new Error('Failed query: insert into scheduled_plan_changes');
  (outer as Error & { cause?: unknown }).cause = cause;
  return outer;
}

function makeDeps(stepASupersedeImpl: () => Promise<unknown>): RenewalsDeps {
  return {
    tenant,
    tierUpgradeRepo: {
      findById: vi.fn(async () => ({
        suggestionId: SUGGESTION_ID,
        status: 'open',
        memberId: MEMBER_ID,
        fromPlanId: 'regular',
        toPlanId: 'premium',
      })),
    },
    cyclesRepo: {
      findActiveForMember: vi.fn(async () => ({
        cycleId: CYCLE_ID,
        // Far-future expiry so the T-180 verify-task branch is skipped
        // (escalationTaskRepo isn't reached because step (a) throws first).
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      })),
    },
    scheduledPlanChangeRepo: {
      supersedeAndInsertPendingAtomically: vi.fn(stepASupersedeImpl),
    },
    clock: { now: () => new Date('2026-05-19T10:00:00Z') },
  } as unknown as RenewalsDeps;
}

const validInput = {
  tenantId: 'swecham',
  suggestionId: SUGGESTION_ID,
  actorUserId: ACTOR_ID,
  actorRole: 'admin' as const,
  correlationId: 'cor-1',
};

describe('acceptTierUpgrade — step-(a) concurrent conflict + atomicity (065 Fix B)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('S3: step-(a) 23505 on scheduled_plan_changes_pending_uniq → suggestion_not_open (409), NOT plan_change_failed', async () => {
    const deps = makeDeps(async () => {
      throw pgError('23505', `duplicate key value violates unique constraint "${PENDING_UNIQ_INDEX}"`);
    });
    const result = await acceptTierUpgrade(deps, validInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // The concurrent loser must see the SAME clean conflict shape as the
    // step-(c) CAS loser — a 409, not a 502 plan_change_failed.
    expect(result.error.kind).toBe('suggestion_not_open');
  });

  it('S3: 23505 wrapped under .cause (Drizzle 0.45+) is still mapped to suggestion_not_open', async () => {
    const deps = makeDeps(async () => {
      throw wrappedPgError(
        '23505',
        `duplicate key value violates unique constraint "${PENDING_UNIQ_INDEX}"`,
      );
    });
    const result = await acceptTierUpgrade(deps, validInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('suggestion_not_open');
  });

  it('a 23505 on a DIFFERENT constraint is NOT swallowed as a conflict → server_error (rolls back)', async () => {
    // Defence-in-depth: only THIS index's 23505 maps to the conflict
    // outcome. A future unique constraint raising 23505 must surface as a
    // genuine error (throw → rollback → server_error), not a silent 409.
    const deps = makeDeps(async () => {
      throw pgError('23505', 'duplicate key value violates unique constraint "some_other_uniq"');
    });
    const result = await acceptTierUpgrade(deps, validInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('server_error');
  });

  it('S14: a genuine infra error at step-(a) THROWS → server_error (tx rolls back), not plan_change_failed via return', async () => {
    // A non-23505 infra failure (connection reset) must THROW out of the
    // outer runInTenant so the tx rolls back. Mapped to server_error by
    // the outer catch — NOT a `return err` that would commit the partial
    // tx (the S14 trap).
    const deps = makeDeps(async () => {
      throw new Error('connection reset by peer');
    });
    const result = await acceptTierUpgrade(deps, validInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('server_error');
    if (result.error.kind !== 'server_error') throw new Error('unreachable');
    expect(result.error.message).toContain('connection reset by peer');
  });
});
