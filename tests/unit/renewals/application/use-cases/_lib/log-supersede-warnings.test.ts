/**
 * 106-void-on-reissue follow-up — `logSupersedeWarnings` is called AFTER a
 * §86/4 was minted and BEFORE the cycle link. It must never throw: a throw
 * there would fail the use case and leave the issued bill unlinked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import { logSupersedeWarnings } from '@/modules/renewals/application/use-cases/_lib/log-supersede-warnings';

const CONTEXT = {
  errorId: 'F8.ADMIN_RENEW.SUPERSEDE_VOID_FAILED',
  tenantId: 'tenantA',
  memberId: 'mem-1',
  invoiceId: 'inv-new',
  correlationId: 'corr-1',
} as const;

afterEach(() => vi.restoreAllMocks());

describe('logSupersedeWarnings', () => {
  it('logs one line per warning with the old bill id + number and the void error code', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    logSupersedeWarnings(
      [
        {
          kind: 'void_failed',
          invoiceId: 'inv-old-1',
          billDocumentNumber: 'SC-2026-000123',
          errorCode: 'concurrent_state_change',
        },
        { kind: 'list_failed' },
      ],
      CONTEXT,
    );

    expect(warnSpy.mock.calls.map(([obj]) => obj)).toEqual([
      {
        ...CONTEXT,
        kind: 'void_failed',
        supersededInvoiceId: 'inv-old-1',
        supersededBillNumber: 'SC-2026-000123',
        voidErrorCode: 'concurrent_state_change',
      },
      { ...CONTEXT, kind: 'list_failed' },
    ]);
  });

  it('never throws, even when the logger does (a minted bill must still get linked)', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {
      throw new Error('log sink down');
    });

    expect(() =>
      logSupersedeWarnings(
        [{ kind: 'void_threw', invoiceId: 'inv-old-1', billDocumentNumber: 'SC-2026-000123' }],
        CONTEXT,
      ),
    ).not.toThrow();
  });
});
