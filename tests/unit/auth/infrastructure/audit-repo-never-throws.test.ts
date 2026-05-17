/**
 * A1 — audit-repo never-throws contract.
 *
 * `auditRepo.append` and `auditRepo.appendInTx` advertise a
 * "NEVER throws across the boundary" contract in their JSDoc. This
 * test pins the behaviour: a DB error (transient Neon outage,
 * statement timeout, enum drift between Domain and Postgres
 * `audit_event_type`, etc.) MUST be caught, logged, metric-emitted,
 * and swallowed.
 *
 * Why this matters — without the catch:
 *   - Use cases (sign-in, change-password, change-role, disable-user)
 *     call `await deps.audit.append(...)` AFTER the mutation has
 *     already committed. A throw here propagates out as a generic 500
 *     even though the side-effect persisted.
 *   - The audit row is diagnostic; the mutation IS the source of truth.
 *   - Constitution Principle VIII authorises this trade-off explicitly.
 *
 * Strategy:
 *   - Mock the Drizzle `db` so `db.insert(...).values(...)` rejects.
 *   - Assert append/appendInTx resolve (no throw) + logger.error called
 *     + authMetrics.auditMissing called with the event type.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock @/lib/db BEFORE importing the repo so the singleton picks up
// the mock chain.
const insertThrows = vi.fn(() => ({
  values: vi.fn().mockRejectedValue(new Error('neon: connection terminated')),
}));

vi.mock('@/lib/db', () => ({
  db: { insert: insertThrows },
}));

// Mock logger so we can spy on .error invocations.
const errorSpy = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: errorSpy, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Mock authMetrics so we can spy on auditMissing.
const auditMissingSpy = vi.fn();
vi.mock('@/lib/metrics', () => ({
  authMetrics: { auditMissing: auditMissingSpy },
}));

// Now import the repo — module graph binds the mocks above.
const { auditRepo } = await import(
  '@/modules/auth/infrastructure/db/audit-repo'
);

const sampleEvent = {
  eventType: 'sign_in_success' as const,
  actorUserId: '01HV1234567890ABCDEFGHIJK' as never,
  targetUserId: null,
  sourceIp: '203.0.113.1',
  summary: 'tester signed in',
  requestId: '01HV99999999999999999999',
};

describe('audit-repo never-throws contract (A1)', () => {
  beforeEach(() => {
    insertThrows.mockClear();
    errorSpy.mockClear();
    auditMissingSpy.mockClear();
  });

  it('append() resolves even when db.insert rejects', async () => {
    await expect(auditRepo.append(sampleEvent)).resolves.toBeUndefined();
  });

  it('append() logs at error level with err + eventType + requestId on failure', async () => {
    await auditRepo.append(sampleEvent);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [bindings, msg] = errorSpy.mock.calls[0]!;
    expect(bindings).toMatchObject({
      eventType: 'sign_in_success',
      requestId: '01HV99999999999999999999',
    });
    expect(bindings.err).toBeInstanceOf(Error);
    expect(msg).toBe('audit.append.failed');
  });

  it('append() emits authMetrics.auditMissing labelled by event type', async () => {
    await auditRepo.append(sampleEvent);
    expect(auditMissingSpy).toHaveBeenCalledTimes(1);
    expect(auditMissingSpy).toHaveBeenCalledWith('sign_in_success');
  });

  it('appendInTx() resolves even when tx.insert rejects', async () => {
    const fakeTx = {
      insert: vi.fn(() => ({
        values: vi
          .fn()
          .mockRejectedValue(new Error('neon: statement timeout')),
      })),
    } as never;
    await expect(
      auditRepo.appendInTx(fakeTx, sampleEvent),
    ).resolves.toBeUndefined();
  });

  it('appendInTx() logs + emits metric on failure (distinct msg slug)', async () => {
    const fakeTx = {
      insert: vi.fn(() => ({
        values: vi
          .fn()
          .mockRejectedValue(new Error('neon: deadlock detected')),
      })),
    } as never;
    await auditRepo.appendInTx(fakeTx, sampleEvent);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![1]).toBe('audit.appendInTx.failed');
    expect(auditMissingSpy).toHaveBeenCalledWith('sign_in_success');
  });
});
