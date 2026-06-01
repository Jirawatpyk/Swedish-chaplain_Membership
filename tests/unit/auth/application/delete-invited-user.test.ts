/**
 * Unit tests for `deleteInvitedUser` use case — SAGA compensation for the
 * F3 invite-portal orphan window (go-live /code-review #12-13).
 *
 * Security-critical destructive op (deletes a user row) → 100% branch coverage.
 * Branches under test:
 *   1. compensated — pending user deleted (1 row) → outbox row dropped + the
 *      `account_creation_compensated` audit appended → { compensated: true }.
 *   2. no-op race — 0 rows deleted (the user already redeemed/activated between
 *      createUser and this compensation) → NEVER touch outbox/audit →
 *      { compensated: false }.
 *   3. fault — an unexpected throw inside the tx is caught, logged, and mapped
 *      to err({ code: 'compensation-failed' }); the use case NEVER throws out.
 *   4. audit summary uses targetEmail when present, else falls back to userId.
 *
 * The `db.transaction` mock invokes the callback with a dummy tx and re-throws
 * (mirrors Drizzle: `return` commits, `throw` rolls back).
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
// Prevent defaultDeleteInvitedUserDeps from pulling Drizzle at test boot.
vi.mock('@/lib/auth-deps', () => ({ defaultDeleteInvitedUserDeps: {} }));

import { deleteInvitedUser } from '@/modules/auth/application/delete-invited-user';
import type { DeleteInvitedUserDeps } from '@/modules/auth/application/delete-invited-user';
import { asUserId } from '@/modules/auth/domain/branded';
import { logger } from '@/lib/logger';

const USER_ID = asUserId('11111111-1111-4111-8111-111111111111');

function makeDeps(overrides: Partial<DeleteInvitedUserDeps> = {}): {
  deps: DeleteInvitedUserDeps;
  deleteInvitedPendingInTx: ReturnType<typeof vi.fn>;
  deleteOutboxInTx: ReturnType<typeof vi.fn>;
  appendInTx: ReturnType<typeof vi.fn>;
} {
  const deleteInvitedPendingInTx = vi.fn(async () => ({ deleted: 1 }));
  const deleteOutboxInTx = vi.fn(async () => undefined);
  const appendInTx = vi.fn(async () => undefined);
  const deps: DeleteInvitedUserDeps = {
    users: { deleteInvitedPendingInTx } as unknown as DeleteInvitedUserDeps['users'],
    deleteOutboxInTx: deleteOutboxInTx as unknown as DeleteInvitedUserDeps['deleteOutboxInTx'],
    audit: { appendInTx } as unknown as DeleteInvitedUserDeps['audit'],
    ...overrides,
  };
  return { deps, deleteInvitedPendingInTx, deleteOutboxInTx, appendInTx };
}

const baseInput = {
  userId: USER_ID,
  outboxRowId: 'outbox-row-1',
  actorUserId: '22222222-2222-4222-8222-222222222222',
  sourceIp: '203.0.113.10',
  requestId: 'req-compensate-001',
  targetEmail: 'invitee@swecham.test',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deleteInvitedUser (SAGA compensation)', () => {
  it('compensated: deletes the pending user, drops the outbox row, appends the audit', async () => {
    const { deps, deleteInvitedPendingInTx, deleteOutboxInTx, appendInTx } = makeDeps();

    const result = await deleteInvitedUser(baseInput, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.compensated).toBe(true);
    expect(deleteInvitedPendingInTx).toHaveBeenCalledOnce();
    // Deleted by EXACT id (id-only guard — never by email).
    expect(deleteInvitedPendingInTx).toHaveBeenCalledWith(expect.anything(), USER_ID);
    expect(deleteOutboxInTx).toHaveBeenCalledWith(expect.anything(), 'outbox-row-1');
    expect(appendInTx).toHaveBeenCalledOnce();
    expect(appendInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'account_creation_compensated',
        targetUserId: USER_ID,
        requestId: 'req-compensate-001',
      }),
    );
  });

  it('audit summary includes the target email when supplied', async () => {
    const { deps, appendInTx } = makeDeps();
    await deleteInvitedUser(baseInput, deps);
    expect(appendInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        summary: expect.stringContaining('invitee@swecham.test'),
      }),
    );
  });

  it('audit summary falls back to the userId when no targetEmail is given', async () => {
    const { deps, appendInTx } = makeDeps();
    const { targetEmail: _omit, ...noEmail } = baseInput;
    await deleteInvitedUser(noEmail, deps);
    expect(appendInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ summary: expect.stringContaining(USER_ID) }),
    );
  });

  it('no-op race: 0 rows deleted (already redeemed) → compensated:false, no outbox/audit', async () => {
    const { deps, deleteOutboxInTx, appendInTx } = makeDeps({
      users: {
        deleteInvitedPendingInTx: vi.fn(async () => ({ deleted: 0 })),
      } as unknown as DeleteInvitedUserDeps['users'],
    });

    const result = await deleteInvitedUser(baseInput, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.compensated).toBe(false);
    // A live/redeemed account is NEVER followed by an outbox delete or audit.
    expect(deleteOutboxInTx).not.toHaveBeenCalled();
    expect(appendInTx).not.toHaveBeenCalled();
  });

  it('fault: an unexpected throw inside the tx → err(compensation-failed); never throws out', async () => {
    const boom = new Error('neon connection reset mid-delete');
    const { deps } = makeDeps({
      users: {
        deleteInvitedPendingInTx: vi.fn(async () => {
          throw boom;
        }),
      } as unknown as DeleteInvitedUserDeps['users'],
    });

    const result = await deleteInvitedUser(baseInput, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('compensation-failed');
    expect(result.error.cause).toBe(boom);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-compensate-001' }),
      'delete_invited_user.compensation_failed',
    );
  });

  it('fault: a non-Error throw is stringified for the log (String(e) branch)', async () => {
    const { deps } = makeDeps({
      users: {
        deleteInvitedPendingInTx: vi.fn(async () => {
          // A thrown non-Error value (e.g. a Postgres driver rejection string).
          throw 'raw pg fault string';
        }),
      } as unknown as DeleteInvitedUserDeps['users'],
    });

    const result = await deleteInvitedUser(baseInput, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('compensation-failed');
    expect(result.error.cause).toBe('raw pg fault string');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errMessage: 'raw pg fault string' }),
      'delete_invited_user.compensation_failed',
    );
  });
});
