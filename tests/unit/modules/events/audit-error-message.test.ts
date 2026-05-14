/**
 * Phase 6 wave-6 round-12 — direct unit coverage for
 * `auditEmitErrorMessage` (R3-IMP-7).
 *
 * Previously the helper was exercised only transitively through
 * `emit-quota-scope-audit.test.ts`. The direct test:
 *
 *   1. Locks both arms of the exhaustive switch behaviourally — a
 *      future refactor that loosens the return type to `string |
 *      undefined` (e.g., accidentally removing the explicit `never`
 *      default) would still typecheck but fail here.
 *   2. Locks the canonical message format for `enum_value_unknown`
 *      (`audit enum unknown: <eventType>`) — the route handler /
 *      tx-rollback path serialises this to the wrapper exception
 *      message, so changing the format silently could break log-grep
 *      queries that match the literal prefix.
 *   3. Documents the contract independently from any specific caller.
 */
import { describe, expect, it } from 'vitest';
import { auditEmitErrorMessage } from '@/modules/events/application/use-cases/_helpers/audit-error-message';
import type { AuditEmitError } from '@/modules/events/application/ports/audit-port';

describe('auditEmitErrorMessage — R3-IMP-7 direct coverage', () => {
  it('returns the raw message for db_error (preserves pg-driver wording)', () => {
    const e: AuditEmitError = {
      kind: 'db_error',
      message: 'connection terminated unexpectedly',
    };
    expect(auditEmitErrorMessage(e)).toBe(
      'connection terminated unexpectedly',
    );
  });

  it('formats enum_value_unknown with the canonical "audit enum unknown: <eventType>" prefix', () => {
    const e: AuditEmitError = {
      kind: 'enum_value_unknown',
      eventType: 'quota_future_unknown',
    };
    expect(auditEmitErrorMessage(e)).toBe(
      'audit enum unknown: quota_future_unknown',
    );
  });

  it('preserves the literal prefix for log-grep stability', () => {
    // Logs / dashboards filter on `audit enum unknown:` as a literal
    // prefix. Re-asserted independently to catch tone-only changes.
    const result = auditEmitErrorMessage({
      kind: 'enum_value_unknown',
      eventType: 'x',
    });
    expect(result.startsWith('audit enum unknown:')).toBe(true);
  });

  it('handles an empty db_error message without crashing', () => {
    expect(
      auditEmitErrorMessage({ kind: 'db_error', message: '' }),
    ).toBe('');
  });
});
