/**
 * #739 B3b — the F6 catch helpers put the thrown value's CLASS in the Result,
 * never its text (a driver message quotes bound parameters).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { safeAuditEmit } from '@/modules/events/application/use-cases/_helpers/safe-audit-emit';
import { wrapRepoError } from '@/modules/events/infrastructure/sanitize-db-error';
import type { F6AuditPort } from '@/modules/events/application/ports/audit-port';

const driverError = () => new Error('duplicate key value violates unique constraint — params: [a@b.example]');

describe('F6 caught-error helpers', () => {
  it('safeAuditEmit: a raw throw becomes db_error with the step and class only', async () => {
    const audit = { emit: vi.fn().mockRejectedValue(driverError()) } as unknown as F6AuditPort;
    const r = await safeAuditEmit(audit, {} as Parameters<typeof safeAuditEmit>[1]);
    expect(r).toEqual({ ok: false, error: { kind: 'db_error', message: 'audit_emit: Error' } });
    if (!r.ok) expect(JSON.stringify(r.error)).not.toContain('@');
  });

  it('wrapRepoError: db_error carries the class only', () => {
    const e = wrapRepoError('registrations', driverError());
    expect(e).toEqual({ kind: 'db_error', message: 'Error' });
    expect(JSON.stringify(e)).not.toContain('@');
  });
});
