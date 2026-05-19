/**
 * R5.2.3 / Round 4 I-3 — unit test for `formatErrorWithCause` helper.
 *
 * This helper is the shared source of truth used by:
 *   - `import-csv.ts` `toErrMessage` (15 call sites — audit payload
 *      `errorMessage` + log `err` field)
 *   - `ingest-webhook-attendee.ts:384` outer-catch (rolled-back audit
 *      `errorMessage`)
 *
 * Without these tests, a regression that drops the `e.cause instanceof
 * Error` branch silently collapses every wrapped failure to its outer
 * message, defeating the R3.3.1 9-site cause-threading work.
 */
import { describe, it, expect } from 'vitest';
import { formatErrorWithCause } from '@/modules/events/application/use-cases/_helpers/format-error-with-cause';

describe('R5.2.3 — formatErrorWithCause', () => {
  it('non-Error input → String(e) backward-compat', () => {
    expect(formatErrorWithCause('plain string')).toBe('plain string');
    expect(formatErrorWithCause(42)).toBe('42');
    expect(formatErrorWithCause(null)).toBe('null');
    expect(formatErrorWithCause(undefined)).toBe('undefined');
    expect(formatErrorWithCause({ kind: 'foo' })).toBe('[object Object]');
  });

  it('Error without cause → e.message only (no `(cause: …)` suffix)', () => {
    const err = new Error('plain failure');
    expect(formatErrorWithCause(err)).toBe('plain failure');
  });

  it('Error with Error-typed cause → `${e.message} (cause: ${cause.name}: ${cause.message})`', () => {
    const root = Object.assign(new Error('connection terminated'), {
      name: 'PostgresError',
    });
    const wrap = new Error('audit emit failed (kind=db_error): connection terminated', {
      cause: root,
    });
    expect(formatErrorWithCause(wrap)).toBe(
      'audit emit failed (kind=db_error): connection terminated (cause: PostgresError: connection terminated)',
    );
  });

  it('Error with string-typed cause → e.message only (string causes dropped by design)', () => {
    const wrap = new Error('wrap', { cause: 'string-cause' });
    expect(formatErrorWithCause(wrap)).toBe('wrap');
  });

  it('Error with object-but-not-Error cause → e.message only (only Error instances surface)', () => {
    const wrap = new Error('wrap', { cause: { kind: 'fake' } });
    expect(formatErrorWithCause(wrap)).toBe('wrap');
  });

  it('R5.8 — synthetic-cause with custom name surfaces both name AND message in the rendered string', () => {
    // R5.8 / Round 4 simplify-S1 — `makeSyntheticCause` sets
    // `cause.name = discriminator` so pino + formatErrorWithCause
    // render as `(cause: AuditEmitError: <detail>)` — SRE dashboards
    // can filter on the class name without grepping the message body.
    const synthetic = new Error('db_error: connection lost');
    synthetic.name = 'AuditEmitError';
    const wrap = new Error('audit emit failed', { cause: synthetic });
    expect(formatErrorWithCause(wrap)).toBe(
      'audit emit failed (cause: AuditEmitError: db_error: connection lost)',
    );
  });

  it('one-level cause unwrap: nested cause.cause is NOT recursed', () => {
    // Acceptable trade-off — preserves message size. The deepest
    // information is lost on the audit `errorMessage` field but pino's
    // default err serialiser walks the full chain.
    const root = new Error('deep root');
    const mid = new Error('mid wrap', { cause: root });
    const outer = new Error('outer wrap', { cause: mid });
    const formatted = formatErrorWithCause(outer);
    expect(formatted).toBe('outer wrap (cause: Error: mid wrap)');
    expect(formatted).not.toContain('deep root');
  });
});
