/**
 * Unit tests for `eraseUser` use case (COMP-1 US2a — Member Erasure F1
 * linked-user erasure / GDPR Art.17 · PDPA §33).
 *
 * `eraseUser` anonymises an F1 login account in its OWN owner-role
 * `db.transaction` (the `users` table is cross-tenant — no tenant_id, no RLS —
 * so it cannot join a members `runInTenant` tx; mirrors `delete-invited-user`).
 * Security-critical credential surface → branches under test:
 *   1. happy path — anonymise the users row, revoke sessions, emit `user_erased`
 *      at the TAIL → ok({ erased: true }).
 *   2. already-gone — `anonymiseErasedInTx` returns { erased: false } (no row
 *      matched the id) → that is NOT an error → ok({ erased: false }).
 *   3. fault — a DB error inside the tx (anonymise / session-revoke throws) is
 *      caught, logged, and mapped to err({ code: 'erase-user-failed' }); the use
 *      case NEVER throws across the boundary (Principle VIII).
 *   4. ordering — `user_erased` is emitted AFTER the anonymise + revoke (tail of
 *      the tx; the auth `appendInTx` never-throws so a poisoned tx swallows it).
 *
 * The `db.transaction` mock invokes the callback with a dummy tx and re-throws
 * inner errors (mirrors Drizzle: `return` commits, `throw` rolls back) — the
 * same pattern as `delete-invited-user.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// db.transaction(fn) — invoke callback with a fake tx; re-throw inner errors so
// the outer catch in the use case observes them (Drizzle rollback semantics).
vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({} as never)),
  },
}));
// Prevent defaultEraseUserDeps from pulling Drizzle at test boot.
vi.mock('@/lib/auth-deps', () => ({ defaultEraseUserDeps: {} }));

import { eraseUser } from '@/modules/auth/application/erase-user';
import type { EraseUserDeps } from '@/modules/auth/application/erase-user';
import { logger } from '@/lib/logger';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const META = {
  actorUserId: '22222222-2222-4222-8222-222222222222',
  requestId: 'req-erase-user-001',
  sourceIp: null,
} as const;

function makeDeps(overrides: Partial<EraseUserDeps> = {}): {
  deps: EraseUserDeps;
  anonymiseErasedInTx: ReturnType<typeof vi.fn>;
  deleteByUserIdInTx: ReturnType<typeof vi.fn>;
  appendInTx: ReturnType<typeof vi.fn>;
} {
  const anonymiseErasedInTx = vi.fn(async () => ({ erased: true }));
  const deleteByUserIdInTx = vi.fn(async () => 2);
  const appendInTx = vi.fn(async () => undefined);
  const deps: EraseUserDeps = {
    users: { anonymiseErasedInTx } as unknown as EraseUserDeps['users'],
    sessions: { deleteByUserIdInTx } as unknown as EraseUserDeps['sessions'],
    audit: { appendInTx } as unknown as EraseUserDeps['audit'],
    ...overrides,
  };
  return { deps, anonymiseErasedInTx, deleteByUserIdInTx, appendInTx };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('eraseUser (F1 linked-user erasure)', () => {
  it('anonymises the user, revokes sessions, emits user_erased → ok(erased:true)', async () => {
    const { deps, anonymiseErasedInTx, deleteByUserIdInTx, appendInTx } = makeDeps();

    const result = await eraseUser({ userId: USER_ID, ...META }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.erased).toBe(true);
    // Anonymise keyed by the exact id.
    expect(anonymiseErasedInTx).toHaveBeenCalledOnce();
    expect(anonymiseErasedInTx).toHaveBeenCalledWith(expect.anything(), USER_ID);
    // Sessions revoked for the same id.
    expect(deleteByUserIdInTx).toHaveBeenCalledOnce();
    expect(deleteByUserIdInTx).toHaveBeenCalledWith(expect.anything(), USER_ID);
    // `user_erased` emitted, target = the erased user, no PII in summary.
    expect(appendInTx).toHaveBeenCalledOnce();
    const event = appendInTx.mock.calls[0]?.[1] as
      | { eventType: string; targetUserId: string; summary: string; requestId: string }
      | undefined;
    expect(event?.eventType).toBe('user_erased');
    expect(event?.targetUserId).toBe(USER_ID);
    expect(event?.requestId).toBe('req-erase-user-001');
    // No email / display-name PII leaks into the audit summary.
    expect(event?.summary).not.toContain('@');
  });

  it('emits user_erased at the TAIL — after anonymise + session revoke', async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      users: {
        anonymiseErasedInTx: vi.fn(async () => {
          order.push('anonymise');
          return { erased: true };
        }),
      } as unknown as EraseUserDeps['users'],
      sessions: {
        deleteByUserIdInTx: vi.fn(async () => {
          order.push('revoke');
          return 1;
        }),
      } as unknown as EraseUserDeps['sessions'],
      audit: {
        appendInTx: vi.fn(async () => {
          order.push('audit');
        }),
      } as unknown as EraseUserDeps['audit'],
    });

    await eraseUser({ userId: USER_ID, ...META }, deps);

    expect(order).toEqual(['anonymise', 'revoke', 'audit']);
  });

  it('returns ok(erased:false) when the user row is already gone', async () => {
    const { deps, appendInTx } = makeDeps({
      users: {
        anonymiseErasedInTx: vi.fn(async () => ({ erased: false })),
      } as unknown as EraseUserDeps['users'],
    });

    const result = await eraseUser({ userId: 'missing-user-id', ...META }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A no-op anonymise is NOT an error — the row simply did not exist.
    expect(result.value.erased).toBe(false);
    // The audit + revoke still ran (idempotent / belt-and-suspenders).
    expect(appendInTx).toHaveBeenCalledOnce();
  });

  it('fault: anonymise throws → err(erase-user-failed); never throws out', async () => {
    const boom = new Error('neon connection reset mid-anonymise');
    const { deps, appendInTx, deleteByUserIdInTx } = makeDeps({
      users: {
        anonymiseErasedInTx: vi.fn(async () => {
          throw boom;
        }),
      } as unknown as EraseUserDeps['users'],
    });

    const result = await eraseUser({ userId: USER_ID, ...META }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('erase-user-failed');
    expect(result.error.cause).toBe(boom);
    // The tx never reached the revoke / audit tail.
    expect(deleteByUserIdInTx).not.toHaveBeenCalled();
    expect(appendInTx).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-erase-user-001' }),
      'erase_user.failed',
    );
  });

  it('fault: session revoke throws → err(erase-user-failed); audit never reached', async () => {
    const boom = new Error('delete sessions failed');
    const { deps, appendInTx } = makeDeps({
      sessions: {
        deleteByUserIdInTx: vi.fn(async () => {
          throw boom;
        }),
      } as unknown as EraseUserDeps['sessions'],
    });

    const result = await eraseUser({ userId: USER_ID, ...META }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('erase-user-failed');
    expect(result.error.cause).toBe(boom);
    expect(appendInTx).not.toHaveBeenCalled();
  });

  it('last-admin: anonymise trips the 23514 trigger → err(erase-user-last-admin) — distinct from the generic fault', async () => {
    // The `users_last_admin_protection` BEFORE-UPDATE trigger (migration 0003)
    // raises SQLSTATE 23514 if the anonymise UPDATE (status active->disabled)
    // would drop the active-admin count to zero. The erased member's contact is
    // linked to the LAST active admin login. `isLastAdminTriggerError` recognises
    // the `{ code: '23514', message: 'last-admin-protection…' }` shape (same fake
    // as db-errors.test.ts). The catch must surface this DISTINCTLY so on-call can
    // tell it apart from a transient Neon failure (the US2d reconciler loops on it
    // until an operator promotes another admin / transfers the contact link).
    const triggerError = {
      code: '23514',
      message: 'last-admin-protection: cannot disable the sole active admin',
    };
    const { deps, deleteByUserIdInTx, appendInTx } = makeDeps({
      users: {
        anonymiseErasedInTx: vi.fn(async () => {
          throw triggerError;
        }),
      } as unknown as EraseUserDeps['users'],
    });

    const result = await eraseUser({ userId: USER_ID, ...META }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // DISTINCT code — NOT the generic 'erase-user-failed'.
    expect(result.error.code).toBe('erase-user-last-admin');
    expect(result.error.cause).toBe(triggerError);
    // The tx never reached the revoke / audit tail (the anonymise threw first).
    expect(deleteByUserIdInTx).not.toHaveBeenCalled();
    expect(appendInTx).not.toHaveBeenCalled();
    // Logged distinctly so on-call separates it from a transient Neon failure —
    // userId only, NO PII.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, requestId: 'req-erase-user-001' }),
      'erase_user.last_admin_blocked',
    );
    // The generic-failure log line is NOT emitted for this distinct class.
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      'erase_user.failed',
    );
  });

  it('fault: a non-Error throw is stringified for the log (String(e) branch)', async () => {
    const { deps } = makeDeps({
      users: {
        anonymiseErasedInTx: vi.fn(async () => {
          throw 'raw pg fault string';
        }),
      } as unknown as EraseUserDeps['users'],
    });

    const result = await eraseUser({ userId: USER_ID, ...META }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('erase-user-failed');
    expect(result.error.cause).toBe('raw pg fault string');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'raw pg fault string' }),
      'erase_user.failed',
    );
  });
});
