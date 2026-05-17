/**
 * R3.2.3 / CG-3 — TxStageError cause-threading contract.
 *
 * Phase H8.1 extended `TxStageError` constructor to accept `ErrorOptions`
 * for `Error.cause` threading (ES2022 / Node 16.9+). This file pins:
 *   1. The constructor stores the underlying error name + message via
 *      `cause`, so SRE forensics see the raw exception class
 *      (PostgresError, AbortError, …) alongside the failureStage.
 *   2. The pino default `err` serialiser surfaces `cause.name` +
 *      `cause.message` — verified structurally (we don't run pino here;
 *      we assert the `.cause` shape is preserved).
 *   3. Constructing TxStageError without `cause` keeps `.cause` undefined
 *      (backwards-compat for callers that haven't been migrated yet).
 *   4. Non-Error causes are preserved as-is (the contract permits
 *      arbitrary cause values per ES2022 §27.5.6.1, but our caller
 *      convention wraps non-Errors at the call site).
 *
 * Round 3 R3.3 widens cause-threading to 8 more sites in
 * `process-attendee-in-tx.ts`; this test ensures the contract pin is
 * in place BEFORE that widening (TDD discipline).
 */
import { describe, expect, it } from 'vitest';
import { TxStageError } from '@/modules/events/application/use-cases/_helpers/process-attendee-in-tx';

describe('R3.2.3 — TxStageError.cause threading', () => {
  it('preserves Error cause name + message via ErrorOptions', () => {
    const root = new Error('connection terminated');
    root.name = 'PostgresError';

    const err = new TxStageError(
      'audit_emit',
      'audit emit failed (kind=db_error): connection terminated',
      { cause: root },
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TxStageError);
    expect(err.name).toBe('TxStageError');
    expect(err.stage).toBe('audit_emit');
    expect(err.message).toContain('audit emit failed');
    // ES2022 Error.cause — preserved verbatim.
    expect(err.cause).toBe(root);
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).name).toBe('PostgresError');
    expect((err.cause as Error).message).toBe('connection terminated');
  });

  it('cause discriminates DB error from abort error', () => {
    const dbErr = Object.assign(new Error('deadlock detected'), {
      name: 'PostgresError',
    });
    const abortErr = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });

    const dbWrapped = new TxStageError('quota_decrement', 'lock failed', {
      cause: dbErr,
    });
    const abortWrapped = new TxStageError(
      'quota_decrement',
      'lock failed',
      { cause: abortErr },
    );

    // The wrap MESSAGE is identical; the cause shape distinguishes.
    expect(dbWrapped.message).toBe(abortWrapped.message);
    expect((dbWrapped.cause as Error).name).toBe('PostgresError');
    expect((abortWrapped.cause as Error).name).toBe('AbortError');
  });

  it('omitting options keeps cause undefined (backwards-compat)', () => {
    const err = new TxStageError('event_upsert', 'upsert failed');
    expect(err.cause).toBeUndefined();
    expect(err.stage).toBe('event_upsert');
  });

  it('synthetic cause from Result.err discriminator is preserved', () => {
    // Pattern used by R3.3.1 for Result.err threading (no raw exception
    // in scope). The caller wraps the Result discriminator + message
    // in a synthetic Error to preserve forensic info downstream.
    const synthetic = new Error('AuditEmitError.db_error: connection lost');
    const err = new TxStageError('audit_emit', 'audit emit failed', {
      cause: synthetic,
    });

    expect(err.cause).toBe(synthetic);
    expect((err.cause as Error).message).toContain('AuditEmitError.db_error');
  });

  it('non-Error cause is permitted by spec; caller convention wraps at boundary', () => {
    // ES2022 §27.5.6.1: cause MAY be any value. Our caller-side
    // convention wraps non-Errors at the call site (so `cause` is
    // always an Error in practice), but the ctor doesn't reject
    // primitives — that's the spec contract.
    const err = new TxStageError('unknown', 'opaque failure', {
      cause: 'string-not-error',
    });
    expect(err.cause).toBe('string-not-error');
  });
});
