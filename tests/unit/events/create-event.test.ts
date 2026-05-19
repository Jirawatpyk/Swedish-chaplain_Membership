/**
 * R2 (Round 2 — pr-test-analyzer C5) — `createEvent` use-case unit tests.
 *
 * Constitution v1.4.0 Principle II requires ≥80% line + branch coverage
 * on Application use-cases, with 100% branch coverage on surfaces that
 * emit audit events. Until R2 the only test coverage was a mocked
 * contract test at the POST /api/admin/events boundary — the inner
 * validation, audit-emit, and idempotent re-run branches were
 * unexercised, so a regression that drops the validation guard or the
 * `eventCreated`-gated audit emit would have shipped silently.
 *
 * Branches covered:
 *   1. externalId regex rejects (3 sub-cases)
 *   2. name empty / >500 chars
 *   3. startDate not a Date / NaN-date
 *   4. category >100 chars
 *   5. eventsRepo.upsert returns err({kind:'db_error'})
 *   6. eventsRepo.upsert returns ok + eventCreated=true → audit emit fires
 *   7. eventsRepo.upsert returns ok + eventCreated=false → audit emit
 *      DOES NOT fire (idempotent re-run invariant)
 *   8. audit emit returns Result.err → use-case still returns 'created'
 *      (DB committed invariant; emit failure is observability concern)
 *   9. runInTenantTx itself throws → outcome 'unexpected_error'
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  createEvent,
  type CreateEventDeps,
  type CreateEventTxScopedPorts,
  asEventId,
} from '@/modules/events';
import { asUserId } from '@/modules/auth';
import { asTenantId } from '@/modules/members';
import { logger } from '@/lib/logger';

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
  },
}));

interface MakeDepsOpts {
  readonly upsertResult?: 'ok_created' | 'ok_existing' | 'db_error';
  readonly auditEmitOk?: boolean;
  readonly tenantTxThrows?: boolean;
}

const VALID_EVENT_ID = '11111111-2222-4333-8444-555555555555';

function makeDeps(opts: MakeDepsOpts = {}): {
  deps: CreateEventDeps;
  emitMock: ReturnType<typeof vi.fn>;
  upsertMock: ReturnType<typeof vi.fn>;
} {
  const upsertResult = opts.upsertResult ?? 'ok_created';
  const auditEmitOk = opts.auditEmitOk ?? true;

  const upsertMock = vi.fn(async (input: { startDate: Date; category: string | null }) => {
    if (upsertResult === 'db_error') {
      return err({ kind: 'db_error' as const, message: 'simulated upsert failure' });
    }
    return ok({
      event: {
        eventId: asEventId(VALID_EVENT_ID),
        externalId: 'agm-2026',
        name: 'Test Event',
        startDate: input.startDate,
        category: input.category,
      },
      eventCreated: upsertResult === 'ok_created',
    });
  });

  const emitMock = vi.fn(async () => {
    if (!auditEmitOk) {
      return err({ kind: 'db_error' as const, message: 'simulated audit emit failure' });
    }
    return ok('audit-id' as never);
  });

  const ports: CreateEventTxScopedPorts = {
    eventsRepo: { upsert: upsertMock } as unknown as CreateEventTxScopedPorts['eventsRepo'],
    audit: { emit: emitMock } as unknown as CreateEventTxScopedPorts['audit'],
  };

  const deps: CreateEventDeps = {
    runInTenantTx: vi.fn(async (_tenantId, fn) => {
      if (opts.tenantTxThrows === true) {
        throw new Error('simulated runInTenantTx failure');
      }
      return fn(ports);
    }),
    emitStandalone: vi.fn(async () => ok('audit-id' as never)),
  };

  return { deps, emitMock, upsertMock };
}

const BASE_INPUT = {
  tenantId: asTenantId('test-chamber'),
  actorUserId: asUserId('00000000-0000-0000-0000-000000000abc'),
  externalId: 'agm-2026',
  name: 'AGM 2026',
  startDate: new Date('2026-03-20T11:00:00.000Z'),
  category: 'AGM' as string | null,
};

describe('createEvent — validation branches', () => {
  it('rejects empty externalId', async () => {
    const { deps } = makeDeps();
    const outcome = await createEvent(
      { ...BASE_INPUT, externalId: '   ' },
      deps,
    );
    expect(outcome.kind).toBe('invalid_input');
    if (outcome.kind === 'invalid_input') expect(outcome.field).toBe('externalId');
  });

  it('rejects externalId with disallowed characters', async () => {
    const { deps } = makeDeps();
    const outcome = await createEvent(
      { ...BASE_INPUT, externalId: 'agm/2026' },
      deps,
    );
    expect(outcome.kind).toBe('invalid_input');
    if (outcome.kind === 'invalid_input') expect(outcome.field).toBe('externalId');
  });

  it('rejects externalId longer than 100 chars', async () => {
    const { deps } = makeDeps();
    const outcome = await createEvent(
      { ...BASE_INPUT, externalId: 'a'.repeat(101) },
      deps,
    );
    expect(outcome.kind).toBe('invalid_input');
    if (outcome.kind === 'invalid_input') expect(outcome.field).toBe('externalId');
  });

  it('rejects empty name', async () => {
    const { deps } = makeDeps();
    const outcome = await createEvent({ ...BASE_INPUT, name: '   ' }, deps);
    expect(outcome.kind).toBe('invalid_input');
    if (outcome.kind === 'invalid_input') expect(outcome.field).toBe('name');
  });

  it('rejects name longer than 500 chars', async () => {
    const { deps } = makeDeps();
    const outcome = await createEvent(
      { ...BASE_INPUT, name: 'x'.repeat(501) },
      deps,
    );
    expect(outcome.kind).toBe('invalid_input');
    if (outcome.kind === 'invalid_input') expect(outcome.field).toBe('name');
  });

  it('rejects NaN-date startDate', async () => {
    const { deps } = makeDeps();
    const outcome = await createEvent(
      { ...BASE_INPUT, startDate: new Date('invalid') },
      deps,
    );
    expect(outcome.kind).toBe('invalid_input');
    if (outcome.kind === 'invalid_input') expect(outcome.field).toBe('startDate');
  });

  it('rejects category longer than 100 chars', async () => {
    const { deps } = makeDeps();
    const outcome = await createEvent(
      { ...BASE_INPUT, category: 'c'.repeat(101) },
      deps,
    );
    expect(outcome.kind).toBe('invalid_input');
    if (outcome.kind === 'invalid_input') expect(outcome.field).toBe('category');
  });
});

describe('createEvent — happy path + idempotent re-run', () => {
  it('returns kind:"created" + emits event_created audit when eventCreated=true', async () => {
    vi.clearAllMocks();
    const { deps, emitMock } = makeDeps({ upsertResult: 'ok_created' });
    const outcome = await createEvent(BASE_INPUT, deps);
    expect(outcome.kind).toBe('created');
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'event_created',
        tenantId: 'test-chamber',
        actorType: 'admin',
      }),
    );
  });

  it('returns kind:"already_exists" + DOES NOT emit audit when eventCreated=false (idempotent re-run)', async () => {
    vi.clearAllMocks();
    const { deps, emitMock } = makeDeps({ upsertResult: 'ok_existing' });
    const outcome = await createEvent(BASE_INPUT, deps);
    expect(outcome.kind).toBe('already_exists');
    // Critical invariant: idempotent re-runs MUST NOT pollute the audit
    // trail. A regression dropping the `if (eventCreated)` gate would
    // emit a duplicate `event_created` row on every admin retry.
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('accepts category=null (optional field)', async () => {
    vi.clearAllMocks();
    const { deps, upsertMock } = makeDeps({ upsertResult: 'ok_created' });
    const outcome = await createEvent({ ...BASE_INPUT, category: null }, deps);
    expect(outcome.kind).toBe('created');
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ category: null }),
    );
  });
});

describe('createEvent — error paths', () => {
  it('returns kind:"db_error" when upsert returns Result.err', async () => {
    vi.clearAllMocks();
    const { deps } = makeDeps({ upsertResult: 'db_error' });
    const outcome = await createEvent(BASE_INPUT, deps);
    expect(outcome.kind).toBe('db_error');
    if (outcome.kind === 'db_error') {
      expect(outcome.message).toMatch(/simulated upsert failure/);
    }
  });

  it('still returns kind:"created" when audit emit returns Result.err (DB committed invariant)', async () => {
    vi.clearAllMocks();
    const { deps } = makeDeps({
      upsertResult: 'ok_created',
      auditEmitOk: false,
    });
    const outcome = await createEvent(BASE_INPUT, deps);
    // The event IS committed; audit-emit failure does NOT roll back.
    expect(outcome.kind).toBe('created');
    // logger.error fires so SRE has a signal.
    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const auditFailedLog = errorCalls.find(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as Record<string, unknown>)['event'] ===
          'f6_event_created_audit_emit_failed',
    );
    expect(auditFailedLog).toBeDefined();
  });

  it('returns kind:"unexpected_error" when runInTenantTx throws', async () => {
    vi.clearAllMocks();
    const { deps } = makeDeps({ tenantTxThrows: true });
    const outcome = await createEvent(BASE_INPUT, deps);
    expect(outcome.kind).toBe('unexpected_error');
    if (outcome.kind === 'unexpected_error') {
      expect(outcome.message).toMatch(/simulated runInTenantTx failure/);
    }
    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    const threwLog = errorCalls.find(
      (c) =>
        c[0] !== null &&
        typeof c[0] === 'object' &&
        (c[0] as Record<string, unknown>)['event'] ===
          'f6_create_event_threw',
    );
    expect(threwLog).toBeDefined();
  });
});
